// Puro (sem Node): usado no servidor e nos componentes para mostrar até quando uma credencial vale.
export const formatCredentialExpiry = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
