import { tenantApi } from "@/lib/saas-http";
import { getTenantRuns, listTenantRuns, tenantRunPage } from "@/lib/tenant-flows";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return tenantApi(req, () => {
    const params = new URL(req.url).searchParams;
    const flowId = params.get("flowId") || undefined;
    if (params.has("page") || params.has("pageSize") || params.has("status")) return tenantRunPage({ page: Number(params.get("page") || 1), pageSize: Number(params.get("pageSize") || 20), status: params.get("status") || "all", flowId });
    if (params.has("ids")) return getTenantRuns((params.get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean));
    return listTenantRuns(flowId, params.has("limit") ? Number(params.get("limit")) : 100);
  });
}
