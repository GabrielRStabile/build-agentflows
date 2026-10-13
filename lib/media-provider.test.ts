import test from "node:test";
import assert from "node:assert/strict";
import { generateMedia, mediaOutputUrl, type MediaRequest } from "./media-provider";
import { MEDIA_MODELS, mediaPrompt, validateMediaConfig } from "./media-models";
import { DEFAULT_SYSTEM } from "./flow-types";
import { knowledgeFetch } from "./knowledge-http";

const signal = () => new AbortController().signal;
const NANO = "replicate:google/nano-banana", VERSION = "a".repeat(64);
const schema = (input: Record<string, unknown>, output: unknown) => ({ latest_version: { id: VERSION, openapi_schema: { components: { schemas: { Input: { properties: input }, Output: output } } } } });
const nanoSchema = schema({ prompt: { type: "string" }, image_input: { type: "array", items: { type: "string", format: "uri" } }, output_format: { type: "string", enum: ["jpg", "png"] } }, { type: "string", format: "uri" });
// Reading the model schema is free; tests count only submissions, polling and cancellation.
const withSchema = (fetch: typeof globalThis.fetch, model: unknown = nanoSchema) => (async (url, init) => {
  if (!/\/v1\/models\//.test(String(url))) return fetch(url, init);
  assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
  return Response.json(model);
}) as typeof globalThis.fetch;
for (const model of [{ id: NANO, provider: "replicate" }, ...MEDIA_MODELS]) {
  test(`${model.provider}: autenticação, uma submissão, polling e download sem vazar chave`, async () => {
    const requests: { url: string; init?: RequestInit }[] = [], submitted: MediaRequest[] = [];
    const bytes = Buffer.from("image bytes"), key = "owner-private-key";
    const result = await generateMedia({ model: model.id, key, prompt: "Uma paisagem", signal: signal(), onSubmitted: async (request) => { submitted.push(request); } }, {
      fetch: withSchema(async (url, init) => {
        requests.push({ url: String(url), init });
        const headers = new Headers(init?.headers);
        assert.equal(init?.redirect, "error");
        assert.equal(headers.get(model.provider === "muapi" ? "x-api-key" : "authorization"), model.provider === "muapi" ? key : `${model.provider === "replicate" ? "Bearer" : "Key"} ${key}`);
        if (requests.length === 1) {
          const body = JSON.parse(String(init?.body));
          assert.equal(model.provider === "replicate" ? body.input.prompt : body.prompt, "Uma paisagem");
          assert.equal(init?.method, "POST");
          return Response.json({ id: "request-1", request_id: "request-1", status: "processing", status_url: "https://evil.example/steal", cancel_url: "https://evil.example/steal" });
        }
        assert.equal(submitted.length, 1, "identificação persistida antes de consultar");
        assert.equal(init?.method, "GET");
        return Response.json({ status: model.provider === "replicate" ? "succeeded" : "completed", output: "https://cdn.example/image.png", outputs: ["https://cdn.example/image.png"], images: [{ url: "https://cdn.example/image.png" }] });
      }),
      download: async (url, options) => { assert.equal(url, "https://cdn.example/image.png"); assert.equal(options?.headers, undefined); assert.equal(options?.maxBytes, 10485760); return bytes; },
      pause: async () => {},
    });
    assert.deepEqual(result, { files: [bytes] });
    assert.equal(requests.length, 2);
    if (model.provider === "replicate") { assert.equal(new Headers(requests[0].init?.headers).get("cancel-after"), "10m", "vídeos de 4-5 minutos cabem no prazo");
      assert.match(requests[0].url, /\/v1\/predictions$/); assert.equal(JSON.parse(String(requests[0].init?.body)).version, "google/nano-banana"); }
    assert.match(requests[1].url, model.provider === "replicate" ? /\/v1\/predictions\/request-1$/ : model.provider === "higgsfield" ? /\/requests\/request-1\/status$/ : /\/api\/v1\/predictions\/request-1\/result$/);
    assert.ok(requests.every((request) => !request.url.includes("evil.example")));
  });
  test(`${model.provider}: cancelar interrompe consultas, sem nova geração`, async () => {
    const controller = new AbortController(), requests: string[] = [];
    await assert.rejects(generateMedia({ model: model.id, key: "private", prompt: "Teste", signal: controller.signal,
      onSubmitted: async () => { controller.abort(); },
    }, {
      fetch: withSchema(async (url, init) => {
        requests.push(String(url));
        assert.equal(init?.signal?.aborted, false, "cancelamento remoto usa sinal independente");
        return requests.length === 1 ? Response.json({ id: "id-1", request_id: "id-1", status: "queued" }) : new Response(null, { status: 202 });
      }),
      download: async () => { throw new Error("não deve baixar"); }, pause: async () => { throw new Error("não deve consultar"); },
    }), /pode continuar no provedor/);
    assert.equal(requests.length, model.provider === "muapi" ? 1 : 2);
    if (requests.length === 2) assert.ok(requests[1].endsWith("/id-1/cancel"));
  });
}

test("submissão ambígua não é repetida e erros não revelam segredos", async () => {
  let count = 0;
  for (const response of [null, new Response("private-key secret prompt", { status: 401 })]) {
    await assert.rejects(generateMedia({ model: NANO, key: "private-key", prompt: "secret prompt", signal: signal(), onSubmitted: async () => {} }, {
      fetch: withSchema(async () => { count++; if (!response) throw new Error("private-key secret prompt"); return response; }), download: async () => Buffer.alloc(0), pause: async () => {},
    }), (error: Error) => { assert.doesNotMatch(error.message, /private-key|secret prompt/); return true; });
  }
  assert.equal(count, 2);
});
test("Replicate aceita referência inline e autentica apenas seu domínio de entrega", async () => {
  for (const host of ["replicate.delivery", "output.replicate.delivery", "replicate.delivery.evil.example"]) {
    await generateMedia({ model: NANO, key: "token", prompt: "Edite", images: ["data:image/png;base64,YQ=="], signal: signal(), onSubmitted: async () => {} }, {
      fetch: withSchema(async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)).input, { prompt: "Edite", image_input: ["data:image/png;base64,YQ=="], output_format: "png" });
        return Response.json({ id: "id", status: "succeeded", output: `https://${host}/image.png` });
      }),
      download: async (_url, options) => { assert.equal(options?.headers?.Authorization, host.endsWith("evil.example") ? undefined : "Bearer token"); return Buffer.from("png"); }, pause: async () => {},
    });
  }
});
test("modelos e recursos incompatíveis são recusados antes de qualquer cobrança", async () => {
  let calls = 0;
  const dependencies = { fetch: async () => { calls++; return Response.json({}); }, download: async () => Buffer.alloc(0), pause: async () => {} };
  for (const [model, images, prompt] of [["replicate:", [], "Teste"], ["replicate:Google/Nano", [], "Teste"], ["replicate:../steal", [], "Teste"], [MEDIA_MODELS[1].id, ["data:image/png;base64,YQ=="], "Teste"], [NANO, ["https://private.example/file"], "Teste"], [NANO, [], "x".repeat(20001)]] as [string, string[], string][]) {
    await assert.rejects(generateMedia({ model, images, prompt, key: "x", signal: signal(), onSubmitted: async () => {} }, dependencies));
  }
  assert.equal(calls, 0);
  assert.throws(() => validateMediaConfig({ model: NANO, tools: "builtin:http" }));
  // Memory and bases set before choosing a media model are ignored, not rejected.
  for (const config of [{ memoryType: "conversationSummary" }, { knowledgeBase: "base" }] as Record<string, string>[])
    validateMediaConfig({ model: NANO, ...config });
  for (const model of ["replicate:", "replicate:Google/Nano", "replicate:google", "replicate:google/nano/banana"]) assert.throws(() => validateMediaConfig({ model }), /empresa\/modelo/);
  validateMediaConfig({ model: NANO, memoryType: "windowSize" });
  assert.equal(mediaPrompt({ system: "" }), "{{input}}");
  assert.equal(mediaPrompt({ system: DEFAULT_SYSTEM }), "{{input}}");
  assert.equal(mediaPrompt({ system: "Gato em aquarela: {{input}}", prompt: "ignorada" }), "Gato em aquarela: {{input}}");
  validateMediaConfig({ model: "replicate:meta/meta-llama-3-8b-instruct" });
});
test("respostas inválidas, excesso de bytes e saída sem imagens falham sem baixar", async () => {
  for (const response of [new Response("not json"), new Response("x".repeat(1024 * 1024 + 1)), Response.json({ id: "../steal", status: "queued" }), Response.json({ id: "id", status: "failed", error: "private-key" }), Response.json({ id: "id", status: "succeeded", output: [] })]) {
    await assert.rejects(generateMedia({ model: NANO, key: "private-key", prompt: "Teste", signal: signal(), onSubmitted: async () => {} }, {
      fetch: withSchema(async () => response), download: async () => { throw new Error("não deve baixar"); }, pause: async () => {},
    }), (error: Error) => { assert.doesNotMatch(error.message, /private-key|não deve baixar/); return true; });
  }
  for (const url of ["http://example.com/image", "https://user:pass@example.com/image", "file:///tmp/file", "data:image/png;base64,YQ=="]) assert.throws(() => mediaOutputUrl(url));
});

test("download real recusa endereços internos antes de abrir conexão", async () => {
  for (const host of ["127.0.0.1", "169.254.169.254", "[::1]", "[::ffff:127.0.0.1]"]) {
    await assert.rejects(generateMedia({ model: NANO, key: "token", prompt: "Teste", signal: signal(), onSubmitted: async () => {} }, {
      fetch: withSchema(async () => Response.json({ id: "id", status: "succeeded", output: `https://${host}/image.png` })),
      download: knowledgeFetch, pause: async () => {},
    }), /endereço público/);
  }
});

test("falha ao persistir identificação cancela a solicitação sem consultar ou reenviar", async () => {
  const requests: string[] = [];
  await assert.rejects(generateMedia({ model: NANO, key: "token", prompt: "Teste", signal: signal(), onSubmitted: async () => { throw new Error("lease expirada"); } }, {
    fetch: withSchema(async (url) => { requests.push(String(url)); return Response.json({ id: "id", status: "starting" }); }),
    download: async () => { throw new Error("não deve baixar"); }, pause: async () => { throw new Error("não deve consultar"); },
  }), /lease expirada/);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].endsWith("/v1/predictions/id/cancel"));
});

test("Replicate aberto: texto com instruções separadas, sem download", async () => {
  const bodies: Record<string, unknown>[] = [];
  const result = await generateMedia({ model: "replicate:meta/meta-llama-3-8b-instruct", key: "token", prompt: "Olá", instructions: "Seja breve", signal: signal(), onSubmitted: async () => {} }, {
    fetch: withSchema(async (_url, init) => {
      if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
      return Response.json({ id: "id", status: "succeeded", output: ["Oi", ", tudo", " bem?"] });
    }, schema({ prompt: { type: "string" }, system_prompt: { type: "string" } }, { type: "array", items: { type: "string" }, "x-cog-array-display": "concatenate" })),
    download: async () => { throw new Error("não deve baixar"); }, pause: async () => {},
  });
  assert.deepEqual(result, { text: "Oi, tudo bem?" });
  assert.deepEqual(bodies, [{ version: "meta/meta-llama-3-8b-instruct", input: { prompt: "Olá", system_prompt: "Seja breve" } }]);
});
test("Replicate aberto: vídeo e modelo da comunidade pela versão após recusa definitiva", async () => {
  const posts: Record<string, unknown>[] = [];
  const video = Buffer.from("video bytes");
  const result = await generateMedia({ model: "replicate:acme/video-model", key: "token", prompt: "Um gato", instructions: "Cinematográfico", signal: signal(), onSubmitted: async () => {} }, {
    fetch: withSchema(async (_url, init) => {
      if (init?.method !== "POST") return Response.json({ status: "succeeded", output: "https://replicate.delivery/out.mp4" });
      posts.push(JSON.parse(String(init.body)));
      return posts.length === 1 ? new Response("{}", { status: 422 }) : Response.json({ id: "id", status: "processing" });
    }, schema({ prompt: { type: "string" }, start_image: { type: "string", format: "uri" } }, { type: "string", format: "uri" })),
    download: async (url) => { assert.equal(url, "https://replicate.delivery/out.mp4"); return video; }, pause: async () => {},
  });
  assert.deepEqual(result, { files: [video] });
  assert.deepEqual(posts.map((post) => post.version), ["acme/video-model", `acme/video-model:${VERSION}`]);
  assert.deepEqual(posts[1].input, { prompt: "Cinematográfico\n\nUm gato" });
});
test("Replicate aberto: modelo inexistente ou sem entrada de imagem é recusado antes da submissão", async () => {
  let posts = 0;
  const fetch = async (_url: unknown, init?: RequestInit) => { if (init?.method === "POST") posts++; return Response.json({ id: "id", status: "succeeded" }); };
  await assert.rejects(generateMedia({ model: "replicate:acme/missing", key: "token", prompt: "Teste", signal: signal(), onSubmitted: async () => {} }, {
    fetch: (async (url: unknown, init?: RequestInit) => /\/v1\/models\//.test(String(url)) ? new Response("{}", { status: 404 }) : fetch(url, init)) as typeof globalThis.fetch, download: async () => Buffer.alloc(0), pause: async () => {},
  }), /não foi encontrado na Replicate/);
  await assert.rejects(generateMedia({ model: "replicate:acme/text-only", key: "token", prompt: "Teste", images: ["data:image/png;base64,YQ=="], signal: signal(), onSubmitted: async () => {} }, {
    fetch: withSchema(fetch as typeof globalThis.fetch, schema({ prompt: { type: "string" } }, { type: "string" })), download: async () => Buffer.alloc(0), pause: async () => {},
  }), /não recebe imagens/);
  await assert.rejects(generateMedia({ model: "replicate:acme/no-prompt", key: "token", prompt: "Teste", signal: signal(), onSubmitted: async () => {} }, {
    fetch: withSchema(fetch as typeof globalThis.fetch, schema({ seed: { type: "integer" } }, { type: "string" })), download: async () => Buffer.alloc(0), pause: async () => {},
  }), /não recebe uma descrição em texto/);
  assert.equal(posts, 0);
});
