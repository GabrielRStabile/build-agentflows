import { getConfig, setConfig } from "./store";
import { FlowError, getFlow } from "./flow-service";
import { currentTenant, withTenantJob } from "./tenant-context";
import { saasDatabase, type Database } from "./saas-db";
import { AuthError, appOrigin } from "./saas-security";
import { consumeRateLimit, rateLimitClient } from "./saas-rate-limit";
import { httpError, privateJson } from "./saas-http";

// Acesso HTTP do fluxo publicado (aba cURL em Implantar): público por padrão, sem chave;
// "autenticado" exige a chave de acesso da conta. A escolha fica na configuração da conta, por fluxo.
export type HttpAccess = "publico" | "autenticado";
export const HTTP_ACCESS: HttpAccess[] = ["publico", "autenticado"];
const keyName = (flowId: string) => "HTTP_ACESSO_" + flowId.replaceAll("-", "_");

export async function httpAccess(flowId: string): Promise<HttpAccess> {
  await getFlow(flowId);
  return getConfig(keyName(flowId)) === "autenticado" ? "autenticado" : "publico";
}
export async function saveHttpAccess(flowId: string, value: unknown): Promise<HttpAccess> {
  await getFlow(flowId);
  if (value !== "publico" && value !== "autenticado") throw new FlowError("Escolha entre acesso público e com autenticação.");
  setConfig(keyName(flowId), value === "autenticado" ? "autenticado" : null);
  return value;
}
async function withFlowOwner<T>(flowId: string, action: () => Promise<T>, db: Database) {
  if (!/^[a-f0-9-]{36}$/.test(flowId)) throw new FlowError("Fluxo não encontrado.", 404);
  const { rows } = await db.query<{ user_id: string }>("SELECT user_id FROM flows WHERE id=$1 LIMIT 2", [flowId]);
  // O endereço público não recebe o dono; ids ambíguos falham fechados.
  if (rows.length !== 1) throw new FlowError("Fluxo não encontrado.", 404);
  return withTenantJob(db, rows[0].user_id, action);
}
/** Chamada sem chave: só para fluxos publicados cujo acesso HTTP está público. */
export async function publicIntegrationApi(req: Request, flowId: string, action: () => unknown | Promise<unknown>) {
  try {
    if (req.headers.has("origin") && req.headers.get("origin") !== appOrigin()) throw new AuthError("Origem da requisição inválida.", 403);
    const db = saasDatabase();
    await consumeRateLimit(db, `integration:ip:${rateLimitClient(req.headers)}`, 180, 60);
    return await withFlowOwner(flowId, async () => {
      const { user } = currentTenant();
      if ((await httpAccess(flowId)) !== "publico") throw new AuthError("Este fluxo exige a chave de acesso. Envie o cabeçalho Authorization.", 401);
      if (!(await getFlow(flowId)).published) throw new FlowError("Fluxo não encontrado.", 404);
      await consumeRateLimit(db, `integration:user:${user.id}`, 60, 60);
      const result = await action();
      if (!(result instanceof Response)) return privateJson(result);
      const headers = new Headers(result.headers);
      headers.set("Cache-Control", "private, no-store");
      headers.set("Referrer-Policy", "no-referrer");
      return new Response(result.body, { status: result.status, headers });
    }, db);
  } catch (error) { return httpError(error); }
}
