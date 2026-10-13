import type { Sql } from "./saas-db";
import { FlowError } from "./flow-store";
import { knowledgeFileBytes } from "./tenant-knowledge";

export type Plan = "beta" | "ai_action";
export const AI_ACTION_URL = "https://pages.startse.com/ai-action";
/** Exclusive coupon for beta members joining AI Action. */
export const AI_ACTION_COUPON = "JOURNEY2ACTION";
const positive = (name: string, fallback: number) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : fallback; };
/** Limits read per call so deploys can tune them. The AI Action plan has no run or flow limit;
 * knowledge file storage applies to every account. */
export const planLimits = () => ({ runsPerMonth: positive("LIMITE_EXECUCOES_MES", 1000), flows: positive("LIMITE_FLUXOS", 5), storageMb: positive("LIMITE_ARMAZENAMENTO_MB", 50) });

/** Recognized by the HTTP layer so the interface can offer the AI Action plan. */
export class PlanLimitError extends FlowError {
  code = "plan_limit" as const;
  constructor(message: string) { super(message, 403); }
}

// Usage is counted per calendar month in Brazil, the product's audience.
const MONTH = "to_char(now() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM')";

async function planOf(sql: Sql, owner: string, lock: boolean): Promise<Plan> {
  const { rows } = await sql.query<{ plan: Plan }>(`SELECT plan FROM users WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [owner]);
  if (!rows[0]) throw new FlowError("Conta não encontrada.", 404);
  return rows[0].plan;
}

/** Call inside the enqueue transaction: the owner row lock serializes concurrent runs of the same account. */
export async function consumeMonthlyRun(sql: Sql, owner: string) {
  const plan = await planOf(sql, owner, true);
  if (plan === "beta") {
    const { rows } = await sql.query<{ runs: number }>(`SELECT runs FROM usage_months WHERE user_id=$1 AND month=${MONTH}`, [owner]);
    const limit = planLimits().runsPerMonth;
    if ((rows[0]?.runs || 0) >= limit) throw new PlanLimitError(`Você usou as ${limit} execuções deste mês no beta. Faça parte do AI Action para ter execuções ilimitadas.`);
  }
  await sql.query(`INSERT INTO usage_months(user_id,month,runs) VALUES($1,${MONTH},1)
    ON CONFLICT(user_id,month) DO UPDATE SET runs=usage_months.runs+1`, [owner]);
}

/** Call inside the creation transaction, after locking the owner row. */
export async function assertFlowCapacity(sql: Sql, owner: string) {
  if (await planOf(sql, owner, true) !== "beta") return;
  const limit = planLimits().flows;
  const { rows } = await sql.query<{ n: number }>("SELECT count(*)::int n FROM flows WHERE user_id=$1", [owner]);
  if (rows[0].n >= limit) throw new PlanLimitError(`O beta permite até ${limit} fluxos por conta. Exclua um fluxo ou faça parte do AI Action para ter fluxos ilimitados.`);
}

export type AccountUsage = {
  plan: Plan; month: string; upgradeUrl: string; coupon: string;
  runs: { used: number; limit: number | null }; flows: { used: number; limit: number | null };
  /** Bytes of files in knowledge bases. */
  storage: { used: number; limit: number };
};
export async function accountUsage(sql: Sql, owner: string): Promise<AccountUsage> {
  const { rows } = await sql.query<{ plan: Plan; month: string; runs: number; flows: number }>(`SELECT u.plan,${MONTH} AS month,
    coalesce((SELECT runs FROM usage_months m WHERE m.user_id=u.id AND m.month=${MONTH}),0)::int runs,
    (SELECT count(*) FROM flows f WHERE f.user_id=u.id)::int flows FROM users u WHERE u.id=$1`, [owner]);
  if (!rows[0]) throw new FlowError("Conta não encontrada.", 404);
  const { plan, month, runs, flows } = rows[0], limits = planLimits(), beta = plan === "beta";
  return { plan, month, upgradeUrl: AI_ACTION_URL, coupon: AI_ACTION_COUPON,
    runs: { used: runs, limit: beta ? limits.runsPerMonth : null }, flows: { used: flows, limit: beta ? limits.flows : null },
    storage: { used: await knowledgeFileBytes(sql, owner), limit: limits.storageMb * 1024 * 1024 } };
}
