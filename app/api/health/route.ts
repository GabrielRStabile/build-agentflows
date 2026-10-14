import { saasDatabase } from "@/lib/saas-db";
import { queueStats } from "@/lib/saas-jobs";
import { mailStats } from "@/lib/saas-mail";

/** Liveness for the container plus the queue picture an operator needs during a busy session.
 * `ok` reports the database only; a backlog or a missing worker is reported, not treated as unhealthy. */
export async function GET() {
  try {
    const db = saasDatabase();
    await db.query("SELECT 1");
    const queue = await queueStats(db).catch(() => undefined);
    const mail = await mailStats(db).catch(() => undefined);
    return Response.json({ ok: true, ...(queue ? { queue, workerAlive: queue.workers > 0 } : {}), ...(mail ? { mail } : {}) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
