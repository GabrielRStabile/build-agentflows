import { saveAttachment } from "./attachment-service";
import { type Ferramenta, integrationExecutionLimit } from "./mcp";
import { listTenantFlows, getTenantRun } from "./tenant-flows";
import { enqueueRun, enqueueResume } from "./saas-jobs";
import { notifyJob } from "./saas-queue";
import { FlowError } from "./flow-store";
import type { Run } from "./flow-types";

export const NOME_SERVIDOR = "build-agentflows";
export function executionSummary(r: Run) {
  return { id: r.id, status: r.status, queued: !!r.queued, output: r.output, error: r.error, demo: r.demo, version: r.version };
}
export function integrationId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new FlowError("Identificador inválido.");
  return value;
}
export async function enqueueIntegrationRun(id: unknown, input: unknown, files: File[] = []) {
  const flowId = integrationId(id);
  await integrationExecutionLimit();
  if (typeof input !== "string" || !input.trim()) throw new FlowError("Envie o campo input com a mensagem para o fluxo.");
  // Arquivos do multipart viram anexos privados do fluxo e seguem as mesmas regras do chat de teste.
  const attachments: string[] = [];
  for (const file of files) attachments.push((await saveAttachment(flowId, file)).id);
  const { run, job } = await enqueueRun(flowId, input, true, undefined, attachments);
  await notifyJob(job.id);
  return executionSummary(run);
}
export const FERRAMENTAS: Ferramenta[] = [
  {
    nome: "listar_fluxos", descricao: "Lista os fluxos publicados desta conta disponíveis para integração.",
    schema: { type: "object", properties: {} },
    executar: async () => (await listTenantFlows()).filter(f => f.published).map(f => ({ id: f.id, name: f.name, description: f.description, version: f.version })),
  },
  {
    nome: "executar_fluxo", descricao: "Enfileira um fluxo publicado. Retorna id e queued; acompanhe com consultar_execucao. Pode aguardar aprovação humana. Não repita uma chamada cujo resultado seja incerto.",
    schema: { type: "object", properties: { id: { type: "string" }, input: { type: "string" } }, required: ["id", "input"] },
    executar: a => enqueueIntegrationRun(a.id, a.input),
  },
  {
    nome: "consultar_execucao", descricao: "Consulta resultado e etapas de uma execução desta conta, incluindo tarefas na fila.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    executar: async a => { const run = await getTenantRun(integrationId(a.id)); return { ...executionSummary(run), trace: run.trace }; },
  },
  {
    nome: "responder_aprovacao", descricao: "Enfileira a continuação de uma execução aguardando decisão humana explicitamente autorizada: yes aprova, no rejeita.",
    schema: { type: "object", properties: { id: { type: "string" }, decision: { type: "string", enum: ["yes", "no"] } }, required: ["id", "decision"] },
    executar: async a => {
      const id = integrationId(a.id);
      await integrationExecutionLimit();
      const { run, job } = await enqueueResume(id, a.decision);
      await notifyJob(job.id);
      return executionSummary(run);
    },
  },
];
