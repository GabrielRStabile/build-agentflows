import { extrairCodigo, integrationApi } from "@/lib/mcp";
import { publicIntegrationApi } from "@/lib/http-access";
import { enqueueIntegrationRun, executionSummary, integrationId } from "@/lib/ferramentas";
import { body } from "@/lib/flow-api";
import { privateJson } from "@/lib/saas-http";
import { getTenantFlow, getTenantRun } from "@/lib/tenant-flows";
import { FlowError } from "@/lib/flow-store";
type Context = { params: Promise<{ id: string }> };
// Com Authorization, a chave da conta autentica; sem ela, só fluxos com acesso HTTP público respondem.
async function handle(req: Request, c: Context, action: () => Promise<unknown>) {
  return extrairCodigo(req) ? integrationApi(req, action) : publicIntegrationApi(req, (await c.params).id, action);
}
export async function POST(req: Request, c: Context) {
  return handle(req, c, async () => {
    const b = await body(req);
    return privateJson(await enqueueIntegrationRun((await c.params).id, b.input), { status: 202 });
  });
}
export async function GET(req: Request, c: Context) {
  return handle(req, c, async () => {
    const flow = await getTenantFlow(integrationId((await c.params).id));
    const run = await getTenantRun(integrationId(new URL(req.url).searchParams.get("runId")));
    if (run.flowId !== flow.id) throw new FlowError("Execução não encontrada.", 404);
    return executionSummary(run);
  });
}
