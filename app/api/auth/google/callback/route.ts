import { finishGoogleLogin } from "@/lib/saas-google";
import { saasDatabase } from "@/lib/saas-db";
import { appOrigin } from "@/lib/saas-security";
import { inviteCookie, inviteFromRequest, sessionCookie } from "@/lib/saas-http";
import { redeemInvite } from "@/lib/saas-auth";
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const binding = req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("agentflows_google="))?.slice("agentflows_google=".length);
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", `agentflows_google=; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=0${appOrigin().startsWith("https:") ? "; Secure" : ""}`);
  try {
    const db = saasDatabase();
    const { user, token } = await finishGoogleLogin(db, { state: params.get("state"), binding, code: params.get("code") });
    headers.append("Set-Cookie", sessionCookie(token));
    let approved = user.beta_status === "approved";
    // Convite guardado no navegador (?invite= visto pelo proxy): aplicado aqui, sem passar por Seu acesso.
    const invite = inviteFromRequest(req);
    if (!approved && invite) {
      try { await redeemInvite(db, user.id, invite); approved = true; headers.append("Set-Cookie", inviteCookie("", true)); }
      catch { /* Seu acesso tenta de novo e explica o problema do convite */ }
    }
    headers.set("Location", new URL(approved ? "/" : "/acesso", appOrigin()).href);
  } catch {
    headers.set("Location", new URL("/entrar?erro=google", appOrigin()).href);
  }
  return new Response(null, { status: 303, headers });
}
