export type KnowledgeField = {
  key: string;
  label: string;
  type?: "secret" | "text" | "number" | "textarea";
  required?: boolean;
  placeholder?: string;
  help?: string;
};
export type LoaderDefinition = {
  id: string;
  name: string;
  description: string;
  accept?: string;
  fields: KnowledgeField[];
};
export type Document = {
  pageContent: string;
  metadata: Record<string, unknown>;
};
export type Chunk = Document & {
  id: string;
  sourceId: string;
  ordinal: number;
};
export type SplitterConfig = {
  kind: "recursive" | "character";
  size: number;
  overlap: number;
  separator: string;
};
export type KnowledgeSource = {
  id: string;
  baseId: string;
  name: string;
  loader: string;
  config: Record<string, string>;
  configuredSecrets: string[];
  fileNames: string[];
  /** Bytes of the uploaded files; absent in sources saved before storage was counted. */
  fileBytes?: number;
  splitter: SplitterConfig;
  metadata: Record<string, unknown>;
  status: "draft" | "processing" | "processed" | "failed";
  chunks: number;
  characters: number;
  updatedAt: string;
  error?: string;
};
export type PostgresConnection = {
  host: string;
  database: string;
  port: number;
  ssl: boolean;
  credentialId: string;
  connectionTimeout?: number;
  queryTimeout?: number;
};
export type RetrievalConfig = {
  topK: number;
  minScore: number;
  metadataFilter?: Record<string, unknown> | string;
  distanceStrategy?: "cosine" | "euclidean" | "innerProduct";
};
export type IndexConfig = {
  retrieval?: RetrievalConfig;
  embeddings: {
    provider: "openai" | "ollama" | "gemini" | "voyage";
    model: string;
    url: string;
    credentialId?: string;
    apiKey?: string;
    configured?: boolean;
    batchSize?: number;
    timeout?: number;
    stripNewLines?: boolean;
    dimensions?: number;
    encodingFormat?: "float" | "base64";
  };
  vectorStore: {
    provider:
      | "local"
      | "qdrant"
      | "chroma"
      | "elasticsearch"
      | "faiss"
      | "mongodb"
      | "pinecone"
      | "postgres"
      | "weaviate"
      | "supabase"
      | "singlestore"
      | "opensearch";
    url: string;
    apiKey?: string;
    configured?: boolean;
    connectionString?: string;
    connectionConfigured?: boolean;
    postgres?: PostgresConnection;
    options?: Record<string, string>;
  };
  recordManager: {
    provider: "none" | "internal" | "postgres";
    cleanup?: "none" | "incremental" | "full";
    sourceIdKey?: string;
    connectionString?: string;
    configured?: boolean;
    namespace?: string;
    tableName?: string;
    postgres?: PostgresConnection;
  };
};
export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  status: "empty" | "dirty" | "indexing" | "ready" | "failed";
  revision: number;
  indexedRevision?: number;
  sources: number;
  chunks: number;
  indexedChunks: number;
  config: IndexConfig;
  updatedAt: string;
  indexedAt?: string;
  error?: string;
};
export type IndexRun = {
  id: string;
  baseId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed";
  total: number;
  embedded: number;
  reused: number;
  error?: string;
};
export type KnowledgeHit = Chunk & {
  score: number;
  baseId: string;
  baseName: string;
  sourceName: string;
};
export const DEFAULT_SPLITTER: SplitterConfig = {
  kind: "recursive",
  size: 1000,
  overlap: 200,
  separator: "\n\n",
};
export const DEFAULT_INDEX: IndexConfig = {
  retrieval: { topK: 4, minScore: 0, distanceStrategy: "cosine" },
  embeddings: {
    provider: "openai",
    model: "text-embedding-3-small",
    url: "https://api.openai.com/v1",
  },
  vectorStore: { provider: "faiss", url: "" },
  recordManager: { provider: "internal" },
};
export const KNOWLEDGE_STATUS: Record<KnowledgeBase["status"], string> = {
  empty: "Sem documentos",
  dirty: "Indexação pendente",
  indexing: "Indexando",
  ready: "Disponível",
  failed: "Precisa de atenção",
};
