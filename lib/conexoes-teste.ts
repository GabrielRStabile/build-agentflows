// Botão "Testar" de cada cartão da tela Configurações: uma chamada real, curta, com resposta em
// linguagem de negócio.
import { FlowError } from "./flow-store";
import { conexaoMCP, servidorMCP } from "./conexoes";
import { listModels, openRouterKey } from "./openrouter";
import { conectar, listarFerramentas } from "./mcp-cliente";
import { interpretarFalha } from "./ai";
export type Resultado = { ok: boolean; mensagem: string };
export async function testarConexao(id: string): Promise<Resultado> {
  if (id === "openrouter") return testarOpenRouter();
  if (id.startsWith("mcp:")) return testarMCP(id.slice(4));
  if (id === "whatsapp") return (await import("./whatsapp")).testarWhatsApp();
  if (id === "elevenlabs") return (await import("./elevenlabs")).testarElevenLabs();
  if (id === "email") return (await import("./email-entrada")).testarEmail();
  throw new FlowError("Conexão desconhecida.");
}
async function testarOpenRouter(): Promise<Resultado> {
  const chave = openRouterKey();
  if (!chave) return { ok: false, mensagem: "Conecte o OpenRouter primeiro." };
  const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${chave}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok)
    return { ok: false, mensagem: interpretarFalha(r, await r.text().catch(() => "")).message };
  const data = (await r.json()) as {
    data?: { limit?: number | null; usage?: number; is_free_tier?: boolean };
  };
  const modelos = await listModels().catch(() => []);
  const limite = data.data?.limit;
  const restantes = limite != null ? Math.max(0, limite - (data.data?.usage ?? 0)) : null;
  const plano = data.data?.is_free_tier
    ? "Plano gratuito: modelos gratuitos ou adicione créditos."
    : restantes != null
      ? `Créditos: US$ ${restantes.toFixed(2)} restantes.`
      : `Uso até agora: US$ ${Number(data.data?.usage ?? 0).toFixed(2)}.`;
  return { ok: true, mensagem: `Conectado. ${modelos.length} modelos disponíveis. ${plano}` };
}
async function testarMCP(prefixo: string): Promise<Resultado> {
  const s = servidorMCP(prefixo);
  const conexao = await conexaoMCP(prefixo);
  if (!conexao)
    return { ok: false, mensagem: `Autorize “${s.nome}” ou informe o código de acesso.` };
  try {
    const ferramentas = await listarFerramentas(conectar(conexao.url, conexao.token));
    if (!ferramentas.length)
      return { ok: true, mensagem: "Conectado, mas o serviço ainda não expõe ferramentas." };
    return {
      ok: true,
      mensagem: `Conectado. Ferramentas: ${ferramentas.map((f) => f.nome).join(", ")}.`,
    };
  } catch (err) {
    return {
      ok: false,
      mensagem: err instanceof Error ? err.message : "Não foi possível conectar ao serviço.",
    };
  }
}
