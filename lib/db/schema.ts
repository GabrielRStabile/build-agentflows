import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, bigint, boolean, jsonb, customType, primaryKey, foreignKey, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import type { Flow, Run } from "../flow-types";
import type { KnowledgeBase, KnowledgeSource, Chunk, IndexRun } from "../knowledge-types";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const bytes = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// A personal tenant is the authenticated user's ID. Resource keys and all their
// relationships include that ID; no request may select a different tenant.
export const users = pgTable("users", {
  id: uuid("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  password_hash: text("password_hash"), google_sub: text("google_sub").unique(),
  email_verified_at: time("email_verified_at"), beta_status: text("beta_status").notNull().default("pending"),
  approved_at: time("approved_at"), created_at: time("created_at").notNull().defaultNow(),
  // beta: monthly run and flow limits; ai_action: unlimited (set by an administrator).
  plan: text("plan").notNull().default("beta"),
}, (t) => [check("users_name", sql`length(${t.name}) BETWEEN 1 AND 120`),
  check("users_plan", sql`${t.plan} IN ('beta','ai_action')`),
  check("users_email", sql`${t.email}=lower(${t.email}) AND length(${t.email})<=254`),
  check("users_beta_status", sql`${t.beta_status} IN ('pending','approved','blocked')`)]);
// Monthly run counter (America/Sao_Paulo calendar month). Deleting runs or flows never refunds usage.
export const usageMonths = pgTable("usage_months", {
  user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), month: text("month").notNull(),
  runs: integer("runs").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.user_id, t.month] }), check("usage_months_month", sql`${t.month} ~ '^[0-9]{4}-[0-9]{2}$'`), check("usage_months_runs", sql`${t.runs}>=0`)]);
export const sessions = pgTable("sessions", {
  token_hash: text("token_hash").primaryKey(), user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  created_at: time("created_at").notNull().defaultNow(), expires_at: time("expires_at").notNull(),
}, (t) => [index("sessions_user").on(t.user_id), index("sessions_expiry").on(t.expires_at)]);
export const actionTokens = pgTable("action_tokens", {
  token_hash: text("token_hash").primaryKey(), user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(), expires_at: time("expires_at").notNull(), created_at: time("created_at").notNull().defaultNow(),
}, (t) => [check("action_tokens_purpose", sql`${t.purpose} IN ('verify_email','reset_password')`), index("action_tokens_user").on(t.user_id, t.purpose)]);
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey(), code_hash: text("code_hash").notNull().unique(), label: text("label").notNull().default(""),
  max_uses: integer("max_uses").notNull(), uses: integer("uses").notNull().default(0),
  expires_at: time("expires_at"), revoked_at: time("revoked_at"), created_at: time("created_at").notNull().defaultNow(),
}, (t) => [check("invites_capacity", sql`${t.max_uses}>0 AND ${t.uses}>=0 AND ${t.uses}<=${t.max_uses}`)]);
export const inviteRedemptions = pgTable("invite_redemptions", {
  user_id: uuid("user_id").primaryKey().references(() => users.id), invite_id: uuid("invite_id").notNull().references(() => invites.id),
  redeemed_at: time("redeemed_at").notNull().defaultNow(),
}, (t) => [index("invite_redemptions_invite").on(t.invite_id)]);
export const rateLimits = pgTable("rate_limits", {
  key_hash: text("key_hash").primaryKey(), hits: integer("hits").notNull(), resets_at: time("resets_at").notNull(),
}, (t) => [check("rate_limits_hits", sql`${t.hits}>0`), index("rate_limits_expiry").on(t.resets_at)]);
export const oauthStates = pgTable("oauth_states", {
  state_hash: text("state_hash").primaryKey(), binding_hash: text("binding_hash").notNull(), payload_ciphertext: text("payload_ciphertext").notNull(), expires_at: time("expires_at").notNull(),
});
export const mailOutbox = pgTable("mail_outbox", {
  id: uuid("id").primaryKey(), payload_ciphertext: text("payload_ciphertext").notNull(), attempts: integer("attempts").notNull().default(0),
  available_at: time("available_at").notNull().defaultNow(), lease_id: uuid("lease_id"), lease_until: time("lease_until"),
  sent_at: time("sent_at"), failed_at: time("failed_at"), created_at: time("created_at").notNull().defaultNow(),
}, (t) => [index("mail_outbox_pending").on(t.available_at).where(sql`${t.sent_at} IS NULL AND ${t.failed_at} IS NULL`)]);
export const credentials = pgTable("credentials", {
  user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), key: text("key").notNull(),
  ciphertext: text("ciphertext").notNull(), updated_at: time("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.user_id, t.key] }), check("credentials_key", sql`length(${t.key}) BETWEEN 1 AND 200`)]);
export const chatgptSessions = pgTable("chatgpt_sessions", {
  user_id: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  ciphertext: text("ciphertext"), lease_token: uuid("lease_token"), lease_until: time("lease_until"),
  updated_at: time("updated_at").notNull().defaultNow(),
}, (t) => [check("chatgpt_sessions_size", sql`${t.ciphertext} IS NULL OR octet_length(${t.ciphertext})<=1048576`),
  check("chatgpt_sessions_lease", sql`(${t.lease_token} IS NULL)=(${t.lease_until} IS NULL)`)]);
export const flows = pgTable("flows", {
  user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), id: text("id").notNull(), body: jsonb("body").$type<Flow>().notNull(),
  sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity(), revision: bigint("revision", { mode: "number" }).notNull().default(1),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] }), check("flows_body", sql`${t.body}->>'id'=${t.id}`), index("flows_list").on(t.user_id, t.sequence.desc())]);
export const runs = pgTable("runs", {
  user_id: uuid("user_id").notNull(), id: text("id").notNull(), flow_id: text("flow_id").notNull(), status: text("status").notNull(),
  body: jsonb("body").$type<Run>().notNull(), sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity(),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] }), foreignKey({ columns: [t.user_id, t.flow_id], foreignColumns: [flows.user_id, flows.id] }).onDelete("cascade"),
  check("runs_status", sql`${t.status} IN ('running','waiting','completed','failed','cancelled')`),
  check("runs_body", sql`${t.body}->>'id'=${t.id} AND ${t.body}->>'flowId'=${t.flow_id} AND ${t.body}->>'status'=${t.status}`),
  uniqueIndex("runs_parent").on(t.user_id, t.id, t.flow_id),
  index("runs_list").on(t.user_id, t.sequence.desc()), index("runs_flow").on(t.user_id, t.flow_id, t.status, t.sequence.desc())]);
// Prompts agendados do bloco Início. Ficam fora do grafo: salvar, exportar ou chamar o fluxo pela API não os altera.
// active=false é pausado; next_run_at nulo com active=true é encerrado.
export const flowSchedules = pgTable("flow_schedules", {
  user_id: uuid("user_id").notNull(), id: text("id").notNull(), flow_id: text("flow_id").notNull(), body: jsonb("body").notNull(),
  active: boolean("active").notNull().default(true), next_run_at: time("next_run_at"), created_at: time("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] }), foreignKey({ columns: [t.user_id, t.flow_id], foreignColumns: [flows.user_id, flows.id] }).onDelete("cascade"),
  check("flow_schedules_body", sql`${t.body}->>'id'=${t.id} AND ${t.body}->>'flowId'=${t.flow_id}`),
  index("flow_schedules_flow").on(t.user_id, t.flow_id, t.created_at), index("flow_schedules_due").on(t.next_run_at).where(sql`${t.active}`)]);
export const knowledgeBases = pgTable("knowledge_bases", {
  user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), id: text("id").notNull(),
  body: jsonb("body").$type<KnowledgeBase>().notNull(), revision: bigint("revision", { mode: "number" }).notNull().default(1),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] }), check("knowledge_bases_body", sql`${t.body}->>'id'=${t.id}`)]);
export const knowledgeSources = pgTable("knowledge_sources", {
  user_id: uuid("user_id").notNull(), base_id: text("base_id").notNull(), id: text("id").notNull(), body: jsonb("body").$type<KnowledgeSource>().notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.base_id, t.id] }),
  foreignKey({ columns: [t.user_id, t.base_id], foreignColumns: [knowledgeBases.user_id, knowledgeBases.id] }).onDelete("cascade"),
  check("knowledge_sources_body", sql`${t.body}->>'id'=${t.id} AND ${t.body}->>'baseId'=${t.base_id}`)]);
export const knowledgeChunks = pgTable("knowledge_chunks", {
  user_id: uuid("user_id").notNull(), base_id: text("base_id").notNull(), source_id: text("source_id").notNull(), id: text("id").notNull(), body: jsonb("body").$type<Chunk>().notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.base_id, t.id] }),
  foreignKey({ columns: [t.user_id, t.base_id, t.source_id], foreignColumns: [knowledgeSources.user_id, knowledgeSources.base_id, knowledgeSources.id] }).onDelete("cascade"),
  check("knowledge_chunks_body", sql`${t.body}->>'id'=${t.id} AND ${t.body}->>'sourceId'=${t.source_id}`)]);
export const knowledgeVectors = pgTable("knowledge_vectors", {
  user_id: uuid("user_id").notNull(), base_id: text("base_id").notNull(), generation: text("generation").notNull(),
  chunk_id: text("chunk_id").notNull(), hash: text("hash").notNull(), body: jsonb("body").notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.base_id, t.generation, t.chunk_id] }),
  foreignKey({ columns: [t.user_id, t.base_id], foreignColumns: [knowledgeBases.user_id, knowledgeBases.id] }).onDelete("cascade")]);
export const knowledgeIndexes = pgTable("knowledge_indexes", {
  user_id: uuid("user_id").notNull(), base_id: text("base_id").notNull(), generation: text("generation").notNull(), body: jsonb("body").notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.base_id] }), foreignKey({ columns: [t.user_id, t.base_id], foreignColumns: [knowledgeBases.user_id, knowledgeBases.id] }).onDelete("cascade")]);
export const knowledgeRuns = pgTable("knowledge_runs", {
  user_id: uuid("user_id").notNull(), base_id: text("base_id").notNull(), id: text("id").notNull(), body: jsonb("body").$type<IndexRun>().notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.base_id, t.id] }), foreignKey({ columns: [t.user_id, t.base_id], foreignColumns: [knowledgeBases.user_id, knowledgeBases.id] }).onDelete("cascade"), check("knowledge_runs_body", sql`${t.body}->>'id'=${t.id}`)]);
export const knowledgeLocks = pgTable("knowledge_locks", {
  user_id: uuid("user_id").notNull(), base_id: text("base_id").notNull(), token: text("token").notNull(), expires_at: time("expires_at").notNull(),
  job_id: uuid("job_id"), job_token: uuid("job_token"),
}, (t) => [primaryKey({ columns: [t.user_id, t.base_id] }), foreignKey({ columns: [t.user_id, t.base_id], foreignColumns: [knowledgeBases.user_id, knowledgeBases.id] }).onDelete("cascade")]);
export const knowledgeCleanup = pgTable("knowledge_cleanup", {
  user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), base_id: text("base_id").notNull(), id: text("id").notNull(), body: jsonb("body").notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] })]);
export const knowledgePrivate = pgTable("knowledge_private", {
  user_id: uuid("user_id").notNull(), base_id: text("base_id").notNull(), resource_id: text("resource_id").notNull(), ciphertext: text("ciphertext").notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.base_id, t.resource_id] }), foreignKey({ columns: [t.user_id, t.base_id], foreignColumns: [knowledgeBases.user_id, knowledgeBases.id] }).onDelete("cascade")]);
export const attachments = pgTable("attachments", {
  user_id: uuid("user_id").notNull(), id: text("id").notNull(), flow_id: text("flow_id").notNull(), body: jsonb("body").notNull(),
  used: boolean("used").notNull().default(false), created_at: time("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] }), foreignKey({ columns: [t.user_id, t.flow_id], foreignColumns: [flows.user_id, flows.id] }).onDelete("cascade"),
  check("attachments_body", sql`${t.body}->>'id'=${t.id} AND ${t.body}->>'flowId'=${t.flow_id}`), index("attachments_unused").on(t.user_id, t.created_at).where(sql`${t.used}=false`)]);
export const attachmentBlobs = pgTable("attachment_blobs", {
  user_id: uuid("user_id").notNull(), id: text("id").notNull(), data: bytes("data").notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] }), foreignKey({ columns: [t.user_id, t.id], foreignColumns: [attachments.user_id, attachments.id] }).onDelete("cascade"), check("attachment_blobs_size", sql`octet_length(${t.data}) BETWEEN 1 AND 10485760`)]);
// Habilidades (skills) da conta: SKILL.md e arquivos de texto do pacote; os Agentes guardam só os ids em config.skills.
export const skills = pgTable("skills", {
  user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), id: text("id").notNull(), name: text("name").notNull(),
  body: jsonb("body").notNull(), updated_at: time("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] }), uniqueIndex("skills_name").on(t.user_id, t.name),
  check("skills_body", sql`${t.body}->>'id'=${t.id} AND ${t.body}->>'name'=${t.name}`), check("skills_size", sql`octet_length(${t.body}::text)<=4194304`)]);
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey(), user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), resource_id: text("resource_id").notNull(), run_id: text("run_id"), base_id: text("base_id"), source_id: text("source_id"),
  status: text("status").notNull().default("queued"), lease_token: uuid("lease_token"), lease_until: time("lease_until"),
  started_at: time("started_at"), finished_at: time("finished_at"), created_at: time("created_at").notNull().defaultNow(), error: text("error"),
}, (t) => [foreignKey({ columns: [t.user_id, t.run_id], foreignColumns: [runs.user_id, runs.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.user_id, t.base_id], foreignColumns: [knowledgeBases.user_id, knowledgeBases.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.user_id, t.base_id, t.source_id], foreignColumns: [knowledgeSources.user_id, knowledgeSources.base_id, knowledgeSources.id] }).onDelete("cascade"),
  check("jobs_kind", sql`${t.kind} IN ('run','index','extract')`), check("jobs_status", sql`${t.status} IN ('queued','running','done','failed','cancelled','interrupted')`),
  check("jobs_resource", sql`(${t.kind}='run' AND ${t.run_id} IS NOT NULL AND ${t.base_id} IS NULL AND ${t.source_id} IS NULL) OR (${t.kind}='index' AND ${t.run_id} IS NULL AND ${t.base_id} IS NOT NULL AND ${t.source_id} IS NULL) OR (${t.kind}='extract' AND ${t.run_id} IS NULL AND ${t.base_id} IS NOT NULL AND ${t.source_id} IS NOT NULL)`),
  uniqueIndex("jobs_run_parent").on(t.user_id, t.id, t.run_id),
  index("jobs_queue").on(t.status, t.created_at), index("jobs_owner").on(t.user_id, t.status),
  uniqueIndex("jobs_active_resource").on(t.user_id, t.kind, t.resource_id).where(sql`${t.status} IN ('queued','running')`)]);
export const workerHeartbeats = pgTable("worker_heartbeats", { id: uuid("id").primaryKey(), updated_at: time("updated_at").notNull().defaultNow() });

export const channelEvents = pgTable("channel_events", {
  user_id: uuid("user_id").notNull(), event_key: text("event_key").notNull(), run_id: text("run_id").notNull(),
  channel: text("channel").notNull(), reply_ciphertext: text("reply_ciphertext"), created_at: time("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.user_id, t.event_key] }), uniqueIndex("channel_events_run").on(t.user_id, t.run_id),
  foreignKey({ columns: [t.user_id, t.run_id], foreignColumns: [runs.user_id, runs.id] }).onDelete("cascade"),
  check("channel_events_channel", sql`${t.channel} IN ('whatsapp','elevenlabs','email')`)]);
// Caixa de entrada lida por IMAP: uma por conta, com o cursor (UIDVALIDITY + último UID) e a próxima leitura.
export const emailInboxes = pgTable("email_inboxes", {
  user_id: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  body: jsonb("body").notNull().default(sql`'{}'::jsonb`), next_poll_at: time("next_poll_at").notNull().defaultNow(),
}, (t) => [index("email_inboxes_due").on(t.next_poll_at)]);
export const channelDeliveries = pgTable("channel_deliveries", {
  user_id: uuid("user_id").notNull(), job_id: uuid("job_id").notNull(), run_id: text("run_id").notNull(),
  status: text("status").notNull().default("pending"), updated_at: time("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.user_id, t.job_id] }),
  foreignKey({ columns: [t.user_id, t.job_id, t.run_id], foreignColumns: [jobs.user_id, jobs.id, jobs.run_id] }).onDelete("cascade"),
  foreignKey({ columns: [t.user_id, t.run_id], foreignColumns: [channelEvents.user_id, channelEvents.run_id] }).onDelete("cascade"),
  check("channel_deliveries_status", sql`${t.status} IN ('pending','sending','sent','uncertain','cancelled')`)]);

export const embedSettings = pgTable("embed_settings", {
  user_id: uuid("user_id").notNull(), flow_id: text("flow_id").notNull(), body: jsonb("body").notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.flow_id] }), foreignKey({ columns: [t.user_id, t.flow_id], foreignColumns: [flows.user_id, flows.id] }).onDelete("cascade")]);
export const embedSessions = pgTable("embed_sessions", {
  user_id: uuid("user_id").notNull(), id: text("id").notNull(), flow_id: text("flow_id").notNull(), body: jsonb("body").notNull(),
  created_at: time("created_at").notNull().defaultNow(), expires_at: time("expires_at").notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] }), uniqueIndex("embed_sessions_parent").on(t.user_id, t.id, t.flow_id),
  foreignKey({ columns: [t.user_id, t.flow_id], foreignColumns: [flows.user_id, flows.id] }).onDelete("cascade"),
  check("embed_sessions_body", sql`${t.body}->>'id'=${t.id} AND ${t.body}->>'flowId'=${t.flow_id}`), index("embed_sessions_expiry").on(t.expires_at)]);
export const embedRequests = pgTable("embed_requests", {
  user_id: uuid("user_id").notNull(), session_id: text("session_id").notNull(), request_id: text("request_id").notNull(),
  flow_id: text("flow_id").notNull(), run_id: text("run_id").notNull(), created_at: time("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.user_id, t.session_id, t.request_id] }), uniqueIndex("embed_requests_run").on(t.user_id, t.session_id, t.run_id),
  foreignKey({ columns: [t.user_id, t.session_id, t.flow_id], foreignColumns: [embedSessions.user_id, embedSessions.id, embedSessions.flow_id] }).onDelete("cascade"),
  foreignKey({ columns: [t.user_id, t.run_id, t.flow_id], foreignColumns: [runs.user_id, runs.id, runs.flow_id] }).onDelete("cascade")]);
export const embedCommands = pgTable("embed_commands", {
  user_id: uuid("user_id").notNull(), id: text("id").notNull(), session_id: text("session_id").notNull(), run_id: text("run_id").notNull(),
  status: text("status").notNull(), body: jsonb("body").notNull(), created_at: time("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.user_id, t.id] }),
  foreignKey({ columns: [t.user_id, t.session_id, t.run_id], foreignColumns: [embedRequests.user_id, embedRequests.session_id, embedRequests.run_id] }).onDelete("cascade"),
  check("embed_commands_status", sql`${t.status} IN ('pending','delivered','completed','failed','expired','cancelled')`),
  check("embed_commands_body", sql`${t.body}->>'id'=${t.id} AND ${t.body}->>'runId'=${t.run_id} AND ${t.body}->>'sessionId'=${t.session_id} AND ${t.body}->>'status'=${t.status}`),
  index("embed_commands_session").on(t.user_id, t.session_id, t.created_at.desc()),
  uniqueIndex("embed_commands_active").on(t.user_id, t.run_id).where(sql`${t.status} IN ('pending','delivered')`)]);
