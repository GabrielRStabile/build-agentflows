import sharp from "sharp";
import { attachmentContext, saveAttachment } from "./attachment-service";
import { modelCredentialKey } from "./ai-credentials";
import { mediaModel, validateMediaConfig } from "./media-models";
import { generateMedia } from "./media-provider";
import { videoFormat } from "./attachments";
import { memoryPrompt } from "./flow-memory";
import { FlowError, putRun } from "./flow-service";
import type { Block, Run, Trace } from "./flow-types";

export async function runMedia(n: Block, run: Run, prompt: string, instructions: string, signal: AbortSignal, details: Partial<Trace>, generate = generateMedia) {
  const config = n.data.config;
  validateMediaConfig(config);
  const model = mediaModel(config.model)!;
  const key = modelCredentialKey(model.provider, config.modelCredentialId);
  // Generated files remain private attachments. They are not published as provider URLs.
  const context = await attachmentContext(run.flowId, run.attachments);
  const message = await memoryPrompt(run, config, prompt, async () => { throw new FlowError("Este modelo não resume a memória."); });
  details.input = message;
  const text = [message, context.text].filter(Boolean).join("\n\n");
  details.instructions = instructions;
  let submission: NonNullable<Run["mediaRequests"]>[number] | undefined;
  try {
    const result = await generate({
      // When the instructions already cite the message, they are the whole description.
      model: model.id, key, prompt: text || instructions, instructions: text ? instructions : "", images: context.images, signal,
      onSubmitted: async (request) => {
        submission = { ...request, nodeId: n.id, at: new Date().toISOString() };
        (run.mediaRequests ||= []).push(submission);
        await putRun(run);
      },
    });
    if (result.text !== undefined) {
      if (submission) submission.status = "saved";
      return result.text;
    }
    const images = [];
    for (const [index, bytes] of result.files.entries()) {
      signal.throwIfAborted();
      const video = videoFormat(bytes);
      let format: string | undefined = video;
      if (!video) try { format = (await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata()).format; } catch { /* validated below */ }
      if (!format || !["png", "jpeg", "webp", "mp4", "webm"].includes(format)) throw new FlowError("O provedor não retornou uma imagem PNG, JPG ou WebP nem um vídeo MP4 ou WebM válido.", 502);
      const name = `${video ? "video" : "imagem"}-${index + 1}.${format}`;
      images.push(await saveAttachment(run.flowId, new File([new Uint8Array(bytes)], name, { type: `${video ? "video" : "image"}/${format}` }), true, true));
    }
    details.images = images;
    if (submission) submission.status = "saved";
    // The "video" title tells the chat to play the private attachment instead of showing an image.
    return images.map((file, index) => file.kind === "video" ? `![Vídeo gerado ${index + 1}](/api/attachments/${file.id} "video")` : `![Imagem gerada ${index + 1}](/api/attachments/${file.id})`).join("\n\n");
  } catch (error) {
    if (submission) submission.status = signal.aborted ? "interrupted" : "failed";
    throw error;
  }
}
