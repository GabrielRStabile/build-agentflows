import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createTenantTestContext } from "../scripts/tenant-test-context";
import { block, type Graph } from "./flow-types";
import { createTenantFlow, getTenantRun } from "./tenant-flows";
import { claimJob } from "./saas-jobs";
import { runClaimedJob } from "./saas-worker";
import { salvarCampos } from "./conexoes";
import { getConfig } from "./store";
import { agendarLeitura, dispatchDueInboxes, lerCaixa, POR_LEITURA, type CaixaImap, type EstadoCaixa, type MensagemImap } from "./email-entrada";
import * as connections from "../app/api/conexoes/route";

const CONTA = "agente@empresa.com";
function mensagem(uid: number, extra: Partial<MensagemImap> = {}): MensagemImap {
  return { uid, messageId: `<m${uid}@ex.com>`, de: { endereco: "ana@cliente.com", nome: "Ana" }, assunto: `Pedido ${uid}`, respostaAutomatica: false, texto: `Texto ${uid}`, anexos: [], ...extra };
}
/** Caixa IMAP em memória: UIDs crescentes, como o servidor. */
function caixaFalsa(inicial: MensagemImap[] = [], uidValidity = "1") {
  const caixa = { mensagens: [...inicial], uidValidity, fechada: 0 };
  const imap: CaixaImap = {
    async abrir() { return { uidValidity: caixa.uidValidity, uidNext: Math.max(0, ...caixa.mensagens.map((m) => m.uid)) + 1 }; },
    // Como no IMAP, "n:*" devolve a última mensagem mesmo quando ela é anterior a n.
    async listar(desde) { const uids = caixa.mensagens.map((m) => m.uid); const novos = uids.filter((u) => u >= desde); return novos.length ? novos : uids.slice(-1); },
    async ler(uid) { return caixa.mensagens.find((m) => m.uid === uid) || null; },
    async fechar() { caixa.fechada++; },
  };
  return { caixa, imap };
}

test("primeira leitura só marca o ponto de partida: o histórico não dispara o fluxo", async () => {
  const { imap, caixa } = caixaFalsa([mensagem(1), mensagem(2)]);
  const entregues: string[] = [];
  const estado = await lerCaixa(imap, {}, "imp", CONTA, async (e) => { entregues.push(e.id); });
  assert.equal(entregues.length, 0);
  assert.equal(estado.ultimoUid, 2); assert.equal(estado.impressao, "imp"); assert.equal(caixa.fechada, 1);
  caixa.mensagens.push(mensagem(3), mensagem(4));
  const seguinte = await lerCaixa(imap, estado, "imp", CONTA, async (e) => { entregues.push(e.id); });
  assert.deepEqual(entregues, ["<m3@ex.com>", "<m4@ex.com>"]);
  assert.equal(seguinte.ultimoUid, 4); assert.equal(seguinte.recebidas, 2);
  const vazia = await lerCaixa(imap, seguinte, "imp", CONTA, async (e) => { entregues.push(e.id); });
  assert.equal(entregues.length, 2); assert.equal(vazia.ultimoUid, 4);
});

test("ignora a própria conta e resposta automática, e avança o cursor sobre elas", async () => {
  const { imap, caixa } = caixaFalsa([mensagem(1)]);
  const estado = await lerCaixa(imap, {}, "imp", CONTA, async () => undefined);
  caixa.mensagens.push(
    mensagem(2, { de: { endereco: "AGENTE@empresa.com", nome: "" } }),
    mensagem(3, { respostaAutomatica: true, assunto: "Ausente" }),
    mensagem(4, { anexos: ["proposta.pdf"] }),
  );
  const entregues: { id: string; texto: string }[] = [];
  const novo = await lerCaixa(imap, estado, "imp", CONTA, async (e) => { entregues.push({ id: e.id, texto: e.texto }); });
  assert.deepEqual(entregues.map((e) => e.id), ["<m4@ex.com>"]);
  assert.match(entregues[0].texto, /Anexos \(não lidos pelo fluxo\): proposta\.pdf/);
  assert.equal(novo.ultimoUid, 4); assert.equal(novo.ignoradas, 2);
  assert.match(novo.ultimaIgnorada!, /^Ausente: resposta automática/);
});

test("falha ao entregar para a leitura sem perder o e-mail; a próxima leitura tenta de novo", async () => {
  const { imap, caixa } = caixaFalsa([mensagem(1)]);
  const estado = await lerCaixa(imap, {}, "imp", CONTA, async () => undefined);
  caixa.mensagens.push(mensagem(2), mensagem(3));
  const { FlowError } = await import("./flow-store");
  const parada = await lerCaixa(imap, estado, "imp", CONTA, async (e) => { if (e.id === "<m3@ex.com>") throw new FlowError("Fila cheia."); });
  assert.equal(parada.ultimoUid, 2); assert.equal(parada.erro, "Fila cheia.");
  const entregues: string[] = [];
  const retomada = await lerCaixa(imap, parada, "imp", CONTA, async (e) => { entregues.push(e.id); });
  assert.deepEqual(entregues, ["<m3@ex.com>"]); assert.equal(retomada.ultimoUid, 3); assert.equal(retomada.erro, undefined);
});

test("trocar a caixa ou o UIDVALIDITY recomeça do ponto atual, e cada leitura entrega no máximo o lote", async () => {
  const { imap, caixa } = caixaFalsa([mensagem(1)]);
  const estado = await lerCaixa(imap, {}, "imp", CONTA, async () => undefined);
  caixa.mensagens.push(...Array.from({ length: POR_LEITURA + 3 }, (_, i) => mensagem(i + 2)));
  let entregues = 0;
  const lote = await lerCaixa(imap, estado, "imp", CONTA, async () => { entregues++; });
  assert.equal(entregues, POR_LEITURA); assert.equal(lote.ultimoUid, POR_LEITURA + 1);
  const outraCaixa = await lerCaixa(imap, lote, "outra", CONTA, async () => { entregues++; });
  assert.equal(entregues, POR_LEITURA); assert.equal(outraCaixa.ultimoUid, POR_LEITURA + 4);
  caixa.uidValidity = "2";
  const recriada = await lerCaixa(imap, outraCaixa, "outra", CONTA, async () => { entregues++; });
  assert.equal(entregues, POR_LEITURA); assert.equal(recriada.uidValidity, "2");
});

function graph(): Graph {
  const start = block("start", "start", 0, 0), end = block("end", "end", 200, 0);
  start.data.config.state = JSON.stringify({ email_remetente: "", email_nome: "", email_assunto: "" });
  end.data.config.text = "{{fluxo.email_nome}} <{{fluxo.email_remetente}}> · {{fluxo.email_assunto}}\n{{input}}";
  return { nodes: [start, end], edges: [{ id: "1", source: "start", target: "end" }] };
}
async function setup(t: TestContext) {
  const x = await createTenantTestContext(); t.after(x.close);
  const flow = await x.asTenant(async () => {
    const created = await createTenantFlow("Triagem", false, { name: "Triagem", description: "", graph: graph() });
    salvarCampos({ EMAIL_IMAP_HOST: "imap.exemplo.com", EMAIL_IMAP_USUARIO: CONTA, EMAIL_IMAP_SENHA: "abcd efgh ijkl mnop", EMAIL_FLOW_ID: created.id });
    return created;
  });
  await agendarLeitura(x.db, x.owner);
  const { caixa, imap } = caixaFalsa([mensagem(1)]);
  const ler = async () => imap;
  const passa = async () => { await x.db.query("UPDATE email_inboxes SET next_poll_at=now()-interval '1 second'"); return dispatchDueInboxes(x.db, ler); };
  const drain = async () => { for (let job = await claimJob(x.db); job; job = await claimJob(x.db)) await runClaimedJob(x.db, job); };
  const runs = async () => x.asTenant(async () => Promise.all((await x.db.query<{ run_id: string }>("SELECT run_id FROM channel_events WHERE channel='email' ORDER BY created_at")).rows.map((r) => getTenantRun(r.run_id))));
  return { ...x, flow, caixa, passa, drain, runs };
}

test("worker: cada e-mail novo vira execução com as variáveis do Início, deduplicada e com conversa por remetente", async (t) => {
  const x = await setup(t);
  assert.equal(await x.passa(), 1);
  assert.equal((await x.runs()).length, 0);
  x.caixa.mensagens.push(mensagem(2), mensagem(3, { de: { endereco: "bruno@outro.com", nome: "Bruno" } }));
  await x.passa(); await x.drain();
  let runs = await x.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].flowId, x.flow.id); assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].output, "Ana <ana@cliente.com> · Pedido 2\nDe: Ana <ana@cliente.com>\nAssunto: Pedido 2\n\nTexto 2");
  assert.notEqual(runs[0].session, runs[1].session);
  assert.ok(runs[0].session?.startsWith("email:") && !runs[0].session.includes("ana@"));
  // A mesma mensagem entregue de novo (Message-ID repetido em outro UID) não cria outra execução.
  x.caixa.mensagens.push(mensagem(4, { messageId: "<m2@ex.com>" }), mensagem(5, { texto: "Segunda da Ana" }));
  await x.passa(); await x.drain();
  runs = await x.runs();
  assert.equal(runs.length, 3);
  assert.equal(runs[2].session, runs[0].session);
  assert.equal(runs[2].conversation?.length, 1);
  const { rows } = await x.db.query<{ body: EstadoCaixa }>("SELECT body FROM email_inboxes");
  assert.equal(rows[0].body.ultimoUid, 5); assert.equal(rows[0].body.recebidas, 3);
});

test("fluxo que não declara as variáveis não guarda o remetente; desvincular tira a caixa da fila", async (t) => {
  const x = await setup(t);
  await x.asTenant(async () => {
    const g = graph(); g.nodes[0].data.config.state = "{}"; g.nodes[1].data.config.text = "{{input}}";
    const outro = await createTenantFlow("Sem variáveis", false, { name: "Sem variáveis", description: "", graph: g });
    salvarCampos({ EMAIL_FLOW_ID: outro.id });
  });
  await x.passa();
  x.caixa.mensagens.push(mensagem(2));
  await x.passa(); await x.drain();
  const [run] = await x.runs();
  assert.equal(run.email, undefined); assert.equal(run.state.email_remetente, undefined);
  const put = await x.connect(() => connections.PUT(x.request("/api/conexoes", { method: "PUT", body: JSON.stringify({ campos: { EMAIL_FLOW_ID: null } }) })));
  assert.equal(put.status, 200);
  assert.equal(await x.asTenant(() => getConfig("EMAIL_FLOW_ID")), undefined);
  await x.passa();
  assert.equal((await x.db.query("SELECT 1 FROM email_inboxes")).rows.length, 0);
});

test("a rota recusa fluxo de outra conta e a situação aparece em Conexões", async (t) => {
  const x = await setup(t);
  const recusa = await x.connect(() => connections.PUT(x.request("/api/conexoes", { method: "PUT", body: JSON.stringify({ campos: { EMAIL_FLOW_ID: "nao-existe" } }) })));
  assert.equal(recusa.status, 404);
  await x.passa();
  const status = await (await x.connect(() => connections.GET(x.request("/api/conexoes")))).json();
  assert.equal(status.email.fluxo, x.flow.id); assert.equal(status.email.configurado, true);
  assert.equal(status.email.situacao.recebidas, 0); assert.ok(status.email.situacao.lidaEm);
  assert.ok(!JSON.stringify(status).includes("abcd efgh"));
});
