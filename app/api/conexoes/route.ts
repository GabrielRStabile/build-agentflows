import { getTenantFlow } from "@/lib/tenant-flows";
import { currentTenant } from "@/lib/tenant-context";
import { FlowError } from "@/lib/flow-store";
import { salvarCampos, statusConexoes } from "@/lib/conexoes";
import { appOrigin } from "@/lib/saas-security";
import { requestApi, body } from "@/lib/flow-api";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return requestApi(req, () => statusConexoes(appOrigin()));
}
export async function PUT(req: Request) {
  return requestApi(req, async () => {
    const b = await body(req);
    const campos = b.campos as Record<string, unknown> | undefined;
    for (const key of ["WHATSAPP_FLOW_ID", "ELEVENLABS_FLOW_ID", "EMAIL_FLOW_ID"]) {
      const id = campos?.[key];
      if (typeof id === "string" && id) {
        await getTenantFlow(id);
        const { user, config } = currentTenant();
        config.guards.push(async sql => {
          if (!(await sql.query("SELECT id FROM flows WHERE user_id=$1 AND id=$2", [user.id, id])).rows.length) throw new FlowError("Fluxo não encontrado.", 404);
        });
      }
    }
    salvarCampos(campos, b.aceiteWhatsApp);
    // Caixa de e-mail: a leitura é do worker. Salvar põe a caixa na fila na mesma transação da configuração.
    if (campos && Object.keys(campos).some((k) => k.startsWith("EMAIL_"))) {
      const { agendarLeitura } = await import("@/lib/email-entrada");
      const { user, config } = currentTenant();
      config.guards.push((sql) => agendarLeitura(sql, user.id));
    }
    // Ao salvar o WhatsApp, o endereço de avisos é cadastrado no provedor (Z-API e ZapperHub).
    let aviso: string | null = null;
    if (campos && Object.keys(campos).some((k) => /^(WHATSAPP_|ZAPI_|ZAPPERHUB_)/.test(k))) {
      const { configurarAvisos } = await import("@/lib/whatsapp");
      const { whatsappConfigurado } = await import("@/lib/conexoes");
      if (whatsappConfigurado())
        aviso = await configurarAvisos(appOrigin()).then(
          (endereco) => (endereco ? "Endereço de avisos cadastrado no provedor." : null),
          (err: Error) => `Credenciais salvas, mas o provedor não aceitou o endereço de avisos: ${err.message}`,
        );
    }
    return { ...(await statusConexoes(appOrigin())), aviso };
  });
}
