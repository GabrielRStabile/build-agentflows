import { DEFAULT_SYSTEM } from "./flow-types";

// Shared, public metadata only. API credentials never belong in the model catalogue.
export const MEDIA_PROVIDERS = [
  { id: "replicate", name: "Replicate", key: "REPLICATE_API_TOKEN" },
  { id: "higgsfield", name: "Higgsfield", key: "HIGGSFIELD_API_KEY" },
  { id: "muapi", name: "MuAPI", key: "MUAPI_API_KEY" },
] as const;
export type MediaProvider = typeof MEDIA_PROVIDERS[number]["id"];
export type MediaModel = { id: string; name: string; provider: MediaProvider; path: string; inputModalities: string[]; open?: boolean };
// Fixed catalogue. Replicate is open: any public model named owner/model, described by its own schema.
export const MEDIA_MODELS: MediaModel[] = [
  { id: "higgsfield:higgsfield-ai/soul/v2/standard", name: "Soul 2", provider: "higgsfield", path: "higgsfield-ai/soul/v2/standard", inputModalities: ["text"] },
  { id: "muapi:nano-banana-2", name: "Nano Banana 2", provider: "muapi", path: "nano-banana-2", inputModalities: ["text"] },
];
// Video models commonly take 4-5 minutes. The worker still stops any job after 15 minutes.
export const MEDIA_RUN_MS = 10 * 60_000;
export const isMediaModel = (id?: string) => MEDIA_PROVIDERS.some((provider) => id?.startsWith(provider.id + ":"));
export const REPLICATE_PREFIX = "replicate:";
export const REPLICATE_MODEL = /^[a-z0-9](?:[a-z0-9._-]{0,63})\/[a-z0-9](?:[a-z0-9._-]{0,127})$/;
export const replicateModelName = (id?: string) => id?.startsWith(REPLICATE_PREFIX) ? id.slice(REPLICATE_PREFIX.length) : undefined;
export function mediaModel(id?: string): MediaModel | undefined {
  const fixed = MEDIA_MODELS.find((model) => model.id === id);
  if (fixed) return fixed;
  const path = replicateModelName(id);
  // Image input support is confirmed by the model schema before any submission.
  if (path && REPLICATE_MODEL.test(path)) return { id: id!, name: path, provider: "replicate", path, inputModalities: ["text", "image"], open: true };
}
export function validateMediaConfig(config: Record<string, string>) {
  if (!isMediaModel(config.model)) return;
  if (replicateModelName(config.model) !== undefined && !mediaModel(config.model))
    throw new Error("Informe o modelo da Replicate no formato empresa/modelo, em letras minúsculas. Ex.: google/nano-banana.");
  if (!mediaModel(config.model)) throw new Error("Escolha um modelo de imagens disponível no catálogo.");
  if (config.tools?.trim())
    throw new Error("Modelos de mídia não consultam ferramentas. Use um bloco de texto anterior para preparar a descrição da imagem.");
}
// Open Replicate models referenced by a graph; their image input is confirmed against the model schema.
export const graphMediaModels = (models: (string | undefined)[]) =>
  [...MEDIA_MODELS, ...models.flatMap((id) => { const model = mediaModel(id); return model?.open ? [model] : []; })];
// Media blocks take a single PROMPT (stored in system): text in, image or video out.
// Message, memory and knowledge bases set before choosing the model are ignored.
export const MEDIA_PROMPT = "{{input}}";
export function mediaPrompt(config: Record<string, string>) {
  const prompt = config.system?.trim();
  return prompt && prompt !== DEFAULT_SYSTEM ? config.system : MEDIA_PROMPT;
}
