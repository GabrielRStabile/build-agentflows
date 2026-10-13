import { randomUUID } from "node:crypto";
import { FlowError } from "./flow-store";
import { knowledgeLoader } from "./knowledge-catalog";
import { DEFAULT_SPLITTER, type KnowledgeSource, type SplitterConfig } from "./knowledge-types";
import { validateSplitter, type SourceFile } from "./knowledge-loaders";
const MAX_CONFIG_TEXT = 2_000_000;
export function knowledgeTitle(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100)
    throw new FlowError(`${label} precisa ter de 1 a 100 caracteres.`);
  return value.trim();
}
export type SourceInput = { name: string; loader: string; config: Record<string, string>; splitter: SplitterConfig; metadata: Record<string, unknown> };
// Each file up to 10 MB; one upload up to 20 files and 20 MB (the source keeps them in one encrypted record).
export const MAX_KNOWLEDGE_FILE_BYTES = 10 * 1024 * 1024, MAX_KNOWLEDGE_UPLOAD_BYTES = 20 * 1024 * 1024;
export const KNOWLEDGE_UPLOAD_RULE = "Envie até 20 arquivos de até 10 MB cada, somando no máximo 20 MB.";
export const sourceFileBytes = (files: SourceFile[]) => files.reduce((n, f) => n + Buffer.byteLength(f.data, "base64"), 0);
export function normalizeKnowledgeSource(baseId: string, input: SourceInput, files: SourceFile[] | undefined, previous: KnowledgeSource | undefined, secrets: Record<string, string>) {
    if (previous && previous.loader !== input.loader)
      throw new FlowError("Crie outra fonte para trocar a opção de extração.");
    const loader = knowledgeLoader(input.loader);
    if (!loader) throw new FlowError("Escolha uma opção de extração.");
    if (
      !input.config ||
      typeof input.config !== "object" ||
      Array.isArray(input.config) ||
      Object.entries(input.config).some(
        ([k, v]) =>
          !loader.fields.some((f) => f.key === k) ||
          typeof v !== "string" ||
          v.length > MAX_CONFIG_TEXT,
      )
    )
      throw new FlowError("Há campos inválidos na fonte.");
    if (
      !input.metadata ||
      typeof input.metadata !== "object" ||
      Array.isArray(input.metadata) ||
      JSON.stringify(input.metadata).length > 10000
    )
      throw new FlowError("Use metadados em um objeto JSON de até 10 KB.");
    if (files && (files.length > 20 || files.some((f) => Buffer.byteLength(f.data, "base64") > MAX_KNOWLEDGE_FILE_BYTES) || sourceFileBytes(files) > MAX_KNOWLEDGE_UPLOAD_BYTES))
      throw new FlowError(KNOWLEDGE_UPLOAD_RULE, 413);
    const sourceId = previous?.id || randomUUID();
    const secretConfig = JSON.parse(secrets.config || "{}") as Record<
      string,
      string
    >;
    const publicConfig: Record<string, string> = {};
    for (const field of loader.fields) {
      const value = input.config[field.key] || "";
      if (field.type === "secret") {
        if (value.trim()) secretConfig[field.key] = value.trim();
      } else publicConfig[field.key] = value;
      if (
        field.required &&
        !(field.type === "secret" ? secretConfig[field.key] : value)?.trim()
      )
        throw new FlowError(`Preencha ${field.label}.`);
    }
    const storedFiles =
      files || (JSON.parse(secrets.files || "[]") as SourceFile[]);
    if (loader.accept && !storedFiles.length)
      throw new FlowError("Adicione os arquivos desta fonte.");
    const source: KnowledgeSource = {
      id: sourceId,
      baseId,
      name: loader.accept
        ? storedFiles[0].name
        : knowledgeTitle(input.name || loader.name, "O nome da fonte"),
      loader: loader.id,
      config: publicConfig,
      configuredSecrets: Object.keys(secretConfig),
      fileNames: storedFiles.map((f) => f.name),
      fileBytes: sourceFileBytes(storedFiles),
      splitter: validateSplitter(input.splitter || DEFAULT_SPLITTER),
      metadata: input.metadata,
      status: "draft",
      chunks: previous?.chunks || 0,
      characters: previous?.characters || 0,
      updatedAt: new Date().toISOString(),
    };
  return { source, secrets: { config: JSON.stringify(secretConfig), files: JSON.stringify(storedFiles) } };
}
