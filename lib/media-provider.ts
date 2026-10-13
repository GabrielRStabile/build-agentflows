import { setTimeout as delay } from "node:timers/promises";
import { FlowError } from "./flow-store";
import { mediaModel, MEDIA_RUN_MS, type MediaProvider } from "./media-models";
import { knowledgeFetch } from "./knowledge-http";
import { MAX_FILE_BYTES } from "./attachment-types";

export type MediaRequest = { provider: MediaProvider; model: string; requestId: string; status: string };
type Json = Record<string, unknown>;
const origins = { replicate: "https://api.replicate.com", higgsfield: "https://api.higgsfield.ai", muapi: "https://api.muapi.ai" };
const pending = new Set(["starting", "processing", "queued", "pending", "in_progress"]);
const succeeded = new Set(["succeeded", "completed"]);

class ProviderStatus extends FlowError {
  code: number;
  constructor(code: number) { super(`O provedor de mídia respondeu com erro ${code}. Confira a chave, o saldo e o modelo.`, 502); this.code = code; }
}
async function readJson(response: Response): Promise<Json> {
  // Do not relay provider error bodies: they may echo credentials, prompts or signed URLs.
  if (!response.ok) { await response.body?.cancel(); throw new ProviderStatus(response.status); }
  const reader = response.body?.getReader();
  if (!reader) throw new FlowError("O provedor de mídia retornou uma resposta vazia.", 502);
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new FlowError("A resposta do provedor excedeu o limite permitido.", 502);
      parts.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Json;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof FlowError) throw error;
    throw new FlowError("O provedor de mídia retornou uma resposta inválida.", 502);
  } finally { reader.releaseLock(); }
}
export function mediaOutputUrl(value: unknown) {
  try {
    if (typeof value !== "string" || value.length > 8192) throw new Error();
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new Error();
    return url;
  } catch { throw new FlowError("O provedor retornou um endereço de arquivo inválido.", 502); }
}
type Schema = { type?: string; format?: string; enum?: unknown[]; items?: Schema; "x-cog-array-display"?: string; properties?: Record<string, Schema> };
export type ReplicateSchema = { version?: string; input?: Record<string, Schema>; output?: Schema };
export type MediaResult = { text: string; files?: undefined } | { files: Buffer[]; text?: undefined };
const PROMPT_FIELDS = ["prompt", "text", "input", "message", "question"];
// Common names used by Replicate models for reference images, most specific first.
const IMAGE_FIELDS = ["image_input", "input_images", "images", "reference_images", "image", "input_image", "image_url", "start_image", "first_frame_image"];
const isUri = (schema?: Schema) => schema?.format === "uri" || schema?.items?.format === "uri";
export function replicateSchema(model: Json): ReplicateSchema {
  const latest = model.latest_version as Json | null | undefined;
  const schemas = ((latest?.openapi_schema as Json | undefined)?.components as Json | undefined)?.schemas as Record<string, Schema> | undefined;
  return { version: typeof latest?.id === "string" && /^[a-f0-9]{64}$/.test(latest.id) ? latest.id : undefined, input: schemas?.Input?.properties, output: schemas?.Output };
}
// What a model accepts, from its declared input: the text field and, when present, a reference-image field.
export function replicateCapabilities(schema: ReplicateSchema) {
  const fields = schema.input;
  const promptField = fields ? PROMPT_FIELDS.find((field) => fields[field]?.type === "string" || (fields[field] && !fields[field].type)) : undefined;
  const imageField = fields ? IMAGE_FIELDS.find((name) => fields[name] && (fields[name].type === "array" || isUri(fields[name]))) : undefined;
  return { promptField, imageField, multipleImages: !!imageField && fields![imageField].type === "array" };
}
// Reading a model is free: it confirms the name and its inputs before any charge.
export async function readReplicateModel(path: string, key: string, fetcher: typeof globalThis.fetch = globalThis.fetch, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetcher(`${origins.replicate}/v1/models/${path}`, { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  } catch { signal?.throwIfAborted(); throw new FlowError("Não foi possível consultar a Replicate agora. Tente novamente.", 502); }
  if (response.status === 404) { await response.body?.cancel(); throw new FlowError(`O modelo ${path} não foi encontrado na Replicate. Confira o nome no formato empresa/modelo.`); }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new FlowError("A Replicate recusou a chave. Confira a credencial selecionada."); }
  return replicateSchema(await readJson(response));
}
// Builds the input from the fields the model declares. Unknown models only receive a prompt.
export function replicateInput(name: string, schema: ReplicateSchema, prompt: string, instructions: string, images: string[]) {
  const fields = schema.input;
  const promptField = fields ? PROMPT_FIELDS.find((field) => fields[field]?.type === "string" || (fields[field] && !fields[field].type)) : "prompt";
  if (!promptField) throw new FlowError(`O modelo ${name} não recebe uma descrição em texto. Escolha um modelo com o campo prompt.`);
  const system = fields?.system_prompt && instructions ? instructions : "";
  const input: Json = { [promptField]: [system ? "" : instructions, prompt].filter(Boolean).join("\n\n") };
  if (system) input.system_prompt = system;
  if (images.length) {
    const field = fields && IMAGE_FIELDS.find((name) => fields[name] && (fields[name].type === "array" || isUri(fields[name])));
    if (!field) throw new FlowError(fields ? `O modelo ${name} não recebe imagens de entrada. Remova os anexos ou escolha outro modelo.` : `Não foi possível confirmar se ${name} recebe imagens. Remova os anexos ou escolha outro modelo.`);
    if (fields![field].type !== "array" && images.length > 1) throw new FlowError(`O modelo ${name} recebe apenas uma imagem de entrada.`);
    input[field] = fields![field].type === "array" ? images : images[0];
  }
  if (fields?.output_format?.enum?.includes("png")) input.output_format = "png";
  return input;
}
// Text models stream token arrays; image and video models return file URLs.
export function replicateOutput(output: unknown, schema?: Schema): { text: string } | { urls: unknown[] } {
  const list = Array.isArray(output) ? output : [output];
  const files = schema ? isUri(schema) : list.length > 0 && list.every((item) => typeof item === "string" && /^https:\/\//.test(item));
  if (files) return { urls: list };
  if (output === null || output === undefined || output === "") throw new FlowError("O modelo não retornou resultado. Consulte a solicitação em seu painel.", 502);
  if (typeof output === "string") return { text: output };
  if (list.every((item) => typeof item === "string")) return { text: list.join(schema?.["x-cog-array-display"] === "concatenate" || !schema ? "" : "\n") };
  return { text: "```json\n" + JSON.stringify(output, null, 2) + "\n```" };
}
export async function generateMedia(options: {
  model: string; key: string; prompt: string; instructions?: string; images?: string[]; signal: AbortSignal;
  onSubmitted: (request: MediaRequest) => Promise<void>;
}, dependencies: { fetch: typeof globalThis.fetch; download: typeof knowledgeFetch; pause: (signal: AbortSignal) => Promise<void> } = {
  fetch: globalThis.fetch,
  download: knowledgeFetch,
  pause: (signal: AbortSignal) => delay(1500, undefined, { signal }),
}): Promise<MediaResult> {
  const model = mediaModel(options.model);
  if (!model) throw new FlowError("Modelo de mídia não disponível.");
  const instructions = options.instructions?.trim() || "";
  if (!options.prompt.trim() || options.prompt.length + instructions.length > 20000) throw new FlowError("A descrição deve ter entre 1 e 20 mil caracteres.");
  const images = options.images || [];
  if (images.length && !model.inputModalities.includes("image")) throw new FlowError(`${model.name} aceita apenas texto neste catálogo. Use um modelo da Replicate que receba imagens para editá-las.`);
  // Bound inline image data independently of the attachment storage quota.
  if (images.length > 5 || images.some((image) => !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) || images.reduce((total, image) => total + image.length, 0) > 8 * 1024 * 1024)
    throw new FlowError("Use até 5 imagens de referência, com até 6 MB no total.");
  const provider = model.provider, base = origins[provider];
  const headers: Record<string, string> = provider === "muapi" ? { "x-api-key": options.key } : { Authorization: `${provider === "replicate" ? "Bearer" : "Key"} ${options.key}` };
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(MEDIA_RUN_MS)]);
  const api = async (path: string, body?: unknown, requestSignal = signal) => {
    requestSignal.throwIfAborted();
    let response: Response;
    try {
      response = await dependencies.fetch(base + path, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(provider === "replicate" && body !== undefined ? { "Cancel-After": `${MEDIA_RUN_MS / 60_000}m` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([requestSignal, AbortSignal.timeout(30000)]),
      });
    } catch {
      requestSignal.throwIfAborted();
      throw new FlowError("Não foi possível confirmar a resposta do provedor. Confira a solicitação no painel antes de gerar novamente; ela pode ter sido cobrada.", 502);
    }
    return readJson(response);
  };
  const prompt = [instructions, options.prompt].filter(Boolean).join("\n\n");
  let schema: ReplicateSchema = {};
  if (provider === "replicate") {
    // Reading the model is free and happens before any charge: it rejects unknown names and incompatible inputs.
    try { schema = replicateSchema(await api(`/v1/models/${model.path}`)); }
    catch (error) {
      if (error instanceof ProviderStatus && error.code === 404) throw new FlowError(`O modelo ${model.path} não foi encontrado na Replicate. Confira o nome no formato empresa/modelo.`);
      throw error;
    }
  }
  const replicateBody = (version: string) => ({ version, input: replicateInput(model.path, schema, options.prompt, instructions, images) });
  const body = provider === "replicate" ? replicateBody(model.path)
    : provider === "higgsfield" ? { prompt, batch_size: 1 }
    : { prompt, output_format: "png", resolution: "1k" };
  const path = provider === "replicate" ? "/v1/predictions" : provider === "muapi" ? `/api/v1/${model.path}` : `/${model.path}`;
  let requestId = "", terminal = false;
  try {
    // Exactly one accepted submission. A lost response is not permission to generate and charge again.
    let result: Json;
    try { result = await api(path, body); }
    catch (error) {
      // Official models run by name; community models need their version. A 4xx rejection creates no prediction.
      if (!(provider === "replicate" && schema.version && error instanceof ProviderStatus && [404, 422].includes(error.code))) throw error;
      result = await api(path, replicateBody(`${model.path}:${schema.version}`));
    }
    const id = provider === "replicate" ? result.id : result.request_id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new FlowError("O provedor não retornou uma identificação válida. Confira seu painel antes de gerar novamente.", 502);
    requestId = id;
    await options.onSubmitted({ provider, model: model.id, requestId, status: "submitted" });
    const poll = provider === "replicate" ? `/v1/predictions/${id}` : provider === "higgsfield" ? `/requests/${id}/status` : `/api/v1/predictions/${id}/result`;
    // Ignore provider-supplied status/cancel URLs; authentication only goes to fixed API origins.
    while (true) {
      signal.throwIfAborted();
      const status = String(result.status || "queued");
      if (succeeded.has(status)) { terminal = true; break; }
      if (!pending.has(status)) {
        terminal = true;
        throw new FlowError(["canceled", "cancelled"].includes(status) ? "A geração foi cancelada pelo provedor." : status === "nsfw" ? "O provedor recusou o conteúdo por sua política." : "O provedor não concluiu a geração. Consulte a solicitação em seu painel.", 502);
      }
      await dependencies.pause(signal);
      result = await api(poll);
    }
    if (provider === "replicate") {
      const output = replicateOutput(result.output, schema.output);
      if ("text" in output) return { text: output.text };
      result = { output: output.urls };
    }
    const outputs = provider === "replicate" ? result.output
      : provider === "higgsfield" ? (Array.isArray(result.images) ? result.images.map((image: unknown) => image && typeof image === "object" ? (image as Json).url : null) : null) : result.outputs;
    if (!Array.isArray(outputs) || !outputs.length || outputs.length > 5) throw new FlowError("O provedor não retornou de 1 a 5 arquivos válidos.", 502);
    const files: Buffer[] = [];
    let total = 0;
    for (const output of outputs) {
      signal.throwIfAborted();
      const url = mediaOutputUrl(output);
      // Replicate's delivery hosts may require the token. Never attach it to other hosts.
      const authorized = provider === "replicate" && (url.hostname === "replicate.delivery" || url.hostname.endsWith(".replicate.delivery"));
      const bytes = await dependencies.download(url.href, { signal, maxBytes: MAX_FILE_BYTES, ...(authorized ? { headers } : {}) });
      total += bytes.length;
      if (total > 20 * 1024 * 1024) throw new FlowError("Os arquivos gerados excedem 20 MB.", 413);
      files.push(bytes);
    }
    return { files };
  } catch (error) {
    if (requestId && !terminal && provider !== "muapi") {
      const cancel = provider === "replicate" ? `/v1/predictions/${requestId}/cancel` : `/requests/${requestId}/cancel`;
      // Higgsfield can refuse cancellation after execution starts. MuAPI has no documented public cancellation API.
      await dependencies.fetch(base + cancel, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(5000) })
        .then((response) => response.body?.cancel()).catch(() => {});
    }
    if (signal.aborted) throw new FlowError("Geração interrompida. A tarefa pode continuar no provedor; confira seu painel antes de repetir.", 409);
    throw error;
  }
}
