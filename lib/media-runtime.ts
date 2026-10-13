import sharp from "sharp";
import { attachmentContext, saveAttachment } from "./attachment-service";
import { modelCredentialKey } from "./ai-credentials";
import { mediaModel, mediaPrompt, validateMediaConfig } from "./media-models";
import { generateMedia } from "./media-provider";
import { videoFormat } from "./attachments";
import { interpolate } from "./flow-references";
import { FlowError, putRun } from "./flow-service";
import type { Block, Run, Trace } from "./flow-types";
import type { Attachment } from "./attachment-types";

// Text in, image or video out: only the PROMPT describes the result. Message, memory and bases do not apply.
export async function runMedia(n: Block, run: Run, signal: AbortSignal, details: Partial<Trace>, generate = generateMedia) {
  const config = n.data.config;
  validateMediaConfig(config);
  const model = mediaModel(config.model)!;
  const key = modelCredentialKey(model.provider, config.modelCredentialId);
  // Generated files remain private attachments. They are not published as provider URLs.
  const context = await attachmentContext(run.flowId, run.attachments);
  const prompt = interpolate(mediaPrompt(config), run);
  if (!prompt.trim()) throw new FlowError("O PROMPT ficou vazio. Descreva o que será gerado ou use {{input}} com uma mensagem.");
  details.input = prompt;
  const text = [prompt, context.text].filter(Boolean).join("\n\n");
  let submission: NonNullable<Run["mediaRequests"]>[number] | undefined;
  try {
    const result = await generate({
      model: model.id, key, prompt: text, instructions: "", images: context.images, signal,
      onSubmitted: async (request) => {
        submission = { ...request, nodeId: n.id, at: new Date().toISOString() };
        (run.mediaRequests ||= []).push(submission);
        (details.media ||= []).push({ provider: request.provider, model: request.model, requestId: request.requestId });
        await putRun(run);
      },
    });
    if (result.text !== undefined) {
      if (submission) submission.status = "saved";
      return result.text;
    }
    const saved = await saveMediaFiles(run.flowId, result.files, signal);
    details.images = saved.files;
    if (submission) submission.status = "saved";
    return saved.markdown;
  } catch (error) {
    if (submission) submission.status = signal.aborted ? "interrupted" : "failed";
    throw error;
  }
}

// Generated files remain private attachments of the flow; they are not published as provider URLs.
export async function saveMediaFiles(flowId: string, files: Buffer[], signal: AbortSignal) {
  const saved = [];
  for (const [index, bytes] of files.entries()) {
    signal.throwIfAborted();
    const video = videoFormat(bytes);
    let format: string | undefined = video;
    if (!video) try { format = (await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata()).format; } catch { /* validated below */ }
    if (!format || !["png", "jpeg", "webp", "mp4", "webm"].includes(format)) throw new FlowError("O provedor não retornou uma imagem PNG, JPG ou WebP nem um vídeo MP4 ou WebM válido.", 502);
    const name = `${video ? "video" : "imagem"}-${index + 1}.${format}`;
    saved.push(await saveAttachment(flowId, new File([new Uint8Array(bytes)], name, { type: `${video ? "video" : "image"}/${format}` }), true, true));
  }
  return { files: saved, markdown: mediaMarkdown(saved) };
}
// The "video" title tells the chat to play the private attachment instead of showing an image.
export const mediaMarkdown = (files: Attachment[]) => files.map((file, index) => file.kind === "video" ? `![Vídeo gerado ${index + 1}](/api/attachments/${file.id} "video")` : `![Imagem gerada ${index + 1}](/api/attachments/${file.id})`).join("\n\n");
