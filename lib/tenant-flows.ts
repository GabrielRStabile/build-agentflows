import { settleChannelDelivery } from "./channel-flows";
import { randomUUID } from "node:crypto";
import { currentTenant } from "./tenant-context";
import { currentFlow, FlowError, normalizeFlowUpdate, validateGraph } from "./flow-store";
import { block, template, type Flow, type Run, type RunPage, type RunSummary, type Graph } from "./flow-types";
import { assertJobLease } from "./saas-job-context";
import type { Sql } from "./saas-db";
import { readToolCards } from "./agent-tools";
import { knowledgeSettings } from "./knowledge-settings";
import { assertFlowCapacity } from "./saas-plan";

async function validateReferences(sql: Sql, owner: string, graph: Graph) {
  await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
  const credentials = new Set(graph.nodes.flatMap((node) => readToolCards(node.data.config.tools || "", node.data.config.toolCards).map((card) => card.credentialId).filter((id): id is string => !!id)));
  for (const id of credentials) {
    if (!(await sql.query("SELECT 1 FROM credentials WHERE user_id=$1 AND key=$2", [owner, `TOOL_ACCOUNT_${id}`])).rows.length) throw new FlowError("Credencial não encontrada nesta conta.", 404);
  }
  const subflows = new Set(graph.nodes.flatMap((node) => readToolCards(node.data.config.tools || "", node.data.config.toolCards).map((card) => card.params?.flowId).filter((id): id is string => !!id)));
  for (const id of subflows) {
    if (!(await sql.query("SELECT 1 FROM flows WHERE user_id=$1 AND id=$2", [owner, id])).rows.length) throw new FlowError("Subfluxo não encontrado nesta conta.", 404);
  }
  for (const node of graph.nodes) if (["agent", "llm"].includes(node.data.kind)) {
    for (const { baseId } of knowledgeSettings(node.data.config).bases) {
      if (!(await sql.query("SELECT 1 FROM knowledge_bases WHERE user_id=$1 AND id=$2", [owner, baseId])).rows.length) throw new FlowError("Base de conhecimento não encontrada nesta conta.", 404);
    }
  }
}

async function readFlow(sql: Sql, owner: string, id: string, lock = false): Promise<Flow> {
  const { rows } = await sql.query<{ body: Flow }>(`SELECT body FROM flows WHERE user_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [owner, id]);
  if (!rows[0]) throw new FlowError("Fluxo não encontrado.", 404);
  return currentFlow(rows[0].body);
}
export async function getTenantFlow(id: string) {
  const { db, user } = currentTenant();
  return readFlow(db, user.id, id);
}
export async function listTenantFlows() {
  const { db, user } = currentTenant();
  const { rows } = await db.query<{ body: Flow }>("SELECT body FROM flows WHERE user_id=$1 ORDER BY sequence DESC", [user.id]);
  return rows.map((row) => currentFlow(row.body));
}
export async function createTenantFlow(name = "Novo fluxo", example = false, saved?: unknown) {
  const { db, user } = currentTenant();
  let flow: Flow = { id: randomUUID(), name: name.slice(0, 100), description: "",
    graph: example ? template(true) : { nodes: [block("start", "inicio", 0, 0)], edges: [] },
    published: null, version: 1, updatedAt: new Date().toISOString() };
  if (saved !== undefined) flow = normalizeFlowUpdate(flow, saved);
  await db.transaction(async (sql) => {
    await validateReferences(sql, user.id, flow.graph);
    await assertFlowCapacity(sql, user.id);
    await sql.query("INSERT INTO flows(user_id,id,body) VALUES ($1,$2,$3)", [user.id, flow.id, JSON.stringify(flow)]);
  });
  return flow;
}
export async function saveTenantFlow(id: string, input: unknown) {
  const { db, user } = currentTenant();
  return db.transaction(async (sql) => {
    await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    const flow = normalizeFlowUpdate(await readFlow(sql, user.id, id, true), input);
    await validateReferences(sql, user.id, flow.graph);
    await sql.query("UPDATE flows SET body=$3,revision=revision+1 WHERE user_id=$1 AND id=$2", [user.id, id, JSON.stringify(flow)]);
    return flow;
  });
}
export async function publishTenantFlow(id: string, active = true) {
  const { db, user } = currentTenant();
  return db.transaction(async (sql) => {
    await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    const flow = await readFlow(sql, user.id, id, true);
    await validateReferences(sql, user.id, flow.graph);
    flow.published = active ? validateGraph(flow.graph, true) : null;
    flow.updatedAt = new Date().toISOString();
    await sql.query("UPDATE flows SET body=$3,revision=revision+1 WHERE user_id=$1 AND id=$2", [user.id, id, JSON.stringify(flow)]);
    return flow;
  });
}
export async function deleteTenantFlow(id: string) {
  const { db, user } = currentTenant();
  await db.transaction(async (sql) => {
    await readFlow(sql, user.id, id, true);
    const pending = await sql.query("SELECT 1 FROM runs WHERE user_id=$1 AND flow_id=$2 AND status IN ('running','waiting') LIMIT 1", [user.id, id]);
    if (pending.rows.length) throw new FlowError("Finalize ou cancele as execuções pendentes antes de excluir.", 409);
    await sql.query("DELETE FROM flows WHERE user_id=$1 AND id=$2", [user.id, id]);
  });
}
export async function getTenantRun(id: string): Promise<Run> {
  const { db, user } = currentTenant();
  const { rows } = await db.query<{ body: Run }>("SELECT body FROM runs WHERE user_id=$1 AND id=$2", [user.id, id]);
  if (!rows[0]) throw new FlowError("Execução não encontrada.", 404);
  return rows[0].body;
}
export async function putTenantRun(input: Run) {
  const { db, user } = currentTenant();
  return db.transaction((sql) => persistTenantRun(sql, user.id, input));
}
export async function persistTenantRun(sql: Sql, owner: string, input: Run) {
  await assertJobLease(sql, owner);
  const run = { ...input, updatedAt: new Date().toISOString() };
  delete run.queue; // Live queue position is computed on read, never stored.
    // Shares the flow lock with delete: an execution cannot start between its check and deletion.
    await readFlow(sql, owner, run.flowId, true);
    // References and attachments are checked when the run is created. Progress writes (every 500 ms while a
    // model streams) reuse the same snapshot, so a credential or base removed meanwhile cannot kill the run.
    const exists = (await sql.query("SELECT 1 FROM runs WHERE user_id=$1 AND id=$2", [owner, run.id])).rows.length > 0;
    if (!exists) {
      await validateReferences(sql, owner, run.graph);
      for (const attachment of run.attachments || []) {
        if (!(await sql.query("SELECT 1 FROM attachments WHERE user_id=$1 AND flow_id=$2 AND id=$3", [owner, run.flowId, attachment.id])).rows.length) throw new FlowError("Anexo não encontrado neste fluxo.", 404);
      }
    }
    const { rows } = await sql.query(`INSERT INTO runs(user_id,id,flow_id,status,body) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(user_id,id) DO UPDATE SET status=excluded.status,body=excluded.body
      WHERE runs.flow_id=excluded.flow_id AND (runs.status='running' OR runs.status=excluded.status) RETURNING id`, [owner, run.id, run.flowId, run.status, JSON.stringify(run)]);
    if (!rows.length) {
      const stored = await sql.query<{ body: Run }>("SELECT body FROM runs WHERE user_id=$1 AND id=$2", [owner, run.id]);
      if (!stored.rows[0] || stored.rows[0].body.flowId !== run.flowId) throw new FlowError("Não é possível mover uma execução para outro fluxo.", 409);
      Object.assign(run, stored.rows[0].body);
    }
  return run;
}
export async function cancelTenantRun(id: string) {
  const { db, user } = currentTenant();
  return db.transaction(async (sql) => {
    await sql.query("SELECT id FROM jobs WHERE user_id=$1 AND run_id=$2 AND status IN ('queued','running') FOR UPDATE", [user.id, id]);
    const { rows } = await sql.query<{ body: Run }>("SELECT body FROM runs WHERE user_id=$1 AND id=$2 FOR UPDATE", [user.id, id]);
    const run = rows[0]?.body;
    if (!run) throw new FlowError("Execução não encontrada.", 404);
    if (!["running", "waiting"].includes(run.status)) throw new FlowError("Esta execução já terminou.", 409);
    for (const trace of run.trace) if (trace.status === "running") { trace.status = "failed"; trace.output = "A execução foi cancelada."; trace.ms = Date.now() - Date.parse(trace.at); }
    run.status = "cancelled"; run.updatedAt = new Date().toISOString();
    await sql.query("UPDATE runs SET status='cancelled',body=$3 WHERE user_id=$1 AND id=$2", [user.id, id, JSON.stringify(run)]);
    if (run.embedSessionId) await sql.query("UPDATE embed_commands SET status='cancelled',body=body || '{\"status\":\"cancelled\"}'::jsonb WHERE user_id=$1 AND run_id=$2 AND status IN ('pending','delivered')", [user.id, id]);
    // Keep a running worker's slot until it stops; queued jobs release immediately.
    await sql.query("UPDATE jobs SET status='cancelled',finished_at=CASE WHEN status='queued' THEN now() ELSE NULL END WHERE user_id=$1 AND run_id=$2 AND status IN ('queued','running')", [user.id, id]);
    const cancelled = await sql.query<{ id: string; user_id: string; run_id: string }>("SELECT id,user_id,run_id FROM jobs WHERE user_id=$1 AND run_id=$2 AND status='cancelled' AND lease_until IS NULL", [user.id, id]);
    for (const job of cancelled.rows) await settleChannelDelivery(sql, job);
    return run;
  });
}
export async function listTenantRuns(flowId?: string, limit = 100) {
  const { db, user } = currentTenant();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FlowError("Limite inválido.");
  if (flowId) await getTenantFlow(flowId);
  const { rows } = await db.query<{ body: Run }>(`SELECT body FROM runs WHERE user_id=$1${flowId ? " AND flow_id=$2" : ""} ORDER BY sequence DESC LIMIT $${flowId ? 3 : 2}`, [user.id, ...(flowId ? [flowId] : []), limit]);
  return rows.map((row) => row.body);
}
/** Up to 50 runs by id in one request (the editor restores its test conversation this way). Unknown or foreign ids are omitted. */
export async function getTenantRuns(ids: string[]) {
  const { db, user } = currentTenant();
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 100))].slice(0, 50);
  if (!wanted.length) return [];
  const { rows } = await db.query<{ body: Run }>("SELECT body FROM runs WHERE user_id=$1 AND id=ANY($2::text[]) ORDER BY sequence", [user.id, wanted]);
  return rows.map((row) => row.body);
}
export async function tenantRunPage({ page = 1, pageSize = 20, status = "all", flowId }: { page?: number; pageSize?: number; status?: string; flowId?: string } = {}): Promise<RunPage> {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new FlowError("Página inválida.");
  if (!["all", "running", "waiting", "completed", "failed", "cancelled"].includes(status)) throw new FlowError("Status inválido.");
  const { db, user } = currentTenant();
  if (flowId) await getTenantFlow(flowId);
  const values: unknown[] = [user.id];
  let where = "user_id=$1";
  if (flowId) { values.push(flowId); where += ` AND flow_id=$${values.length}`; }
  if (status !== "all") { values.push(status); where += ` AND status=$${values.length}`; }
  const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM runs WHERE ${where}`, values);
  const total = count.rows[0].total, totalPages = Math.max(1, Math.ceil(total / pageSize)), actualPage = Math.min(page, totalPages);
  const { rows } = await db.query<RunSummary>(`SELECT id,flow_id AS "flowId",status,body->>'name' AS name,
    left(body->>'input',100) AS input,(body->>'demo')::boolean AS demo,body->>'createdAt' AS "createdAt"
    FROM runs WHERE ${where} ORDER BY sequence DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, pageSize, (actualPage - 1) * pageSize]);
  return { items: rows, total, totalPages, page: actualPage, pageSize };
}
export async function claimTenantRun(id: string) {
  const { db, user } = currentTenant();
  const { rows } = await db.query<{ body: Run }>(`UPDATE runs SET status='running',body=jsonb_set(body,'{status}','"running"')
    WHERE user_id=$1 AND id=$2 AND status='waiting' RETURNING body`, [user.id, id]);
  if (!rows[0]) {
    await getTenantRun(id); // An unknown/foreign ID has the same 404, not a state disclosure.
    throw new FlowError("Esta decisão já foi recebida.", 409);
  }
  return rows[0].body;
}
