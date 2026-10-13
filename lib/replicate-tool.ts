import { AsyncLocalStorage } from "node:async_hooks";
import { attachmentContext } from "./attachment-service";
import { FlowError, putRun } from "./flow-service";
import { REPLICATE_MODEL, REPLICATE_PREFIX } from "./media-models";
import { generateMedia, readReplicateModel, replicateCapabilities } from "./media-provider";
import { saveMediaFiles } from "./media-runtime";
import type { AgentTool } from "./chatgpt";
import type { Run, Trace } from "./flow-types";
import type { Attachment } from "./attachment-types";

export const REPLICATE_TOOL = "replicate";
// The agent step runs each tool call inside this scope, so the tool can save files and evidence on its trace.
export const toolRunScope = new AsyncLocalStorage<{ run: Run; nodeId: string; signal: AbortSignal; trace: Trace }>();

export function replicateToolModel(params: Record<string, string>) {
  const path = (params.model || "").trim();
  if (!path) throw new FlowError("Informe o modelo da Replicate nos parâmetros da ferramenta.");
  if (!REPLICATE_MODEL.test(path)) throw new FlowError("Informe o modelo da Replicate no formato empresa/modelo, em letras minúsculas. Ex.: google/nano-banana.");
  return path;
}
// What the Agent screen shows: whether the chosen model accepts reference images.
export async function replicateToolReport(params: Record<string, string>, key: string, fetcher?: typeof fetch) {
  const path = replicateToolModel(params);
  const capabilities = replicateCapabilities(await readReplicateModel(path, key, fetcher));
  if (!capabilities.promptField) throw new FlowError(`O modelo ${path} não recebe uma descrição em texto. Escolha um modelo com o campo prompt.`);
  return { model: path, ...capabilities };
}
// Most recent first: images generated earlier in this run, then the ones the person attached.
function referenceImages(run: Run, limit: number): Attachment[] {
  const generated = run.trace.flatMap((trace) => trace.images || []).filter((file) => file.kind === "image").reverse();
  const attached = (run.attachments || []).filter((file) => file.kind === "image");
  return [...generated, ...attached].filter((file, index, all) => all.findIndex((other) => other.id === file.id) === index).slice(0, limit);
}
export async function replicateAgentTool(params: Record<string, string>, key: string, fetcher?: typeof fetch, generate = generateMedia): Promise<AgentTool> {
  const report = await replicateToolReport(params, key, fetcher);
  const accepts = !!report.imageField;
  return {
    name: REPLICATE_TOOL,
    description: (params.description?.trim() ? params.description.trim() + " " : "") +
      `Gera imagem ou vídeo com o modelo ${report.model} da Replicate a partir de uma descrição detalhada em texto. ` +
      (accepts ? `Para editar ou manter a consistência, use usar_imagens=true: envia como referência ${report.multipleImages ? "até 5 imagens" : "1 imagem"} (as geradas antes nesta execução e as anexadas pela pessoa, das mais recentes para as mais antigas). `
        : "Este modelo recebe apenas texto e não aceita imagens de referência. ") +
      "O arquivo gerado aparece automaticamente para a pessoa abaixo da sua resposta: não inclua links nem markdown dele.",
    schema: { type: "object", properties: {
      descricao: { type: "string", description: "Descrição detalhada do que gerar." },
      ...(accepts ? { usar_imagens: { type: "boolean", description: "Enviar as imagens disponíveis como referência." } } : {}),
    }, required: ["descricao"] },
    call: async (args) => {
      const scope = toolRunScope.getStore();
      if (!scope) throw new FlowError("Use esta ferramenta em um bloco Agente.");
      const input = (args || {}) as { descricao?: unknown; usar_imagens?: unknown };
      const prompt = String(input.descricao ?? "").trim();
      if (!prompt) throw new FlowError("Informe a descrição do que gerar.");
      let images: string[] = [];
      if (input.usar_imagens === true) {
        if (!accepts) throw new FlowError(`O modelo ${report.model} não aceita imagens de referência.`);
        const files = referenceImages(scope.run, report.multipleImages ? 5 : 1);
        if (!files.length) throw new FlowError("Não há imagens disponíveis nesta conversa para usar como referência.");
        images = (await attachmentContext(scope.run.flowId, files)).images;
      }
      const { run, trace, signal } = scope;
      trace.input = JSON.stringify({ descricao: prompt, ...(images.length ? { imagens_de_referencia: images.length } : {}) }, null, 2);
      let submission: NonNullable<Run["mediaRequests"]>[number] | undefined;
      try {
        const result = await generate({
          model: REPLICATE_PREFIX + report.model, key, prompt, images, signal,
          onSubmitted: async (request) => {
            submission = { ...request, nodeId: scope.nodeId, at: new Date().toISOString() };
            (run.mediaRequests ||= []).push(submission);
            (trace.media ||= []).push({ provider: request.provider, model: request.model, requestId: request.requestId });
            await putRun(run);
          },
        });
        if (result.text !== undefined) { if (submission) submission.status = "saved"; return result.text; }
        const saved = await saveMediaFiles(run.flowId, result.files, signal);
        trace.images = saved.files;
        if (submission) submission.status = "saved";
        const videos = saved.files.filter((file) => file.kind === "video").length;
        return `Geração concluída: ${videos ? `${videos} vídeo(s)` : `${saved.files.length} imagem(ns)`}${images.length ? `, usando ${images.length} imagem(ns) de referência` : ""}. O resultado já será exibido para a pessoa.`;
      } catch (error) {
        if (submission) submission.status = signal.aborted ? "interrupted" : "failed";
        throw error;
      }
    },
  };
}
