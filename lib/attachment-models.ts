import { modelProviderId } from "./ai-providers";
import { providerModels } from "./ai-models";
import { chatGPT } from "./chatgpt";
import { listModels } from "./openrouter";
import { imageIssues, reachableAiNodes, type ModelCapability } from "./model-capabilities";
import type { Graph } from "./flow-types";
import { FlowError } from "./flow-store";
import { isMediaModel, graphMediaModels } from "./media-models";
export async function assertImageModels(graph: Graph) {
  const nodes = reachableAiNodes(graph);
  const models: ModelCapability[] = graphMediaModels(nodes.map((n) => n.data.config.model));
  try {
    if (nodes.some((n) => modelProviderId(n.data.config.model) === "chatgpt")) models.push(...await chatGPT().models());
    if (nodes.some((n) => n.data.config.model?.startsWith("openrouter:"))) models.push(...(await listModels()).map((m) => ({ id: `openrouter:${m.id}`, name: m.nome, inputModalities: m.inputModalities })));
    for (const node of nodes) {
      const provider = modelProviderId(node.data.config.model);
      if (provider !== "chatgpt" && provider !== "openrouter" && !isMediaModel(node.data.config.model)) models.push(...await providerModels(provider, node.data.config.modelCredentialId));
    }
  } catch { throw new FlowError("Não foi possível verificar os modelos para imagens. Atualize as configurações e tente novamente."); }
  const issues = imageIssues(graph, models);
  if (issues.length) throw new FlowError(`Revise os modelos antes de enviar imagens: ${issues.map((i) => `${i.label}: ${i.reason}`).join(" ")}`);
}
