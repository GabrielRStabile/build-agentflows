import { requestApi, body } from "@/lib/flow-api";
import { builtinTools } from "@/lib/tools";
import { withToolCredential } from "@/lib/tool-credential-store";
import { resolveServiceToolkit } from "@/lib/tool-services";
import { composioOptions } from "@/lib/tool-composio";
import { FlowError } from "@/lib/flow-store";
import { toolConfig as getConfig } from "@/lib/tool-config-context";
import { replicateToolReport } from "@/lib/replicate-tool";
import { validateToolCards, readToolCards } from "@/lib/agent-tools";
export async function POST(req: Request) {
  return requestApi(req, async () => {
    const input = await body(req);
    const encoded = JSON.stringify([{ id: "options", kind: "tool", target: input.tool, credentialId: input.credentialId || undefined, params: input.params || {} }]);
    validateToolCards(encoded);
    const card = readToolCards(String(input.tool), encoded)[0];
    const tool = builtinTools().find((item) => item.id === input.tool);
    if (!tool) throw new FlowError("Escolha uma ferramenta válida.");
    return withToolCredential(card.credentialId, tool.credentialProvider, async () => {
      if (tool.name === "composio" && (input.kind === "apps" || input.kind === "accounts")) return composioOptions(input.kind, card.params?.app);
      if (tool.name === "replicate" && input.kind === "model") {
        const key = getConfig("REPLICATE_API_TOKEN");
        if (!key) throw new FlowError("Selecione a credencial da Replicate para verificar o modelo.");
        return replicateToolReport(card.params || {}, key);
      }
      return (await resolveServiceToolkit(tool.name, card.params || {}) || []).map((action) => ({ id: action.name, name: action.name, description: action.description }));
    });
  });
}
