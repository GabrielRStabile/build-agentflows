import nodeTest, { type TestContext } from "node:test";
import { createTenantTestContext } from "../scripts/tenant-test-context";
const testTenant = await createTenantTestContext();
function test(name: string, action: (t: TestContext) => unknown | Promise<unknown>) { return nodeTest(name, async t => { await testTenant.asTenant(() => action(t)); }); }
nodeTest.after(testTenant.close);
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
const dir = mkdtempSync(join(tmpdir(), "agentflows-knowledge-"));
process.env.DATA_DIR = dir;
const store = await import("./knowledge-service");
const index = await import("./knowledge-index-service");
const loaders = await import("./knowledge-loaders");
const { DEFAULT_INDEX, DEFAULT_SPLITTER } = await import("./knowledge-types");
const { KNOWLEDGE_LOADERS } = await import("./knowledge-catalog");
const { knowledgeFetch, privateKnowledgeAddress } = await import(
  "./knowledge-http"
);
let embeddingCalls = 0,
  failure = false,
  malformed = false;
const collections = new Map<string, { id: string; vector: number[] }[]>();
const requests: { url: string; method: string; authorization?: string }[] = [];
const server = createServer(async (req, res) => {
  requests.push({
    url: req.url || "",
    method: req.method || "GET",
    authorization: req.headers.authorization,
  });
  let raw = "";
  for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader("Content-Type", "application/json");
  const send = (body: unknown) => res.end(JSON.stringify(body));
  if (req.url?.endsWith("/embeddings") || req.url === "/api/embed") {
    if (failure) {
      res.statusCode = 503;
      return send({ error: "upstream error with secret should never appear" });
    }
    embeddingCalls += body.input.length;
    const vectors = body.input.map((text: string) => [
      Number(/reembolso/i.test(text)),
      Number(/frete/i.test(text)),
      0.1,
    ]);
    return send(
      req.url === "/api/embed"
        ? { embeddings: vectors }
        : {
            data: vectors
              .map((embedding: number[], index: number) => ({
                embedding: malformed ? [] : embedding,
                index,
              }))
              .reverse(),
          },
    );
  }
  const match = req.url?.match(/^\/collections\/([^/?]+)(.*)$/);
  if (match) {
    const [, name, action] = match;
    if (req.method === "DELETE") {
      const exists = collections.delete(name);
      if (!exists) res.statusCode = 404;
      return send({ result: exists });
    }
    if (action.startsWith("/points/query"))
      return send({
        result: {
          points: (collections.get(name) || [])
            .map((p) => ({
              id: p.id,
              score: index.cosineSimilarity(p.vector, body.query),
            }))
            .filter((p) => p.score >= body.score_threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, body.limit),
        },
      });
    if (action.startsWith("/points/delete")) {
      collections.set(name, (collections.get(name) || []).filter((p) => !body.points.includes(p.id)));
      return send({ result: { status: "completed" } });
    }
    if (action.startsWith("/points")) {
      collections.set(name, [...(collections.get(name) || []), ...body.points]);
      return send({ result: { status: "completed" } });
    }
    collections.set(name, []);
    return send({ result: true });
  }
  res.statusCode = 404;
  send({ error: "not found" });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
nodeTest.after(async () => {
  server.close();
  server.closeAllConnections();
  rmSync(dir, { recursive: true, force: true });
});
async function base(name = "Atendimento") {
  const base = (await store.createKnowledgeBase({ name }));
  (await store.updateKnowledgeBase(base.id, {
    config: {
      ...structuredClone(DEFAULT_INDEX),
      embeddings: {
        provider: "openai",
        model: "test",
        url: url + "/v1",
        apiKey: "secret-embedding",
      },
    },
  }));
  return base;
}
async function source(baseId: string, text: string, name = "Política") {
  return (await store.saveKnowledgeSource(baseId, {
    name,
    loader: "plain",
    config: { text },
    splitter: DEFAULT_SPLITTER,
    metadata: {},
  }));
}
test("catálogo contém exatamente os 20 extratores solicitados, em ordem alfabética", () => {
  assert.equal(KNOWLEDGE_LOADERS.length, 20);
  assert.deepEqual(
    KNOWLEDGE_LOADERS.map((l) => l.name),
    [
      "Apify Website Content Crawler",
      "Cheerio Web Scraper",
      "Csv File",
      "Custom Document Loader",
      "Docx File",
      "FireCrawl",
      "Github",
      "Google Drive",
      "Google Sheets",
      "JSON File",
      "Microsoft Excel",
      "Microsoft Power Point",
      "Microsoft Word",
      "PDF File",
      "Plain Text",
      "S3",
      "S3 Directory",
      "SearchAPI For Web Search",
      "Spider Document Loaders",
      "TextFile",
    ],
  );
});
test("extrai texto, CSV com aspas e JSON aninhado; fragmentação preserva limites e metadados", async () => {
  const csv = await loaders.extractKnowledge("csv", { column: "texto" }, [
    {
      name: "dados.csv",
      data: Buffer.from(
        'nome,texto\nAna,"Reembolso, em 7 dias"\nBia,"Frete grátis"',
      ).toString("base64"),
    },
  ]);
  assert.equal(csv.documents[0].pageContent, "Reembolso, em 7 dias");
  assert.equal(csv.documents[0].metadata.row, 2);
  const json = await loaders.extractKnowledge(
    "json",
    { pointer: "dados.itens" },
    [
      {
        name: "dados.json",
        data: Buffer.from(
          JSON.stringify({ dados: { itens: [{ prazo: 7 }, { prazo: 14 }] } }),
        ).toString("base64"),
      },
    ],
  );
  assert.equal(json.documents.length, 2);
  assert.match(json.documents[1].pageContent, /14/);
  const result = await loaders.extractKnowledge("plain", {
    text: "reembolso ".repeat(400),
  });
  const chunks = await loaders.splitDocuments(
    result.documents,
    "source",
    { ...DEFAULT_SPLITTER, size: 200, overlap: 30 },
    { setor: "Suporte" },
  );
  assert.ok(chunks.length > 1);
  assert.ok(
    chunks.every(
      (c) => c.pageContent.length <= 200 && c.metadata.setor === "Suporte",
    ),
  );
  await assert.rejects(
    () =>
      loaders.splitDocuments(result.documents, "source", {
        ...DEFAULT_SPLITTER,
        overlap: 1000,
      }),
    /sobreposição/,
  );
  await assert.rejects(
    () =>
      loaders.extractKnowledge("pdf", {}, [{ name: "data.txt", data: "YWJj" }]),
    /compatível/,
  );
});
test("credenciais cifradas e isolamento entre bases e fontes", async () => {
  const b = (await base());
  const other = (await base("Outra"));
  const s = (await store.saveKnowledgeSource(b.id, {
    name: "Site privado",
    loader: "firecrawl",
    config: { url: "https://example.com", token: "very-secret-token" },
    splitter: DEFAULT_SPLITTER,
    metadata: {},
  }));
  assert.equal(s.config.token, undefined);
  assert.deepEqual(s.configuredSecrets, ["token"]);
  assert.ok(
    !JSON.stringify((await store.getKnowledgeBase(b.id))).includes("secret-embedding"),
  );
  const rows = (await testTenant.db.query("SELECT ciphertext FROM knowledge_private WHERE user_id=$1", [testTenant.owner])).rows;
  assert.ok(!JSON.stringify(rows).includes("very-secret-token"));
  await assert.rejects(async () => (await store.getKnowledgeSource(other.id, s.id)), /não existe/);
  await assert.rejects(
    async () => (await store.deleteKnowledgeSource(other.id, s.id)),
    /não existe/,
  );
  assert.equal(
    (await store.getKnowledgeSourcePrivate(b.id, s.id)).config.token,
    "very-secret-token",
  );
  (await store.saveKnowledgeSource(
    b.id,
    { ...s, config: { url: "https://example.org", token: "" } },
    undefined,
    s.id,
  ));
  assert.equal(
    (await store.getKnowledgeSourcePrivate(b.id, s.id)).config.token,
    "very-secret-token",
  );
});
test("ciclo de extração, indexação, consulta, reuso, edição e exclusão não retorna conteúdo antigo", async () => {
  const b = (await base());
  const a = (await source(b.id, "Reembolso permitido em sete dias."));
  const s = (await source(b.id, "Frete custa vinte reais.", "Entrega"));
  await index.processKnowledgeSource(b.id, a.id);
  await index.processKnowledgeSource(b.id, s.id);
  await assert.rejects(
    () => index.queryKnowledge(b.id, "reembolso"),
    /indexada/,
  );
  const calls = embeddingCalls;
  const first = await index.indexKnowledge(b.id);
  assert.equal(first.base.status, "ready");
  assert.equal(first.run.embedded, 2);
  assert.equal(embeddingCalls - calls, 2);
  const hits = await index.queryKnowledge(
    b.id,
    "Como pedir reembolso?",
    1,
    0.5,
  );
  assert.equal(hits[0].sourceId, a.id);
  assert.match(hits[0].pageContent, /sete/);
  const second = await index.indexKnowledge(b.id);
  assert.equal(second.run.embedded, 0);
  assert.equal(second.run.reused, 2);
  const chunk = (await store.listKnowledgeChunks(b.id, a.id))[0];
  (await store.editKnowledgeChunk(b.id, chunk.id, {
    pageContent: "Reembolso em trinta dias.",
    metadata: { source: "manual.pdf", page: 3 },
  }));
  await assert.rejects(
    () => index.queryKnowledge(b.id, "reembolso"),
    /indexada/,
  );
  const third = await index.indexKnowledge(b.id);
  assert.equal(third.run.embedded, 1);
  assert.equal(third.run.reused, 1);
  assert.match(
    (await index.queryKnowledge(b.id, "reembolso", 1))[0].pageContent,
    /trinta/,
  );
  (await store.deleteKnowledgeSource(b.id, a.id));
  await index.indexKnowledge(b.id);
  assert.equal(
    (await index.queryKnowledge(b.id, "reembolso", 4, 0.5)).length,
    0,
  );
  await index.deleteKnowledgeBase(b.id);
  await assert.rejects(async () => (await store.getKnowledgeBase(b.id)), /não existe/);
});
test("falha de embeddings não publica índice parcial; recuperação e trava de concorrência", async () => {
  const b = (await base());
  const s = (await source(b.id, "Reembolso em sete dias."));
  await index.processKnowledgeSource(b.id, s.id);
  failure = true;
  await assert.rejects(() => index.indexKnowledge(b.id), /503/);
  failure = false;
  assert.equal((await store.getKnowledgeBase(b.id)).status, "failed");
  assert.equal((await store.listKnowledgeRuns(b.id))[0].status, "failed");
  assert.equal(
    (await testTenant.db.query("SELECT * FROM knowledge_indexes WHERE user_id=$1 AND base_id=$2", [testTenant.owner, b.id])).rows[0],
    undefined,
  );
  await index.indexKnowledge(b.id);
  malformed = true;
  await assert.rejects(
    () => index.queryKnowledge(b.id, "reembolso"),
    /inválidos/,
  );
  malformed = false;
});
nodeTest("lease de conhecimento bloqueia outras operações do mesmo usuário", async () => {
  const b = await testTenant.asTenant(async () => {
    const b = await base(); const s = await source(b.id, "Reembolso em sete dias.");
    await index.processKnowledgeSource(b.id, s.id); return b;
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const holding = testTenant.asTenant(() => store.withKnowledgeLock(b.id, async () => { entered(); await gate; }));
  await ready;
  try {
    await testTenant.asTenant(async () => {
      const chunk = (await store.listKnowledgeChunks(b.id))[0];
      await assert.rejects(() => store.editKnowledgeChunk(b.id, chunk.id, null), /andamento/);
      await assert.rejects(() => index.indexKnowledge(b.id), /andamento/);
    });
  } finally { release(); await holding; }
});
test("Qdrant e Ollama usam os contratos reais; gerações antigas são removidas", async () => {
  const b = (await base());
  const config = structuredClone(DEFAULT_INDEX);
  config.embeddings = { provider: "ollama", model: "embedding-local", url };
  config.vectorStore = { provider: "qdrant", url, apiKey: "vector-secret" };
  (await store.updateKnowledgeBase(b.id, { config }));
  const s = (await source(b.id, "Frete gratuito para assinantes."));
  await index.processKnowledgeSource(b.id, s.id);
  await index.indexKnowledge(b.id);
  assert.equal(collections.size, 1);
  assert.equal((await index.queryKnowledge(b.id, "frete"))[0].sourceId, s.id);
  await index.indexKnowledge(b.id);
  assert.equal(collections.size, 1);
  assert.ok(
    requests.some(
      (r) => r.url.endsWith("/points/query") && r.method === "POST",
    ),
  );
  await index.removeKnowledgeSource(b.id, s.id);
  assert.equal((await store.listKnowledgeSources(b.id)).length, 0);
  assert.ok([...collections.values()].every((points) => points.length === 0));
  await index.deleteKnowledgeBase(b.id);
  assert.equal(collections.size, 0);
});
test("fontes bloqueiam rede privada e URLs com credenciais", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.2.3.4",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "[::ffff:10.0.0.1]",
    "::ffff:7f00:1",
    "fd00::1",
  ])
    assert.equal(privateKnowledgeAddress(ip), true, ip);
  // Public IPv4 must not match the IPv4-mapped IPv6 rule.
  for (const ip of ["185.199.109.133", "8.8.8.8", "1.1.1.1", "::ffff:8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(privateKnowledgeAddress(ip), false, ip);
  await assert.rejects(() => knowledgeFetch(url), /público/);
  await assert.rejects(
    () => knowledgeFetch("https://user:password@example.com"),
    /credenciais/,
  );
  await assert.rejects(() => knowledgeFetch("file:///etc/passwd"), /HTTP/);
});
test("servidores locais de embeddings aceitam localhost com resolução IPv4 e IPv6", async () => {
  const vectors = await index.embedKnowledge({ provider: "openai", model: "test", apiKey: "local-key", url: url.replace("127.0.0.1", "localhost") + "/v1" }, ["reembolso"]);
  assert.deepEqual(vectors, [[1, 0, 0.1]]);
});
test("Agente consulta a base com e sem referências e preserva vínculo no fluxo", async () => {
  const { createFlow, saveFlow, getFlow } = await import("./flow-service");
  const { template } = await import("./flow-types");
  const { startRun } = await import("./flow-runtime");
  const { chatGPT } = await import("./chatgpt");
  const b = (await base());
  const s = (await source(b.id, "Reembolso em sete dias.", "Política de reembolso"));
  await index.processKnowledgeSource(b.id, s.id);
  await index.indexKnowledge(b.id);
  chatGPT().account = async () => ({
    account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
    login: null,
    error: null,
  });
  let prompt = "";
  chatGPT().run = async (options) => {
    assert.equal(options.tools?.length, 1);
    const result = await options.tools![0].call({consulta:"Qual o prazo do reembolso?"});
    prompt = options.prompt + result;
    return "Você tem sete dias para pedir reembolso.";
  };
  const graph = template();
  graph.nodes[1].data.config.knowledgeBase = b.id;
  graph.nodes[1].data.config.knowledgeReferences = "true";
  const flow = (await createFlow("Com conhecimento"));
  (await saveFlow(flow.id, { name: flow.name, description: "", graph }));
  const run = await startRun(flow.id, "Qual o prazo do reembolso?");
  assert.equal(run.status, "completed");
  assert.match(prompt, /Reembolso em sete dias/);
  assert.match(run.output, /Referências encontradas/);
  assert.match(run.output, /Política de reembolso/);
  await assert.rejects(() => index.deleteKnowledgeBase(b.id), /vinculada/);
  graph.nodes[1].data.config.knowledgeReferences = "false";
  (await saveFlow(flow.id, { name: flow.name, description: "", graph }));
  const without = await startRun(flow.id, "Qual o prazo do reembolso?");
  assert.equal(without.output, "Você tem sete dias para pedir reembolso.");
  assert.doesNotMatch(prompt, /Política de reembolso/);
  assert.equal(
    (await getFlow(flow.id)).published?.nodes[1].data.config.knowledgeBase,
    b.id,
  );
});
test("extrai arquivos Office e PDF reais", async () => {
  for (const name of [
    "sample.docx",
    "sample.xlsx",
    "sample.pptx",
    "sample.pdf",
  ]) {
    const docs = await loaders.parseKnowledgeFile(
      name,
      readFileSync(join(process.cwd(), "scripts/fixtures/knowledge", name)),
    );
    assert.ok(
      docs.some((d) => /Reembolso/.test(d.pageContent)),
      name,
    );
  }
});
test("serviços de extração usam autenticação, parâmetros e referências corretos", async () => {
  const calls: {
    url: string;
    options?: Parameters<typeof knowledgeFetch>[1];
  }[] = [];
  let respond: (
    url: string,
    options?: Parameters<typeof knowledgeFetch>[1],
  ) => unknown = () => ({});
  const transport = {
    json: async <T>(
      url: string,
      options?: Parameters<typeof knowledgeFetch>[1],
    ): Promise<T> => {
      calls.push({ url, options });
      return respond(url, options) as T;
    },
    bytes: async (
      url: string,
      options?: Parameters<typeof knowledgeFetch>[1],
    ) => {
      calls.push({ url, options });
      return Buffer.from(String(respond(url, options)));
    },
  };
  const run = (id: string, config: Record<string, string>) =>
    loaders.extractKnowledge(id, config, [], undefined, transport);
  respond = () => ({
    success: true,
    data: { markdown: "Reembolso em sete dias.", metadata: { title: "Ajuda" } },
  });
  assert.equal(
    (
      await run("firecrawl", {
        url: "https://example.com/help",
        token: "fire-secret",
      })
    ).documents[0].metadata.source,
    "https://example.com/help",
  );
  assert.equal(calls.at(-1)!.url, "https://api.firecrawl.dev/v2/scrape");
  assert.equal(
    calls.at(-1)!.options?.headers?.Authorization,
    "Bearer fire-secret",
  );
  respond = () =>
    JSON.stringify([
      { content: "Conteúdo Spider", url: "https://example.com/page" },
    ]);
  assert.equal(
    (
      await run("spider", {
        url: "https://example.com",
        token: "spider-secret",
        limit: "2",
      })
    ).documents[0].metadata.source,
    "https://example.com/page",
  );
  respond = () =>
    '{"content":"Primeira página","url":"https://example.com/a"}\n{"content":"Segunda página","url":"https://example.com/b"}\n';
  assert.equal(
    (
      await run("spider", {
        url: "https://example.com",
        token: "key",
        limit: "3",
      })
    ).documents.length,
    2,
  );
  respond = (url) =>
    url.includes("/datasets/")
      ? [{ text: "Texto Apify", url: "https://example.com/apify" }]
      : {
          data: {
            id: "run123",
            status: url.includes("actor-runs") ? "SUCCEEDED" : "RUNNING",
            defaultDatasetId: "data123",
          },
        };
  assert.equal(
    (await run("apify", { url: "https://example.com", token: "apify-secret" }))
      .documents[0].pageContent,
    "Texto Apify",
  );
  assert.ok(calls.some((c) => c.url.includes("actor-runs/run123")));
  respond = () => ({
    organic_results: [
      {
        title: "Política",
        link: "https://example.com/ref",
        snippet: "Prazo de sete dias",
      },
    ],
  });
  assert.match(
    (
      await run("searchapi", {
        query: "prazo reembolso",
        token: "search-secret",
      })
    ).documents[0].pageContent,
    /sete dias/,
  );
  assert.ok(calls.at(-1)!.url.includes("q=prazo%20reembolso"));
  respond = (url) =>
    url.endsWith("/repos/acme/help")
      ? { default_branch: "main" }
      : url.includes("git/trees")
        ? {
            tree: [
              { type: "blob", path: "docs/help.md" },
              { type: "blob", path: "logo.png" },
            ],
            truncated: false,
          }
        : {
            encoding: "base64",
            content: Buffer.from("Conteúdo do GitHub").toString("base64"),
          };
  const github = await run("github", {
    repository: "acme/help",
    token: "github-secret",
    path: "docs",
  });
  assert.equal(github.documents.length, 1);
  assert.equal(
    github.documents[0].metadata.source,
    "https://github.com/acme/help/blob/main/docs/help.md",
  );
  respond = () => ({
    values: [
      ["Produto", "Prazo"],
      ["Curso", "7 dias"],
    ],
  });
  const sheets = await run("google-sheets", {
    spreadsheetId: "sheet-id",
    range: "Página1!A1:B2",
    token: "google-secret",
  });
  assert.equal(sheets.documents.length, 2);
  assert.match(calls.at(-1)!.url, /values\/P%C3%A1gina1!A1%3AB2/);
  respond = (url) =>
    url.includes("/export?")
      ? "Documento Google"
      : url.includes("files?q=")
        ? {
            files: [
              {
                id: "file123",
                name: "Manual",
                mimeType: "application/vnd.google-apps.document",
              },
            ],
          }
        : {};
  const drive = await run("google-drive", {
    folderId: "folder123",
    token: "drive-secret",
  });
  assert.equal(drive.documents[0].pageContent, "Documento Google");
  assert.equal(
    drive.documents[0].metadata.source,
    "https://drive.google.com/file/d/file123/view",
  );
  respond = (url) =>
    `<html><head><title>Ajuda</title></head><body><nav>Excluir navegação</nav><main><p>${url.endsWith("/other") ? "Outra página" : "Política de reembolso"}</p><a href="/other">Detalhes</a><a href="https://other.example/">Externo</a></main><script>Segredo do script</script></body></html>`;
  const cheerio = await run("cheerio", {
    url: "https://example.com/",
    selector: "main",
    limit: "2",
  });
  assert.equal(cheerio.documents.length, 2);
  assert.doesNotMatch(cheerio.documents[0].pageContent, /script|navegação/);
  assert.equal(
    cheerio.documents[1].metadata.source,
    "https://example.com/other",
  );
});
test("S3 e S3 Directory leem objetos reais do SDK sem expor as credenciais", async (t) => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const commands: string[] = [];
  t.mock.method(
    S3Client.prototype,
    "send",
    async (command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      commands.push(command.constructor.name);
      assert.equal(command.input.Bucket, "test-bucket");
      if (command.constructor.name === "ListObjectsV2Command")
        return {
          Contents: [{ Key: "docs/manual.txt" }, { Key: "docs/" }],
          IsTruncated: true,
        };
      return {
        ContentLength: 19,
        Body: {
          transformToWebStream: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from("Texto extraído do S3"));
                controller.close();
              },
            }),
        },
      };
    },
  );
  const config = {
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "key",
    secretAccessKey: "secret",
    key: "docs/manual.txt",
    prefix: "docs/",
    limit: "1",
  };
  const single = await loaders.extractKnowledge("s3", config);
  assert.match(single.documents[0].pageContent, /extraído/);
  assert.equal(
    single.documents[0].metadata.source,
    "s3://test-bucket/docs/manual.txt",
  );
  const directory = await loaders.extractKnowledge("s3-directory", config);
  assert.equal(directory.documents.length, 1);
  assert.equal(directory.warnings.length, 1);
  assert.ok(commands.includes("ListObjectsV2Command"));
});
test("Custom Document Loader executa em sandbox, valida resultado e encerra o ambiente", async (t) => {
  const { Sandbox } = await import("@e2b/code-interpreter");
  let killed = 0,
    code = "";
  t.mock.method(Sandbox, "create", async (options: { apiKey: string }) => {
    assert.equal(options.apiKey, "e2b-secret");
    return {
      runCode: async (value: string) => {
        code = value;
        return {
          logs: {
            stdout: [
              '__KNOWLEDGE_RESULT__[{"pageContent":"Conhecimento personalizado","metadata":{"source":"meu-serviço"}}]',
            ],
          },
        };
      },
      kill: async () => {
        killed++;
      },
    };
  });
  const result = await loaders.extractKnowledge("custom", {
    token: "e2b-secret",
    input: '{"topic":"help"}',
    code: "return [{pageContent: input.topic, metadata: {}}];",
  });
  assert.equal(result.documents[0].pageContent, "Conhecimento personalizado");
  assert.equal(killed, 1);
  assert.match(code, /const input = \{"topic":"help"\}/);
  assert.doesNotMatch(code, /e2b-secret/);
});
nodeTest("rotas validam entrada, preservam multipart e não revelam chaves", async (t) => {
  const tenant = await (await import("../scripts/tenant-test-context")).createTenantTestContext(); t.after(tenant.close);
  const root = await import("../app/api/knowledge/route");
  const detail = await import("../app/api/knowledge/[id]/route");
  const sourcesRoute = await import("../app/api/knowledge/[id]/sources/route");
  const invalid = await tenant.connect(() => root.POST(
    tenant.request("/api/knowledge", { method: "POST", body: JSON.stringify({ name: "" }) }),
  ));
  assert.equal(invalid.status, 400);
  const response = await tenant.connect(() => root.POST(
    tenant.request("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({ name: "Base por API" }),
    }),
  ));
  const b = await response.json();
  const form = new FormData();
  form.set(
    "source",
    JSON.stringify({
      name: "Arquivo de texto",
      loader: "text",
      config: {},
      splitter: DEFAULT_SPLITTER,
      metadata: {},
    }),
  );
  form.append("files", new File(["Reembolso em sete dias"], "help.txt"));
  const saved = await tenant.connect(() => sourcesRoute.POST(
    tenant.request("/api/knowledge", { method: "POST", body: form }),
    { params: Promise.resolve({ id: b.id }) },
  ));
  assert.equal(saved.status, 200);
  const source = await saved.json();
  assert.deepEqual(source.fileNames, ["help.txt"]);
  await tenant.asTenant(() => import("./tenant-knowledge-index").then((m) => m.processKnowledgeSource(b.id, source.id)));
  assert.match((await tenant.asTenant(() => import("./tenant-knowledge").then(async (m) => (await m.listKnowledgeChunks(b.id)))))[0].pageContent, /sete dias/);
  const read = await tenant.connect(() => detail.GET(tenant.request("/api/knowledge"), {
    params: Promise.resolve({ id: b.id }),
  }));
  const data = await read.json();
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0].config.data, undefined);
  assert.match(read.headers.get("cache-control")!, /private, no-store/);
});
test("OpenRouter recebe os trechos e o retorno das referências permanece opcional", async (t) => {
  const { setConfig } = await import("./store");
  const { template } = await import("./flow-types");
  const { createSavedFlow } = await import("./flow-service");
  const { startRun } = await import("./flow-runtime");
  const b = (await base());
  const s = (await source(
    b.id,
    "Frete gratuito para assinantes.",
    "Manual de entrega",
  ));
  await index.processKnowledgeSource(b.id, s.id);
  await index.indexKnowledge(b.id);
  setConfig("OPENROUTER_API_KEY", "or-secret");
  let messages = "";
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      messages = String(options.body);
      const payload = JSON.parse(messages);
      if (!payload.messages.some((message: {role:string}) => message.role === "tool")) return Response.json({choices:[{finish_reason:"tool_calls",message:{content:null,tool_calls:[{id:"knowledge",type:"function",function:{name:payload.tools[0].function.name,arguments:JSON.stringify({consulta:"frete"})}}]}}]});
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "O frete é gratuito para assinantes." },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  const graph = template();
  graph.nodes[1].data.config = {
    ...graph.nodes[1].data.config,
    model: "openrouter:test",
    knowledgeBase: b.id,
    knowledgeReferences: "true",
  };
  const flow = (await createSavedFlow({
    name: "Consulta OpenRouter",
    description: "",
    graph,
  }));
  const run = await startRun(flow.id, "Como funciona o frete?");
  assert.equal(run.status, "completed");
  assert.match(messages, /Frete gratuito para assinantes/);
  assert.match(run.output, /Manual de entrega/);
  setConfig("OPENROUTER_API_KEY", null);
});
test("trocar servidor não encaminha a credencial anterior e indexação interrompida é recuperável", async () => {
  const b = (await base());
  const config = (await store.getKnowledgeBase(b.id)).config;
  await assert.rejects(
    async () =>
      (await store.updateKnowledgeBase(b.id, {
        config: {
          ...config,
          embeddings: { ...config.embeddings, url: "https://other.example/v1" },
        },
      })),
    /chave|credencial/,
  );
  assert.equal(
    (await store.indexKnowledgeConfig(b.id)).embeddings.apiKey,
    "secret-embedding",
  );
  const current = (await store.getKnowledgeBase(b.id));
  current.status = "indexing";
  (await store.saveKnowledgeBaseRecord(current));
  const recovered = (await store.getKnowledgeBase(b.id));
  assert.equal(recovered.status, "failed");
  assert.match(recovered.error!, /interrompida/);
});
