/** Time budget of a standard run, shared by the engine, the ChatGPT turn and the worker's drain window.
 * LIMITE_EXECUCAO_SEGUNDOS (default 180, between 30 and 900). Media flows keep MEDIA_RUN_MS. */
export const RUN_BUDGET_DEFAULT_S = 180;
export function runBudgetSeconds() {
  const n = Number(process.env.LIMITE_EXECUCAO_SEGUNDOS);
  if (!Number.isInteger(n) || n <= 0) return RUN_BUDGET_DEFAULT_S;
  return Math.min(900, Math.max(30, n));
}
export const runBudgetMs = () => runBudgetSeconds() * 1000;
