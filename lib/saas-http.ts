import type { Database } from "./saas-db";
import { saasDatabase } from "./saas-db";
import { AuthError, appOrigin } from "./saas-security";
import { consumeActionToken, findSession, loginUser, redeemInvite, registerUser, requestActionMail, revokeSession, requireBetaAccess, SAAS_SESSION_COOKIE, SESSION_SECONDS } from "./saas-auth";
import { addressLimit, consumeRateLimit, rateLimitClient, RateLimitError } from "./saas-rate-limit";
import { withTenantSession } from "./tenant-context";
import { FlowError } from "./flow-store";
import { AI_ACTION_URL, PlanLimitError } from "./saas-plan";

export function sessionToken(req: Request) {
  return req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SAAS_SESSION_COOKIE}=`))?.slice(SAAS_SESSION_COOKIE.length + 1);
}
export function sessionCookie(token: string, clear = false) {
  return `${SAAS_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_SECONDS}${appOrigin().startsWith("https:") ? "; Secure" : ""}`;
}
// An invite link (?invite=) survives sign-up, sign-in, Google and e-mail confirmation in this browser.
export const INVITE_COOKIE = "agentflows_invite";
const INVITE_SECONDS = 24 * 60 * 60;
export function inviteCode(value: unknown) {
  const code = typeof value === "string" ? value.trim() : "";
  return code.length >= 8 && code.length <= 128 && /^[\x21-\x7e]+$/.test(code) ? code : undefined;
}
export function inviteFromRequest(req: Request) {
  const raw = req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${INVITE_COOKIE}=`))?.slice(INVITE_COOKIE.length + 1);
  try { return raw ? inviteCode(decodeURIComponent(raw)) : undefined; } catch { return undefined; }
}
export function inviteCookie(code: string, clear = false) {
  return `${INVITE_COOKIE}=${clear ? "" : encodeURIComponent(code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : INVITE_SECONDS}${appOrigin().startsWith("https:") ? "; Secure" : ""}`;
}
export function assertSameOrigin(req: Request) {
  if (req.headers.get("origin") !== appOrigin()) throw new AuthError("Origem da requisição inválida.", 403);
  if (req.headers.get("sec-fetch-site") === "cross-site") throw new AuthError("Origem da requisição inválida.", 403);
}
export async function limitedJson(req: Request, maxBytes = 16384): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AuthError("Envie os dados em JSON.", 415);
  const raw = await limitedText(req, maxBytes);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new AuthError("Envie um formulário válido."); }
}
export async function limitedText(req: Request, maxBytes: number): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) throw new AuthError("Envie os dados do formulário.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new AuthError("Formulário muito grande.", 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function privateJson(value: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return Response.json(value, { ...init, headers });
}
export function httpError(error: unknown) {
  const known = error instanceof AuthError || error instanceof FlowError;
  const plan = error instanceof PlanLimitError ? { code: error.code, upgradeUrl: AI_ACTION_URL } : {};
  return privateJson({ error: known ? error.message : "Não foi possível concluir. Tente novamente.", ...plan }, {
    status: known ? error.status : 500,
    headers: error instanceof RateLimitError ? { "Retry-After": String(error.retryAfter) } : undefined,
  });
}

export async function authAction(db: Database, req: Request, action: string) {
  try {
    if (action === "session" && req.method === "GET") {
      return privateJson({ user: await findSession(db, sessionToken(req)), invitePending: !!inviteFromRequest(req) });
    }
    if (req.method !== "POST") return privateJson({ error: "Método não permitido." }, { status: 405, headers: { Allow: "POST" } });
    assertSameOrigin(req);
    const client = rateLimitClient(req.headers);
    await consumeRateLimit(db, `auth:ip:${client}`, addressLimit(client, 5), 60);
    if (action === "logout") {
      await revokeSession(db, sessionToken(req));
      // Another account signing in on this browser must not inherit the pending invite.
      const headers = new Headers({ "Set-Cookie": sessionCookie("", true) });
      headers.append("Set-Cookie", inviteCookie("", true));
      return privateJson({ ok: true }, { headers });
    }
    const data = await limitedJson(req);
    if (action === "register") {
      if (data.password !== data.confirmPassword) throw new AuthError("As senhas não são iguais.");
      await registerUser(db, { name: data.name, email: data.email, password: data.password }, client, inviteCode(data.invite) ?? inviteFromRequest(req));
      return privateJson({ message: "Se o cadastro puder ser criado, enviaremos um link para confirmar seu e-mail." }, { status: 202 });
    }
    if (action === "login") {
      const { token, user } = await loginUser(db, { email: data.email, password: data.password }, client);
      return privateJson({ user, invitePending: !!inviteFromRequest(req) }, { headers: { "Set-Cookie": sessionCookie(token) } });
    }
    if (action === "forgot-password" || action === "resend-verification") {
      await requestActionMail(db, data.email, action === "forgot-password" ? "reset_password" : "verify_email", client, inviteCode(data.invite) ?? inviteFromRequest(req));
      return privateJson({ message: "Se houver uma conta elegível, enviaremos um link para seu e-mail." }, { status: 202 });
    }
    if (action === "verify-email" || action === "reset-password") {
      await consumeRateLimit(db, `action-token:ip:${client}`, addressLimit(client), 60);
      await consumeActionToken(db, data.token, action === "verify-email" ? "verify_email" : "reset_password", data.password);
      return privateJson({ ok: true });
    }
    if (action === "invite") {
      const user = await findSession(db, sessionToken(req));
      if (!user) throw new AuthError("Entre na sua conta.", 401);
      const typed = typeof data.code === "string" && data.code.trim() ? data.code : undefined;
      const clear = { "Set-Cookie": inviteCookie("", true) };
      try { await redeemInvite(db, user.id, typed ?? inviteFromRequest(req)); }
      catch (error) {
        // Keep the invite while the account still needs confirmation or the limit is temporary.
        const settled = error instanceof AuthError && !(error instanceof RateLimitError) && !/Confirme/.test(error.message);
        const response = httpError(error);
        if (settled) response.headers.append("Set-Cookie", clear["Set-Cookie"]);
        return response;
      }
      return privateJson({ ok: true }, { headers: clear });
    }
    return privateJson({ error: "Ação não encontrada." }, { status: 404 });
  } catch (error) { return httpError(error); }
}

/** Every private route revalidates the session; client-supplied owner headers are ignored. */
export async function tenantApi(req: Request, action: () => unknown | Promise<unknown>, db: Database = saasDatabase()) {
  try {
    if (!["GET", "HEAD"].includes(req.method)) assertSameOrigin(req);
    return await withTenantSession(db, sessionToken(req), async () => {
      const { currentTenant } = await import("./tenant-context");
      await consumeRateLimit(db, `api:user:${currentTenant().user.id}`, 120, 60);
      const pathname = new URL(req.url).pathname;
      if (req.method !== "GET" && (/^\/api\/(voz|chatgpt|knowledge)(\/|$)/.test(pathname) || /\/(run|generate|index|query|testar|attachments)$/.test(pathname))) {
        await consumeRateLimit(db, `api-costly:user:${currentTenant().user.id}`, 20, 60);
      }
      const result = await action();
      if (!(result instanceof Response)) return privateJson(result);
      const headers = new Headers(result.headers);
      headers.set("Cache-Control", "private, no-store");
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
    });
  } catch (error) { return httpError(error); }
}

/** The authenticated scope stays alive until generation and credential commit finish. */
export async function tenantJsonStream(req: Request, action: (emit: (value: unknown) => void, signal: AbortSignal) => Promise<unknown>, db: Database = saasDatabase()) {
  try {
    assertSameOrigin(req);
    const token = sessionToken(req), user = await findSession(db, token);
    requireBetaAccess(user);
    await consumeRateLimit(db, `api:user:${user.id}`, 120, 60);
    await consumeRateLimit(db, `api-costly:user:${user.id}`, 20, 60);
    const abort = new AbortController();
    const signal = AbortSignal.any([req.signal, abort.signal, AbortSignal.timeout(180000)]);
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const emit = (value: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(value) + "\n")); };
        void withTenantSession(db, token, async () => {
          signal.throwIfAborted();
          const result = await action(emit, signal);
          signal.throwIfAborted();
          return result;
        }).then((result) => emit({ result })).catch((error) => {
          emit({ error: error instanceof AuthError || error instanceof FlowError ? error.message : "Não foi possível gerar o fluxo. Tente novamente." });
        }).finally(() => { if (!cancelled) controller.close(); });
      },
      cancel() { cancelled = true; abort.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
  } catch (error) { return httpError(error); }
}
