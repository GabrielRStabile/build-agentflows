import { attachmentBytes, getAttachment } from "@/lib/attachment-service";
import { requestApi } from "@/lib/flow-api";
// Single byte ranges let browsers (Safari in particular) play and seek generated videos.
function byteRange(header: string | null, size: number) {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : "invalid";
}
export async function GET(req: Request, c: { params: Promise<{ id: string }> }) {
  return requestApi(req, async () => {
    const { id } = await c.params;
    const a = await getAttachment(id);
    const bytes = await attachmentBytes(id);
    const headers: Record<string, string> = {
      "Content-Type": a.mime, "Accept-Ranges": "bytes",
      "Content-Disposition": `${a.kind === "image" || a.kind === "video" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    };
    const range = byteRange(req.headers.get("range"), bytes.length);
    if (range === "invalid") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.length}` } });
    if (range) return new Response(new Uint8Array(bytes.subarray(range.start, range.end + 1)), { status: 206, headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}` } });
    return new Response(new Uint8Array(bytes), { headers });
  });
}
