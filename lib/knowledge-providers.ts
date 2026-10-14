import type { IndexConfig } from "./knowledge-types";
export type KnowledgeChoice = {
  id: string;
  name: string;
  icon: string;
  description: string;
};
const logo = (group: string, id: string, ext = "svg") =>
  `/knowledge-icons/${group}-${id}.${ext}`;
export const EMBEDDING_PROVIDERS = [
  {
    id: "gemini",
    name: "Google Gemini Embedding",
    icon: logo("embeddings", "gemini"),
    description: "Embeddings de texto pela API do Google Gemini.",
    url: "https://generativelanguage.googleapis.com/v1beta",
    models: [
      { id: "gemini-embedding-001", dimensions: 3072 },
      { id: "gemini-embedding-2", dimensions: 3072 },
    ],
  },
  {
    id: "openai",
    name: "OpenAI Embedding",
    icon: logo("embeddings", "openai"),
    description: "Modelos de embedding da OpenAI.",
    url: "https://api.openai.com/v1",
    models: [
      { id: "text-embedding-3-small", dimensions: 1536 },
      { id: "text-embedding-3-large", dimensions: 3072 },
      { id: "text-embedding-ada-002", dimensions: 1536 },
    ],
  },
  {
    id: "voyage",
    name: "VoyageAI Embedding",
    icon: logo("embeddings", "voyage", "png"),
    description: "Modelos gerais e especializados da VoyageAI.",
    url: "https://api.voyageai.com/v1",
    models: [
      { id: "voyage-4", dimensions: 1024 },
      { id: "voyage-4-large", dimensions: 1024 },
      { id: "voyage-4-lite", dimensions: 1024 },
      { id: "voyage-code-4", dimensions: 1024 },
      { id: "voyage-3.5", dimensions: 1024 },
      { id: "voyage-3.5-lite", dimensions: 1024 },
      { id: "voyage-code-3", dimensions: 1024 },
      { id: "voyage-finance-2", dimensions: 1024 },
      { id: "voyage-law-2", dimensions: 1024 },
    ],
  },
  {
    id: "ollama",
    name: "Ollama Embedding",
    icon: logo("embeddings", "ollama"),
    description: "Modelos instalados no seu servidor Ollama.",
    url: "http://localhost:11434",
    models: [
      { id: "nomic-embed-text", dimensions: 768 },
      { id: "mxbai-embed-large", dimensions: 1024 },
      { id: "bge-m3", dimensions: 1024 },
      { id: "all-minilm", dimensions: 384 },
    ],
  },
] satisfies (KnowledgeChoice & {
  id: IndexConfig["embeddings"]["provider"];
  url: string;
  models: { id: string; dimensions: number }[];
})[];
export const VECTOR_PROVIDERS = [
  {
    id: "chroma",
    name: "Chroma",
    icon: logo("vectors", "chroma"),
    description: "Coleções em um servidor Chroma.",
  },
  {
    id: "elasticsearch",
    name: "Elasticsearch",
    icon: logo("vectors", "elasticsearch", "png"),
    description: "Busca vetorial em índices Elasticsearch.",
  },
  {
    id: "faiss",
    name: "Faiss",
    icon: logo("vectors", "faiss"),
    description: "Índice vetorial local, persistido junto aos dados do app.",
  },
  {
    id: "mongodb",
    name: "MongoDB Atlas",
    icon: logo("vectors", "mongodb"),
    description: "Atlas Vector Search com índice de busca dedicado.",
  },
  {
    id: "pinecone",
    name: "Pinecone",
    icon: logo("vectors", "pinecone"),
    description: "Vetores em um índice Pinecone existente.",
  },
  {
    id: "postgres",
    name: "Postgres",
    icon: logo("vectors", "postgres"),
    description: "Busca com a extensão pgvector no PostgreSQL.",
  },
  {
    id: "qdrant",
    name: "Qdrant",
    icon: logo("vectors", "qdrant", "png"),
    description: "Coleções vetoriais em servidor próprio ou Qdrant Cloud.",
  },
  {
    id: "weaviate",
    name: "Weaviate",
    icon: logo("vectors", "weaviate", "png"),
    description: "Coleções com vetores fornecidos pelo modelo escolhido.",
  },
  {
    id: "supabase",
    name: "Supabase",
    icon: logo("vectors", "supabase"),
    description: "pgvector pela API do projeto Supabase.",
  },
  {
    id: "singlestore",
    name: "SingleStore",
    icon: logo("vectors", "singlestore"),
    description: "Armazenamento e busca vetorial no SingleStore.",
  },
  {
    id: "opensearch",
    name: "OpenSearch",
    icon: logo("vectors", "opensearch"),
    description: "Índices k-NN em um cluster OpenSearch.",
  },
] satisfies (KnowledgeChoice & {
  id: IndexConfig["vectorStore"]["provider"];
})[];
export const RECORD_PROVIDERS = [
  {
    id: "internal",
    name: "Registro interno",
    // Ícone próprio (o do SQLite, herdado do Record Manager original) para não se confundir com o Postgres.
    icon: logo("records", "sqlite", "png"),
    description: "Controle dos registros privado para sua conta.",
  },
  {
    id: "postgres",
    name: "Postgres Record Manager",
    icon: logo("records", "postgres"),
    description: "Controle dos registros em um banco PostgreSQL.",
  },
] satisfies (KnowledgeChoice & {
  id: IndexConfig["recordManager"]["provider"];
})[];
export function embeddingDimensions(config: IndexConfig["embeddings"]) {
  return config.dimensions ?? EMBEDDING_PROVIDERS.find((p) => p.id === config.provider)?.models.find(
    (m) => m.id === config.model,
  )?.dimensions;
}
export const SQL_VECTOR_PROVIDERS = ["postgres", "singlestore", "mongodb"];
export const VECTOR_OPTIONS: Partial<
  Record<
    IndexConfig["vectorStore"]["provider"],
    { key: string; label: string; placeholder: string }[]
  >
> = {
  chroma: [
    { key: "tenant", label: "Tenant", placeholder: "default_tenant" },
    {
      key: "database",
      label: "Banco de dados",
      placeholder: "default_database",
    },
  ],
  mongodb: [
    { key: "database", label: "Banco de dados", placeholder: "agentflows" },
  ],
  pinecone: [
    {
      key: "namespace",
      label: "Prefixo do namespace",
      placeholder: "agentflows",
    },
  ],
  postgres: [
    { key: "schema", label: "Schema", placeholder: "public" },
    { key: "tableName", label: "Prefixo da tabela", placeholder: "kb" },
    { key: "contentColumnName", label: "Coluna de conteúdo", placeholder: "content" },
    { key: "batchSize", label: "Lote de gravação (Upsert Batch Size)", placeholder: "100" },
  ],
  supabase: [
    { key: "tableName", label: "Tabela", placeholder: "agentflows_documents" },
    {
      key: "queryName",
      label: "Função de busca",
      placeholder: "match_agentflows_documents",
    },
  ],
  elasticsearch: [
    {
      key: "username",
      label: "Usuário (se usar senha)",
      placeholder: "elastic",
    },
  ],
  opensearch: [
    { key: "username", label: "Usuário (se usar senha)", placeholder: "admin" },
  ],
};
