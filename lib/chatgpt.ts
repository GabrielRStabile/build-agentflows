/** Official Codex App Server protocol, pinned to @openai/codex 0.155.1.
 * Auth and turns use a private stdio child, never a browser token or unofficial endpoint.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { transcript } from "./conversation-turns";
import { tenantId, currentTenant } from "./tenant-context";
import { AuthError } from "./saas-security";
import { ChatSessionLease, readChatSession, revokeChatSession } from "./chatgpt-session";
import { currentJobLease } from "./saas-job-context";
import { runBudgetMs } from "./run-limits";

import { tokenUsage, type TokenUsage } from "./token-usage";
import { normalizeUsage } from "./account-usage";
import type { ModelCapability } from "./model-capabilities";

/** Every concurrent run in the worker holds one bridge; the cap must never be below EXECUCOES_SIMULTANEAS. */
export function maxBridges() {
  const running = Number(process.env.EXECUCOES_SIMULTANEAS);
  return Math.max(4, Number.isInteger(running) && running > 0 ? running : 6);
}
/** Web requests hold the session for about a second (usage, models); a worker run waits for them instead of failing. */
const LEASE_RETRY = { request: { attempts: 20, delayMs: 100 }, job: { attempts: 150, delayMs: 100 } };
export const CHATGPT_TIMEOUT_MESSAGE = "O ChatGPT não respondeu dentro do tempo limite da etapa. Simplifique a tarefa ou tente novamente.";
/** Provider failures reach the trace in plain language, keeping the original detail for support. */
export function turnErrorMessage(raw: string | undefined) {
  const detail = (raw || "").trim();
  if (!detail) return "O ChatGPT não concluiu a resposta. Tente novamente.";
  const hint = /context[ _-]?length|too long|maximum.*tokens/i.test(detail)
    ? "A tarefa ficou grande demais para o modelo. Reduza a mensagem, a memória ou os anexos."
    : /usage[ _-]?limit|rate[ _-]?limit|too many requests|\b429\b|quota|exceeded/i.test(detail)
      ? "Sua assinatura ChatGPT atingiu o limite de uso. Aguarde a janela liberar ou escolha outro modelo ou provedor no bloco."
      : /unauthori[sz]ed|\b401\b|invalid[ _-]?(token|grant)|refresh[ _-]?token|not logged in|login/i.test(detail)
        ? "A sessão ChatGPT expirou ou foi revogada. Reconecte o ChatGPT em Configurações."
        : /ECONN|ENOTFOUND|EAI_AGAIN|network|socket|timed? ?out|timeout|unavailable|\b50[234]\b|overloaded/i.test(detail)
          ? "Não foi possível alcançar o ChatGPT agora. Tente novamente em instantes."
          : null;
  return hint ? `${hint} Detalhe: ${detail.slice(0, 200)}` : detail;
}

type Json = Record<string, unknown>;
type Message = {
  id?: number | string;
  method?: string;
  params?: Json;
  result?: unknown;
  error?: { message: string };
};
export type ChatAccount = {
  type: string;
  email?: string;
  planType?: string;
} | null;
export type DeviceLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};
export type AgentTool = {
  name: string;
  description: string;
  schema: unknown;
  call: (args: unknown) => Promise<string>;
};
type ActiveTurn = {
  resolve: (text: string) => void;
  reject: (e: Error) => void;
  text: string;
  turnId?: string;
  tools: AgentTool[];
  calls: number;
  onText?: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  timer: ReturnType<typeof setTimeout>;
};

type NativeLaunch = (options: { env: NodeJS.ProcessEnv; cwd: string; detached: boolean }) => ChildProcessWithoutNullStreams;
const operations = new AsyncLocalStorage<ChatGPTBridge>();

export class ChatGPTBridge {
  private readonly owner = tenantId();
  private launcher?: NativeLaunch;
  constructor(launcher?: NativeLaunch) {
    this.launcher = launcher;
  }
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private turns = new Map<string, ActiveTurn>();
  private login: DeviceLogin | null = null;
  private loginError: string | null = null;
  private workspace = "";
  private lease: ChatSessionLease | null = null;
  private active = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private syncing: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private loginCompletion: Promise<void> | null = null;

  private assertOwner() {
    if (currentTenant().user.id !== this.owner) throw new AuthError("Esta conexão ChatGPT pertence a outra conta.", 403);
  }
  private async use<T>(action: () => Promise<T>): Promise<T> {
    this.assertOwner();
    if (operations.getStore() === this) return action();
    if (this.closing) await this.closing;
    if (this.active) throw new AuthError("Sua conexão ChatGPT está em uso. Aguarde e tente novamente.", 409);
    this.active = true;
    return operations.run(this, async () => {
      try { await this.start(); await this.sync(); return await action(); }
      finally {
        try { await this.loginCompletion; }
        finally { this.active = false; if (!this.login) await this.shutdown(); }
      }
    });
  }
  private sync() {
    if (!this.lease) return Promise.resolve();
    return this.syncing ??= this.lease.sync().finally(() => { this.syncing = null; });
  }
  private async tick() {
    if (!this.lease || this.closing) return;
    try {
      if (this.login && (this.lease.state.loginUntil || 0) <= Date.now()) {
        await this.nativeCancelLogin();
        this.loginError = "O código expirou. Gere um novo código.";
        if (!this.active) await this.shutdown();
      } else await this.sync();
    } catch { await this.shutdown(false).catch(() => {}); }
  }
  private shutdown(persist = true): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      clearInterval(this.heartbeat); this.heartbeat = undefined;
      const child = this.child;
      this.child = null;
      this.failed(new Error("Conexão ChatGPT encerrada."));
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          // The npm launcher has a native child. Kill its entire private group,
          // including the forced-stop fallback, before deleting the auth cache.
          const terminate = (signal: NodeJS.Signals) => {
            try { if (process.platform !== "win32") process.kill(-child.pid!, signal); else child.kill(signal); }
            catch { child.kill(signal); }
          };
          const timer = setTimeout(() => terminate("SIGKILL"), 2000); timer.unref();
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          terminate("SIGTERM");
        });
      }
      const lease = this.lease; this.lease = null;
      try { await this.syncing; if (persist && lease) await lease.sync(true); }
      finally { if (lease) await lease.dispose(); }
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
  async account() {
    this.assertOwner();
    if (operations.getStore() !== this) {
      const { state, busy } = await readChatSession();
      return { account: state.auth ? state.account : null, login: busy ? state.login : null, error: this.loginError };
    }
    return this.use(() => this.nativeAccount());
  }
  async models() {
    this.assertOwner();
    if (operations.getStore() !== this) {
      const { state, busy } = await readChatSession();
      if (busy || (state.modelsAt || 0) > Date.now() - 15 * 60_000) return state.models;
    }
    return this.use(() => this.nativeModels());
  }
  async usage() { return this.use(() => this.nativeUsage()); }
  async beginLogin() {
    this.assertOwner();
    const { state, busy } = await readChatSession();
    if (busy && state.login) return state.login;
    return this.use(() => this.nativeBeginLogin());
  }
  async cancelLogin() {
    this.assertOwner();
    // Revoking the lease also cancels a login hosted by another web process.
    await revokeChatSession(false);
    this.login = null;
    await this.shutdown(false);
  }
  async logout() { this.assertOwner(); await revokeChatSession(); this.login = null; await this.shutdown(false); this.loginError = null; }
  async run(options: Parameters<ChatGPTBridge["nativeRun"]>[0]) { return this.use(() => this.nativeRun(options)); }

  private async start() {
    if (tenantId() !== this.owner) throw new Error("Esta conexão ChatGPT pertence a outra conta.");
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // Metadata requests can briefly hold the lease just as a worker starts.
      // Retry only acquisition, before any native/provider action is dispatched.
      const retry = currentJobLease() ? LEASE_RETRY.job : LEASE_RETRY.request;
      for (let attempt = 0; ; attempt++) {
        try { this.lease = await ChatSessionLease.acquire(); break; }
        catch (error) {
          if (!(error instanceof AuthError) || error.status !== 409 || attempt >= retry.attempts - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, retry.delayMs));
        }
      }
      const codexHome = this.lease.directory;
      this.workspace = this.lease.workspace;
      this.heartbeat = setInterval(() => { void this.tick(); }, 5000);
      this.heartbeat.unref();
      // Allowlist environment: never inherit app credentials, user's Codex auth or other providers.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: codexHome,
        CODEX_HOME: codexHome,
        LANG: "en_US.UTF-8",
        TERM: "dumb",
        NODE_ENV: "production",
      };
      const require = createRequire(join(process.cwd(), "package.json"));
      const cli = require.resolve("@openai/codex/bin/codex.js");
      const child = this.launcher
        ? this.launcher({ env, cwd: this.workspace, detached: process.platform !== "win32" })
        : spawn(
            process.execPath,
            [
              cli,
              "app-server",
              "--listen",
              "stdio://",
              "-c",
              'cli_auth_credentials_store="file"',
              "-c",
              "features.shell_tool=false",
              "-c",
              "features.unified_exec=false",
              "-c",
              "features.code_mode=false",
              "-c",
              // O host também despacha ferramentas dinâmicas, mesmo sem code mode.
              "features.code_mode_host=true",
              "-c",
              "features.multi_agent=false",
              "-c",
              'web_search="disabled"',
            ],
            { cwd: this.workspace, env, stdio: "pipe", detached: process.platform !== "win32" },
          );
      this.child = child;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          void this.receive(JSON.parse(line) as Message).catch(() => {
            // A child may close while an in-flight tool is returning.
          });
        } catch {
          /* non-protocol output is ignored, never sent to the browser */
        }
      });
      child.stderr.on("data", () => {});
      child.once("error", () => {
        if (this.child === child)
          this.failed(
            new Error(
              "Não foi possível iniciar a conexão ChatGPT no servidor.",
            ),
          );
      });
      child.once("exit", () => {
        if (this.child === child) {
          this.failed(new Error("A conexão ChatGPT foi interrompida. Tente novamente."));
          if (!this.active) void this.shutdown(false).catch(() => {});
        }
      });
      await this.rpc("initialize", {
        clientInfo: {
          name: "build_agentflows",
          title: "Build Agentflows",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: true },
      });
      this.send({ method: "initialized" });
    })();
    await this.ready;
  }
  private send(value: unknown) {
    if (!this.child?.stdin.writable)
      throw new Error("A conexão ChatGPT não está disponível.");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  private rpc<T = unknown>(method: string, params: Json = {}): Promise<T> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("O ChatGPT demorou para responder. Tente novamente."));
      }, 30000);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  private failed(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const t of this.turns.values()) {
      clearTimeout(t.timer);
      t.reject(error);
    }
    this.turns.clear();
    this.child = null;
    this.ready = null;
    this.login = null;
  }
  private async receive(m: Message) {
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(Number(m.id));
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(Number(m.id));
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
      return;
    }
    const p = m.params || {};
    const threadId = String(p.threadId || "");
    const turn = this.turns.get(threadId);
    if (m.id !== undefined && m.method) {
      if (m.method === "item/tool/call" && turn) {
        const tool = turn.tools.find((t) => t.name === p.tool);
        try {
          if (!tool || ++turn.calls > 12)
            throw new Error(
              "Ferramenta não autorizada ou limite de chamadas atingido.",
            );
          const text = await tool.call(p.arguments);
          this.send({
            id: m.id,
            result: {
              contentItems: [{ type: "inputText", text }],
              success: true,
            },
          });
        } catch (e) {
          this.send({
            id: m.id,
            result: {
              contentItems: [
                {
                  type: "inputText",
                  text: e instanceof Error ? e.message : "A ferramenta falhou.",
                },
              ],
              success: false,
            },
          });
        }
        return;
      }
      // No filesystem, shell, external approval or browser interaction from an agent block.
      this.send({
        id: m.id,
        error: {
          code: -32601,
          message: "Esta operação não está habilitada no Build Agentflows.",
        },
      });
      return;
    }
    if (m.method === "account/login/completed") {
      this.loginCompletion = (async () => {
        if (p.success) { await this.nativeAccount(); await this.nativeModels(); }
        this.login = null;
        this.loginError = p.success ? null : "Não foi possível entrar. Gere um novo código.";
        if (this.lease) { this.lease.state.login = null; delete this.lease.state.loginUntil; }
        await this.sync();
      })();
      try { await this.loginCompletion; }
      catch { this.login = null; this.loginError = "Não foi possível guardar a conexão ChatGPT. Conecte novamente."; }
      finally { this.loginCompletion = null; if (!this.active) await this.shutdown(); }
    }
    if (m.method === "thread/tokenUsage/updated" && turn) {
      const usage = tokenUsage((p.tokenUsage as Json)?.total, "chatgpt");
      if (usage) turn.onUsage?.(usage);
    }
    if (m.method === "item/agentMessage/delta" && turn) {
      turn.text += String(p.delta || "");
      turn.onText?.(turn.text);
    }
    if (m.method === "item/completed" && turn) {
      const item = p.item as Json;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        turn.text = item.text;
        turn.onText?.(turn.text);
      }
    }
    if (m.method === "turn/started" && turn)
      turn.turnId = String((p.turn as Json)?.id || "");
    if (m.method === "turn/completed" && turn) {
      clearTimeout(turn.timer);
      this.turns.delete(threadId);
      const result = p.turn as Json;
      if (result?.status === "completed" && turn.text.trim())
        turn.resolve(turn.text);
      else
        turn.reject(new Error(turnErrorMessage((result?.error as Json)?.message as string | undefined)));
    }
  }
  private async nativeAccount(): Promise<{
    account: ChatAccount;
    login: DeviceLogin | null;
    error: string | null;
  }> {
    const r = await this.rpc<{ account: ChatAccount }>("account/read", {
      refreshToken: false,
    });
    if (this.lease) this.lease.state.account = r.account?.type === "chatgpt" ? r.account : null;
    return {
      account: r.account?.type === "chatgpt" ? r.account : null,
      login: this.login,
      error: this.loginError,
    };
  }
  private async nativeUsage() {
    if (!(await this.account()).account) throw new Error("Conecte sua conta ChatGPT para consultar os limites.");
    return normalizeUsage(await this.rpc("account/rateLimits/read"));
  }
  private async nativeBeginLogin(): Promise<DeviceLogin> {
    if (this.turns.size)
      throw new Error("Aguarde os agentes terminarem antes de trocar a conta.");
    if (this.login) return this.login;
    this.loginError = null;
    const r = await this.rpc<DeviceLogin>("account/login/start", {
      type: "chatgptDeviceCode",
    });
    const u = new URL(r.verificationUrl);
    if (u.protocol !== "https:" || u.hostname !== "auth.openai.com")
      throw new Error(
        "O ChatGPT devolveu um endereço de autenticação inesperado.",
      );
    this.login = r;
    if (this.lease) { this.lease.state.login = r; this.lease.state.loginUntil = Date.now() + 10 * 60_000; }
    await this.sync();
    return r;
  }
  private async nativeCancelLogin() {
    if (this.login)
      await this.rpc("account/login/cancel", { loginId: this.login.loginId });
    this.login = null;
    if (this.lease) { this.lease.state.login = null; delete this.lease.state.loginUntil; }
  }
  private async nativeModels(): Promise<ModelCapability[]> {
    const r = await this.rpc<{
      data: { id: string; model: string; displayName: string; inputModalities?: string[]; isDefault?: boolean }[];
    }>("model/list", { limit: 100, includeHidden: false });
    const models = r.data.map((m) => ({
      id: m.model || m.id,
      name: m.displayName || m.model,
      inputModalities: m.inputModalities || ["text", "image"],
      isDefault: m.isDefault ?? r.data.length === 1,
    }));
    if (this.lease) { this.lease.state.models = models; this.lease.state.modelsAt = Date.now(); }
    return models;
  }
  private async nativeRun({
    system,
    prompt,
    model,
    tools = [],
    images = [],
    history = [],
    signal,
    onText,
    onUsage,
    timeoutMs = runBudgetMs(),
    webSearch = false,
  }: {
    system: string;
    prompt: string;
    model?: string;
    tools?: AgentTool[];
    images?: string[];
    /** Turnos anteriores (pessoa e assistente). O App Server só recebe texto da pessoa: a troca é simulada em texto. */
    history?: { role: "user" | "assistant"; content: string }[];
    signal?: AbortSignal;
    onText?: (text: string) => void;
    onUsage?: (usage: TokenUsage) => void;
    timeoutMs?: number;
    webSearch?: boolean;
  }): Promise<string> {
    // The child lives longer than a request. Bind callbacks to this turn's context,
    // not to the request that originally started its stdout event listener.
    tools = tools.map((tool) => ({ ...tool, call: AsyncLocalStorage.bind(tool.call) }));
    if (onText) onText = AsyncLocalStorage.bind(onText);
    if (onUsage) onUsage = AsyncLocalStorage.bind(onUsage);
    if (!(await this.account()).account)
      throw new Error("Conecte sua conta ChatGPT para executar este agente.");
    if (signal?.aborted) throw new Error("Execução cancelada.");
    if (images.length) {
      const models = await this.models();
      const selected = model ? models.find((m) => m.id === model) : models.find((m) => m.isDefault);
      if (!selected?.inputModalities.includes("image")) throw new Error("Este modelo não tem suporte confirmado a imagens. Escolha um modelo com imagens no bloco.");
      model = selected.id;
    }
    const r = await this.rpc<{ thread: { id: string } }>("thread/start", {
      ...(model ? { model } : {}),
      cwd: this.workspace,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      environments: [],
      baseInstructions:
        "Você executa uma etapa de um fluxo de agentes. Responda em português. Use somente as ferramentas explicitamente fornecidas. Não use terminal, arquivos, navegador ou outras capacidades do sistema.",
      developerInstructions: system,
      dynamicTools: tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        inputSchema: t.schema,
      })),
      config: {
        "features.shell_tool": false,
        "features.unified_exec": false,
        "features.code_mode": false,
        "features.code_mode_host": true,
        "features.multi_agent": false,
        web_search: webSearch ? "live" : "disabled",
      },
    });
    const id = r.thread.id;
    return new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, text?: string) => {
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve(text!);
      };
      // A turn that outlives its budget is interrupted with a message that says so;
      // a plain abort (cancel, shutdown, step deadline) keeps the cancellation text.
      const abort = (reason = "Execução cancelada.") => {
        const t = this.turns.get(id);
        if (t) {
          if (t.turnId)
            void this.rpc("turn/interrupt", {
              threadId: id,
              turnId: t.turnId,
            }).catch(() => {});
          clearTimeout(t.timer);
          this.turns.delete(id);
          finish(new Error(reason));
        }
      };
      const timer = setTimeout(() => {
        abort(CHATGPT_TIMEOUT_MESSAGE);
      }, Math.max(1, Math.min(timeoutMs, 3600000)));
      this.turns.set(id, {
        resolve: (text) => finish(undefined, text),
        reject: (error) => finish(error),
        text: "",
        tools,
        calls: 0,
        onText,
        onUsage,
        timer,
      });
      const cancel = () => abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      void this.rpc<{ turn: { id: string } }>("turn/start", {
        threadId: id,
        input: [{ type: "text", text: transcript(history, prompt) }, ...images.map((url) => ({ type: "image", url }))],
        environments: [],
      })
        .then((result) => {
          const t = this.turns.get(id);
          if (t) t.turnId = result.turn.id;
          else
            void this.rpc("turn/interrupt", {
              threadId: id,
              turnId: result.turn.id,
            }).catch(() => {});
        })
        .catch((e) => {
          const t = this.turns.get(id);
          if (t) {
            clearTimeout(t.timer);
            this.turns.delete(id);
            finish(e);
          }
        });
    });
  }
  close() { return this.shutdown().catch(() => {}); }
  get busy() { return this.active || !!this.closing || this.turns.size > 0 || this.pending.size > 0 || !!this.login; }
}
const globalChat = globalThis as typeof globalThis & {
  agentflowsChatGPTTenants?: Map<string, { bridge: ChatGPTBridge; touched: number }>;
};
export function chatGPT(): ChatGPTBridge {
  const owner = tenantId();
  const clients = globalChat.agentflowsChatGPTTenants ??= new Map();
  for (const [key, entry] of clients) {
    if (!entry.bridge.busy && Date.now() - entry.touched > 15 * 60_000) {
      entry.bridge.close(); clients.delete(key);
    }
  }
  let entry = clients.get(owner);
  if (!entry) {
    if (clients.size >= maxBridges()) {
      const idle = [...clients].filter(([, value]) => !value.bridge.busy).sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!idle) throw new Error("Todas as conexões ChatGPT deste servidor estão ocupadas. Aguarde alguns segundos e tente novamente.");
      idle[1].bridge.close(); clients.delete(idle[0]);
    }
    entry = { bridge: new ChatGPTBridge(), touched: Date.now() };
    clients.set(owner, entry);
  }
  entry.touched = Date.now();
  return entry.bridge;
}
