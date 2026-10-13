import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createTenantTestContext } from "../scripts/tenant-test-context";
import { hashToken, randomToken } from "./saas-security";
import { withTenantSession } from "./tenant-context";
import { withJobLease } from "./saas-job-context";
import { getConfig } from "./store";
import { MEDIA_PROVIDERS } from "./media-models";
import { mediaKey } from "./media-credentials";
import { runMedia } from "./media-runtime";
import { generateMedia } from "./media-provider";
import { template, type Trace } from "./flow-types";
import { createTenantFlow } from "./tenant-flows";
import { buildRun, execute } from "./flow-runtime";
import { getRun, putRun } from "./flow-service";
import { saveAttachment, getAttachment } from "./attachment-service";
import { PUT as configure } from "../app/api/conexoes/route";
import { GET as catalogue } from "../app/api/conexoes/media/route";
import { GET as download } from "../app/api/attachments/[id]/route";

const NANO = "replicate:google/nano-banana";
const nanoModel = { latest_version: { id: "a".repeat(64), openapi_schema: { components: { schemas: { Input: { properties: { prompt: { type: "string" } } }, Output: { type: "string", format: "uri" } } } } } };
test("credenciais de imagens cifradas, catálogo privado e resultados isolados entre contas", async (t) => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  const other = randomUUID(), token = randomToken();
  await tenant.db.query("INSERT INTO users(id,name,email,email_verified_at,beta_status) VALUES($1,'Other',$2,now(),'approved')", [other, `${other}@example.com`]);
  await tenant.db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(token), other]);
  const anonymous = await tenant.connect(() => catalogue(new Request("https://app.example.com/api/conexoes/media")));
  assert.equal(anonymous.status, 401);
  const fields = Object.fromEntries(MEDIA_PROVIDERS.map((provider) => [provider.key, `private-${provider.id}-token`]));
  const saved = await tenant.connect(() => configure(tenant.request("/api/conexoes", { method: "PUT", body: JSON.stringify({ campos: fields }) })));
  assert.equal(saved.status, 200);
  const response = await saved.text();
  for (const value of Object.values(fields)) assert.ok(!response.includes(value), "nenhum segredo completo retorna pela API");
  const rows = await tenant.db.query("SELECT * FROM credentials WHERE user_id=$1", [tenant.owner]);
  for (const value of Object.values(fields)) assert.ok(!JSON.stringify(rows.rows).includes(value), "segredos cifrados no banco");
  await withTenantSession(tenant.db, token, async () => {
    for (const provider of MEDIA_PROVIDERS) { assert.equal(getConfig(provider.key), undefined); assert.throws(() => mediaKey(provider.id), /Adicione a chave/); }
  });
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  let imageId = "", videoId = "";
  await tenant.asTenant(async () => {
    const graph = template(); graph.nodes[1].data.config.model = NANO;
    const flow = await createTenantFlow("Geração privada", false, { name: "Geração privada", description: "", graph });
    const run = await buildRun(flow.id, "Uma imagem vermelha");
    assert.equal(run.demo, false, "credencial de imagem basta, sem ChatGPT ou OpenRouter");
    await putRun(run);
    const details: Partial<Trace> = {};
    const output = await runMedia(graph.nodes[1], run, run.input, "", new AbortController().signal, details, async (options) => {
      assert.equal(options.key, fields.REPLICATE_API_TOKEN);
      // Exercise the production adapter and persistence together, replacing only external IO.
      return generateMedia(options, {
        fetch: async (url) => Response.json(String(url).endsWith("/v1/models/google/nano-banana") ? nanoModel : { id: "provider-request", status: "succeeded", output: "https://cdn.example/result.png" }),
        pause: async () => {}, download: async () => {
          assert.equal((await getRun(run.id)).mediaRequests?.[0].requestId, "provider-request", "ID durável antes de baixar");
          return png;
        },
      });
    });
    assert.match(output, /^!\[Imagem gerada 1\]\(\/api\/attachments\/[a-f0-9-]+\)$/);
    assert.equal(details.images?.length, 1);
    imageId = details.images![0].id;
    assert.equal((await getAttachment(imageId)).flowId, flow.id);
    assert.equal((await tenant.db.query<{ used: boolean }>("SELECT used FROM attachments WHERE user_id=$1 AND id=$2", [tenant.owner, imageId])).rows[0].used, true);
    assert.equal(run.mediaRequests?.[0].status, "saved");
    const before = (await tenant.db.query("SELECT id FROM attachments WHERE user_id=$1", [tenant.owner])).rows.length;
    await assert.rejects(withJobLease({ id: randomUUID(), owner: tenant.owner, token: randomUUID() }, () => saveAttachment(flow.id, new File([new Uint8Array(png)], "image.png"), true)), /expirou ou foi revogada/);
    assert.equal((await tenant.db.query("SELECT id FROM attachments WHERE user_id=$1", [tenant.owner])).rows.length, before, "worker sem lease não grava imagens");
    // Open Replicate models may return a video or text; uploads still refuse videos.
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
    const videoDetails: Partial<Trace> = {};
    const videoOutput = await runMedia(graph.nodes[1], run, run.input, "", new AbortController().signal, videoDetails, async () => ({ files: [mp4] }));
    assert.match(videoOutput, /^!\[Vídeo gerado 1\]\(\/api\/attachments\/[a-f0-9-]+ "video"\)$/);
    videoId = videoDetails.images![0].id;
    assert.equal((await getAttachment(videoId)).mime, "video/mp4");
    await assert.rejects(saveAttachment(flow.id, new File([new Uint8Array(mp4)], "video.mp4")), /Formato não aceito/);
    const textDetails: Partial<Trace> = {};
    assert.equal(await runMedia(graph.nodes[1], run, run.input, "", new AbortController().signal, textDetails, async () => ({ text: "Resposta em texto" })), "Resposta em texto");
    assert.equal(textDetails.images, undefined);
    // Instructions that already cite the message become the whole description, sent once.
    const cited = structuredClone(graph.nodes[1]); cited.data.config.system = "Desenhe: {{input}}";
    await runMedia(cited, run, "", "Desenhe: " + run.input, new AbortController().signal, {}, async (options) => {
      assert.equal(options.prompt, "Desenhe: Uma imagem vermelha"); assert.equal(options.instructions, "");
      return { text: "ok" };
    });
    const failure = await buildRun(flow.id, "Teste de falha externa");
    await putRun(failure);
    let submitted = 0;
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://api.replicate.com/v1/models/google/nano-banana") return Response.json(nanoModel);
      assert.equal(String(url), "https://api.replicate.com/v1/predictions");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${fields.REPLICATE_API_TOKEN}`);
      submitted++;
      return Response.json({ id: "failed-generation", status: "failed", error: "provider-private-detail" });
    });
    const result = await execute(failure);
    assert.equal(submitted, 1, "motor escolhe o provedor de imagens sem fallback ou reenvio");
    assert.equal(result.status, "failed");
    assert.equal(result.mediaRequests?.[0].requestId, "failed-generation");
    assert.equal(result.trace.at(-1)?.status, "failed");
    assert.ok(!JSON.stringify(result).includes("provider-private-detail"));
  });
  const ownerResponse = await tenant.connect(() => download(tenant.request(`/api/attachments/${imageId}`), { params: Promise.resolve({ id: imageId }) }));
  assert.equal(ownerResponse.status, 200); assert.equal(ownerResponse.headers.get("content-type"), "image/png");
  assert.equal(ownerResponse.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await ownerResponse.arrayBuffer()), png);
  const videoResponse = await tenant.connect(() => download(tenant.request(`/api/attachments/${videoId}`), { params: Promise.resolve({ id: videoId }) }));
  assert.equal(videoResponse.headers.get("content-type"), "video/mp4");
  assert.match(videoResponse.headers.get("content-disposition") || "", /^inline/);
  assert.equal(videoResponse.headers.get("accept-ranges"), "bytes");
  const ranged = async (range: string) => { const request = tenant.request(`/api/attachments/${videoId}`); request.headers.set("range", range); return tenant.connect(() => download(request, { params: Promise.resolve({ id: videoId }) })); };
  const partial = await ranged("bytes=4-11");
  assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), "bytes 4-11/24");
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString("latin1"), "ftypisom");
  assert.equal((await ranged("bytes=-4")).headers.get("content-range"), "bytes 20-23/24");
  assert.equal((await ranged("bytes=40-")).status, 416);
  const otherRequest = tenant.request(`/api/attachments/${imageId}`); otherRequest.headers.set("cookie", `agentflows_session=${token}`);
  const denied = await tenant.connect(() => download(otherRequest, { params: Promise.resolve({ id: imageId }) }));
  assert.equal(denied.status, 404);
  await withTenantSession(tenant.db, token, async () => {
    const graph = template(); graph.nodes[1].data.config.model = NANO;
    const flow = await createTenantFlow("Sem chave", false, { name: "Sem chave", description: "", graph });
    await assert.rejects(buildRun(flow.id, "Gere"), /Adicione a chave/);
  });
});
