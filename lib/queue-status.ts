/** Queue position of a run that the worker has not claimed yet. Computed on read; never persisted in the run body. */
export type QueueStatus = {
  /** 1-based position among queued jobs, in claim order. */
  position: number;
  /** Jobs ahead of this one across all accounts. */
  ahead: number;
  /** Jobs currently holding an execution slot. */
  running: number;
  /** Execution slots configured (EXECUCOES_SIMULTANEAS). */
  slots: number;
  /** Workers with a fresh heartbeat; zero means nothing will be claimed until one returns. */
  workers: number;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** Short status for badges and footers. */
export function queueLabel(queue?: QueueStatus) {
  if (!queue) return "Na fila";
  if (!queue.workers) return "Na fila · aguardando o processador";
  if (queue.ahead === 0) return "Na fila · começa em instantes";
  return `Na fila · ${plural(queue.ahead, "execução", "execuções")} à frente`;
}
/** One-paragraph explanation for the chat bubble while the run waits. */
export function queueExplanation(queue?: QueueStatus) {
  if (!queue) return "Sua execução está na fila e começa automaticamente. Não é preciso enviar de novo.";
  if (!queue.workers) return "Nenhum processador de execuções está ativo agora. Sua execução começa sozinha assim que ele voltar; não é preciso enviar de novo.";
  const slots = `${queue.running} de ${queue.slots} ${queue.slots === 1 ? "vaga em uso" : "vagas em uso"}`;
  if (queue.ahead === 0) return `Você é o próximo: ${slots}. A execução começa assim que uma vaga liberar.`;
  return `Posição ${queue.position} na fila, ${slots}. A execução começa sozinha quando chegar a sua vez; não é preciso enviar de novo.`;
}
