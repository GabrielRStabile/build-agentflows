import { randomUUID } from "node:crypto";
import { FlowError } from "./flow-store";
import { currentTenant } from "./tenant-context";

// Sessão de conversa do endereço publicado: um id escolhido pelo cliente (ou gerado aqui) que liga
// execuções do mesmo fluxo. Reenviá-lo faz a nova chamada receber as interações anteriores como
// histórico, que os blocos usam quando a memória está ligada. Sem sessão, nada muda.
export const SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
export const SESSION_HISTORY_LIMIT = 50;
export function integrationSession(value: unknown): string {
  if (value === undefined || value === null || value === "") return randomUUID();
  if (typeof value !== "string" || !SESSION_PATTERN.test(value)) throw new FlowError("Informe um id de sessão com até 100 caracteres: letras, números, ponto, traço, sublinhado ou dois-pontos.");
  return value;
}
/** Execuções concluídas desta sessão, na ordem, limitadas às mais recentes; a memória de cada bloco decide quanto usa. */
export async function sessionHistoryIds(flowId: string, session: string): Promise<string[]> {
  const { db, user } = currentTenant();
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM (SELECT id, sequence FROM runs WHERE user_id=$1 AND flow_id=$2 AND status='completed' AND body->>'session'=$3 AND COALESCE(body->>'demo','false')<>'true' ORDER BY sequence DESC LIMIT $4) recent ORDER BY sequence",
    [user.id, flowId, session, SESSION_HISTORY_LIMIT],
  );
  return rows.map((row) => row.id);
}
