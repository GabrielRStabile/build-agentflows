import { runEventStream } from "@/lib/run-stream";
export const dynamic = "force-dynamic";
type C = { params: Promise<{ id: string }> };
/** Push channel for one run; the client falls back to polling GET /api/runs/[id] when streams are unavailable. */
export async function GET(req: Request, c: C) {
  return runEventStream(req, (await c.params).id);
}
