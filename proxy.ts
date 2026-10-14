import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withEmbedOwner } from "@/lib/embed-http";
import { effectiveEmbedOrigins } from "@/lib/embed-security";
import { embedSettings, hasEmbedKey } from "@/lib/embed-store";
import { findSession } from "@/lib/saas-auth";
import { saasDatabase } from "@/lib/saas-db";
import { inviteCode, inviteCookie, sessionToken } from "@/lib/saas-http";

function rotaPublica(pathname: string, metodo: string): boolean {
  // Embed APIs authenticate signed, scoped tickets; no admin cookie crosses origins.
  if (pathname === "/embed.js" || /^\/embed\/[a-zA-Z0-9-]+$/.test(pathname)) return true;
  if (pathname === "/api/embed/token" || pathname === "/api/embed/session" || pathname === "/api/embed/attachments" || /^\/api\/embed\/attachments\/[a-zA-Z0-9-]+$/.test(pathname)) return true;
  if (pathname === "/mcp") return metodo === "POST" || metodo === "GET";
  if (pathname === "/api/health") return true;
  if (pathname === "/conta" || pathname === "/entrar") return true;
  if (pathname === "/icon.png" || pathname === "/apple-icon.png" || /^\/brand\/[a-z-]+\.png$/.test(pathname)) return true;
  if (pathname === "/webhook/whatsapp" || pathname === "/webhook/elevenlabs" || /^\/webhook\/flows\/[a-zA-Z0-9-]+$/.test(pathname)) return true;
  if (pathname.startsWith("/_next/")) return true;
  return false;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const invite = inviteCode(request.nextUrl.searchParams.get("invite"));
  const withInvite = <T extends NextResponse>(response: T) => {
    if (invite) response.headers.append("Set-Cookie", inviteCookie(invite));
    return response;
  };

  async function permitir() {
    const response = NextResponse.next();
    if (pathname.startsWith("/embed/") || pathname.startsWith("/api/embed/")) response.headers.set("Cache-Control", "no-store");
    if (/^\/embed\/[a-zA-Z0-9-]+$/.test(pathname)) {
      try { const s = await withEmbedOwner(pathname.split("/")[2], async () => { const settings = await embedSettings(pathname.split("/")[2]); return { ...settings, enabled: settings.enabled && hasEmbedKey(pathname.split("/")[2]), origins: effectiveEmbedOrigins(settings.origins) }; }); response.headers.set("Content-Security-Policy", "frame-ancestors " + (s.enabled ? "'self' " + s.origins.join(" ") : "'none'") + ";"); }
      catch { response.headers.set("Content-Security-Policy", "frame-ancestors 'none';"); }
      response.headers.set("Referrer-Policy", "no-referrer");
    }
    return response;
  }

  if (pathname === "/acesso") {
    // Conta já liberada não tem o que fazer em Seu acesso: vai direto para o espaço, sem convite pendente.
    try {
      const user = await findSession(saasDatabase(), sessionToken(request));
      if (user?.email_verified_at && user.beta_status === "approved") {
        const response = NextResponse.redirect(new URL("/", request.url));
        response.headers.append("Set-Cookie", inviteCookie("", true));
        return response;
      }
    } catch { /* sem banco, a página mostra o aviso de serviço indisponível */ }
  }
  const publicAuth = ["/entrar", "/conta", "/acesso", "/verificar-email", "/recuperar-senha", "/redefinir-senha"];
  if (publicAuth.includes(pathname)) return withInvite(await permitir());
  if (pathname.startsWith("/api/auth/") || pathname.startsWith("/_next/") || pathname === "/icon.png" || pathname === "/apple-icon.png" || pathname === "/api/health") return permitir();
  // Public integrations keep their own token/owner validation in their handlers.
  if (rotaPublica(pathname, request.method)) return permitir();
  try {
    const user = await findSession(saasDatabase(), sessionToken(request));
    if (user?.email_verified_at && user.beta_status === "approved") {
      // A released account has no use for the invite: clean the URL and any pending cookie.
      if (!request.nextUrl.searchParams.has("invite") || request.method !== "GET" || pathname.startsWith("/api/")) return permitir();
      const clean = request.nextUrl.clone();
      clean.searchParams.delete("invite");
      const response = NextResponse.redirect(clean);
      response.headers.append("Set-Cookie", inviteCookie("", true));
      return response;
    }
    if (pathname.startsWith("/api/") || pathname === "/mcp") return NextResponse.json({ error: user ? "Acesso ao beta pendente ou suspenso." : "Entre na sua conta." }, { status: user ? 403 : 401 });
    const destination = new URL(user ? "/acesso" : "/entrar", request.url);
    if (invite) destination.searchParams.set("invite", invite);
    return withInvite(NextResponse.redirect(destination));
  } catch { return NextResponse.json({ error: "Serviço temporariamente indisponível." }, { status: 503 }); }
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
