import { requestApi, body } from "@/lib/flow-api";
import { httpAccess, saveHttpAccess } from "@/lib/http-access";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, c: Context) {
  return requestApi(req, async () => ({ acesso: await httpAccess((await c.params).id) }));
}
export async function PUT(req: Request, c: Context) {
  return requestApi(req, async () => ({ acesso: await saveHttpAccess((await c.params).id, (await body(req)).acesso) }));
}
