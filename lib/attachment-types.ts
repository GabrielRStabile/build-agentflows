export type Attachment = { id: string; name: string; mime: string; size: number; kind: "image" | "document" | "video"; textLength?: number };
export const MAX_ATTACHMENTS = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.json,.xls,.xlsx,.docx,.pptx,.html,.htm,.css,.xml,.yaml,.yml,.sql";
export function fileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
