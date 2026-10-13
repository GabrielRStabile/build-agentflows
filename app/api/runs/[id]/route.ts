import { cancelRun } from "@/lib/flow-runtime";
import { requestApi, body } from "@/lib/flow-api";
import { describeRun, enqueueResume } from "@/lib/saas-jobs";
import { notifyJob } from "@/lib/saas-queue";
import { tenantApi } from "@/lib/saas-http";
import { isUnchangedRun } from "@/lib/run-page";
type C = { params: Promise<{ id: string }> };
/** Polling clients send the updatedAt they already hold; an unchanged run answers 204 without a body. */
export async function GET(req: Request, c: C) {
  return tenantApi(req, async () => {
    const run = await describeRun((await c.params).id);
    const after = new URL(req.url).searchParams.get("after");
    if (after && isUnchangedRun(run, after)) return new Response(null, { status: 204 });
    return run;
  });
}
export async function POST(req: Request, c: C) {
  return requestApi(req, async () => {
    const b = await body(req);
    if (b.action !== "cancel") {
      const { run, job } = await enqueueResume((await c.params).id, b.decision);
      await notifyJob(job.id);
      return Response.json(run, { status: 202 });
    }
    return cancelRun((await c.params).id);
  });
}
