import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTenantTestContext } from "../scripts/tenant-test-context";
import { ChatGPTBridge, CHATGPT_TIMEOUT_MESSAGE, maxBridges, turnErrorMessage } from "./chatgpt";
const dir = mkdtempSync(join(tmpdir(), "chatgpt-protocol-"));
process.env.DATA_DIR = dir;
let tenant: Awaited<ReturnType<typeof createTenantTestContext>>;
let bridge: ChatGPTBridge;
test.before(async () => {
  tenant = await createTenantTestContext();
  bridge = await tenant.asTenant(() => new ChatGPTBridge(options => spawn(process.execPath, [join(process.cwd(), "scripts/fixtures/codex-protocol.mjs")], { ...options, stdio: "pipe" })));
});
test.after(async () => {
  await bridge.close();
  await tenant.close();
  rmSync(dir, { recursive: true, force: true });
});
function scenario(name: string, fn: () => Promise<void>) { test(name, () => tenant.asTenant(fn)); }
async function connected() {
  for (let i = 0; i < 100; i++) { const status = await bridge.account(); if (status.account && !status.login) return status; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Login did not finish");
}
scenario("login por dispositivo, modelos e logout pelo protocolo oficial", async () => {
  assert.equal((await bridge.account()).account, null);
  const login = await bridge.beginLogin();
  assert.equal(login.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(login.userCode, "TEST-1234");
  assert.equal((await connected()).account?.type, "chatgpt");
  assert.equal((await bridge.models())[0].id, "test-model");
  const usage = await bridge.usage();
  assert.equal(usage.buckets[0].primary?.usedPercent, 25);
  assert.equal(usage.buckets[0].secondary?.windowDurationMins, 10080);
  await bridge.logout();
  await assert.rejects(() => bridge.usage(), /Conecte sua conta/);
  assert.equal((await bridge.account()).account, null);
});
scenario("resposta incremental e política sem ambiente ou shell", async () => {
  await bridge.beginLogin();
  await connected();
  const partial: string[] = [];
  const result = await bridge.run({
    system: "Seja conciso",
    prompt: "Olá",
    onText: (t) => partial.push(t),
  });
  assert.equal(result, "Olá mundo");
  assert.deepEqual(partial, ["Olá ", "Olá mundo"]);
});
scenario("ferramenta dinâmica recebe argumentos e devolve resultado", async () => {
  let called = false;
  const text = await bridge.run({
    system: "Use a ferramenta",
    prompt: "buscar",
    tools: [
      {
        name: "buscar",
        description: "Busca",
        schema: { type: "object" },
        call: async (args) => {
          assert.deepEqual(args, { text: "consulta" });
          called = true;
          return "Encontrado";
        },
      },
    ],
  });
  assert.ok(called);
  assert.equal(text, "Resposta com ferramenta");
});
scenario("erro do provedor propaga sem resposta simulada", async () => {
  await assert.rejects(
    () => bridge.run({ system: "", prompt: "fail" }),
    /Limite atingido/,
  );
});
scenario("sinal de cancelamento interrompe o turno", async () => {
  const abort = new AbortController();
  const response = bridge.run({
    system: "",
    prompt: "wait",
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(() => response, /cancelada/);
});
scenario("turno que estoura o tempo da etapa explica o limite, não um cancelamento", async () => {
  await assert.rejects(() => bridge.run({ system: "", prompt: "wait", timeoutMs: 50 }), new RegExp(CHATGPT_TIMEOUT_MESSAGE.slice(0, 30)));
});
test("erros do provedor viram orientação em português e preservam o detalhe", () => {
  assert.match(turnErrorMessage("usage_limit_reached: weekly cap"), /^Sua assinatura ChatGPT atingiu o limite de uso.*Detalhe: usage_limit_reached/);
  assert.match(turnErrorMessage("HTTP 429 Too Many Requests"), /limite de uso/);
  assert.match(turnErrorMessage("401 Unauthorized: refresh token expired"), /Reconecte o ChatGPT/);
  assert.match(turnErrorMessage("connect ECONNRESET"), /Não foi possível alcançar o ChatGPT/);
  assert.match(turnErrorMessage("context_length_exceeded"), /grande demais/);
  assert.equal(turnErrorMessage("Limite atingido"), "Limite atingido");
  assert.equal(turnErrorMessage(""), "O ChatGPT não concluiu a resposta. Tente novamente.");
  assert.equal(turnErrorMessage("x".repeat(500)).length, "x".repeat(500).length);
});
test("conexões por processo nunca ficam abaixo das execuções simultâneas", () => {
  const before = process.env.EXECUCOES_SIMULTANEAS;
  try {
    delete process.env.EXECUCOES_SIMULTANEAS; assert.equal(maxBridges(), 200);
    process.env.EXECUCOES_SIMULTANEAS = "2"; assert.equal(maxBridges(), 4);
    process.env.EXECUCOES_SIMULTANEAS = "24"; assert.equal(maxBridges(), 24);
    process.env.EXECUCOES_SIMULTANEAS = "abc"; assert.equal(maxBridges(), 200);
  } finally { if (before === undefined) delete process.env.EXECUCOES_SIMULTANEAS; else process.env.EXECUCOES_SIMULTANEAS = before; }
});

scenario("imagens chegam ao turno pelo protocolo; modelo sem imagem é recusado", async () => {
  await bridge.beginLogin();
  await connected();
  const image = "data:image/png;base64,aW1hZ2Vt";
  const result = await bridge.run({ system: "Analise", prompt: "inspect-images", images: [image] });
  assert.deepEqual(JSON.parse(result), [{ type: "text", text: "inspect-images" }, { type: "image", url: image }]);
  const original = await bridge.run({ system: "Analise", prompt: "inspect-images", images: [image], imageDetail: "original" });
  assert.deepEqual(JSON.parse(original)[1], { type: "image", url: image, detail: "original" }, "a qualidade escolhida segue no protocolo");
  const models = bridge.models;
  bridge.models = async () => [{ id: "text", name: "Texto", inputModalities: ["text"], isDefault: true }];
  try {
    await assert.rejects(() => bridge.run({ system: "", prompt: "Analise", model: "text", images: [image] }), /suporte confirmado/);
  } finally { bridge.models = models; }
});

scenario("pesquisa web exige habilitação explícita por execução", async () => {
  await bridge.beginLogin();
  await connected();
  assert.equal(await bridge.run({system: "", prompt: "inspect-search"}), "disabled");
  assert.equal(await bridge.run({system: "", prompt: "inspect-search", webSearch: true}), "live");
});

scenario("notificações de tokens preservam os totais cumulativos do turno", async () => {
  const usage: number[] = [];
  await bridge.run({ system: "", prompt: "inspect-usage", onUsage: (value) => usage.push(value.total) });
  assert.deepEqual(usage, [120, 190]);
});
