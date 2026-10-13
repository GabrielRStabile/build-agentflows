import type { Run, RunPage, RunSummary } from "./flow-types";

/** Conditional polling: the client sends the updatedAt it holds and gets 204 when nothing moved.
 * A queued run keeps its timestamp while its queue position changes, so it is always sent. */
export function isUnchangedRun(run: Run, after: string) {
  return !run.queued && !run.queue && !!run.updatedAt && run.updatedAt === after;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRunSummary(value: unknown): value is RunSummary {
  return isRecord(value) &&
    ["id", "flowId", "name", "input", "createdAt"].every(key => typeof value[key] === "string") &&
    typeof value.demo === "boolean" &&
    ["running", "waiting", "completed", "failed", "cancelled"].includes(String(value.status));
}

/** The editor's legacy Run[] response is not a complete, paginated history. */
export function isRunPage(value: unknown): value is RunPage {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isRunSummary)) return false;
  const { page, pageSize, total, totalPages } = value;
  if (![page, pageSize, total, totalPages].every(Number.isSafeInteger)) return false;
  return typeof page === "number" && typeof pageSize === "number" &&
    typeof total === "number" && typeof totalPages === "number" &&
    page >= 1 && pageSize >= 1 && pageSize <= 100 && total >= 0 &&
    totalPages === Math.max(1, Math.ceil(total / pageSize)) && page <= totalPages &&
    value.items.length === Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize));
}

export function parseRunPage(value: unknown): RunPage {
  if (!isRunPage(value)) {
    throw new Error("Não foi possível carregar as execuções: resposta inválida do servidor. Tentaremos novamente automaticamente.");
  }
  return value;
}
