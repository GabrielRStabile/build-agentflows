"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { REGRA_SENHA } from "@/lib/conta-comum";
import { readJson, unavailableMessage } from "./StudioUI";
import { ConnectionsBackground } from "./ConnectionsBackground";
import { PasswordStrength } from "./PasswordStrength";

type Mode = "login" | "register" | "forgot-password" | "verify-email" | "reset-password" | "access";
type User = { name: string; email: string; email_verified_at: string | null; beta_status: "pending" | "approved" | "blocked" };
const titles: Record<Mode, string> = { login: "Entrar", register: "Criar sua conta", "forgot-password": "Recuperar senha", "verify-email": "Confirmar e-mail", "reset-password": "Nova senha", access: "Seu acesso ao beta" };
function nextDestination() {
  const next = new URLSearchParams(window.location.search).get("next") || "/";
  return next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
}
// Same rules as the server (inviteCode); the proxy also keeps it in a private cookie.
function inviteFromUrl() {
  const code = (new URLSearchParams(window.location.search).get("invite") || "").trim();
  return code.length >= 8 && code.length <= 128 && /^[\x21-\x7e]+$/.test(code) ? code : "";
}
async function request(action: string, data?: Record<string, unknown>) {
  const response = await fetch(`/api/auth/${action}`, { method: data ? "POST" : "GET", cache: "no-store",
    headers: data ? { "Content-Type": "application/json" } : undefined, body: data ? JSON.stringify(data) : undefined });
  const result = await readJson(response);
  if (!response.ok || result === undefined) throw new Error(result?.error || (response.status >= 500 ? unavailableMessage(response.status) : "Não foi possível concluir. Tente novamente."));
  return result as { user: User; message?: string; invitePending?: boolean };
}
function GoogleIcon() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48" className="shrink-0">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>;
}
/** Reenvio do link de confirmação liberado só depois de uma espera, e com nova espera a cada envio. */
function ResendButton({ email, initialWait, busy, onResult }: { email: string; initialWait: number; busy: boolean; onResult: (message: string, error?: string) => void }) {
  const [remaining, setRemaining] = useState(initialWait);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);
  async function resend() {
    setSending(true);
    try { const result = await request("resend-verification", { email }); onResult(result.message || "Enviamos um novo link para seu e-mail."); setRemaining(60); }
    catch (e) { onResult("", (e as Error).message); }
    finally { setSending(false); }
  }
  return <button type="button" className="btn-secundario" disabled={busy || sending || remaining > 0} aria-live="polite" onClick={() => void resend()}>
    {sending ? "Reenviando…" : remaining > 0 ? `Reenviar e-mail em ${remaining} s` : "Reenviar e-mail"}
  </button>;
}
export function AccountScreen({ mode, google = false }: { mode: Mode; google?: boolean }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(mode !== "access");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const [invite, setInvite] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [invitePending, setInvitePending] = useState(false);
  const withInvite = (path: string) => invite ? `${path}?invite=${encodeURIComponent(invite)}` : path;
  useEffect(() => {
    let live = true;
    async function initialize() {
      // Defer browser URL access until hydration. Never consume a token on a GET or preview.
      await Promise.resolve();
      if (!live) return;
      const linked = inviteFromUrl();
      setInvite(linked);
      if (mode === "verify-email" || mode === "reset-password") {
        const value = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
        setToken(value);
        window.history.replaceState(null, "", window.location.pathname + (linked ? `?invite=${encodeURIComponent(linked)}` : ""));
      }
      if (mode === "login" && new URLSearchParams(window.location.search).get("erro") === "google") setError("Não foi possível entrar com Google. Tente novamente ou entre com sua senha.");
      if (mode === "access") {
        try {
          const data = await request("session");
          if (!live) return;
          setUser(data.user); setCode(linked); setInvitePending(!!(linked || data.invitePending)); setLoaded(true);
          // A confirmed account waiting for release uses the invite link without another click.
          if (data.user?.email_verified_at && data.user.beta_status === "pending" && (linked || data.invitePending)) {
            setRedeeming(true);
            try {
              await request("invite", linked ? { code: linked } : {});
              if (live) { router.replace("/"); router.refresh(); }
            } catch (e) { if (live) { setError((e as Error).message); setRedeeming(false); setInvitePending(false); } }
          }
        } catch (e) { if (live) { setError((e as Error).message); setLoaded(true); } }
      }
    }
    void initialize();
    return () => { live = false; };
  }, [mode, router]);
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void act(async () => {
      if ((mode === "register" || mode === "reset-password") && password !== confirmPassword) throw new Error("As senhas não são iguais.");
      const action = mode === "access" ? "invite" : mode;
      const result = await request(action, { name, email, password, confirmPassword, token, code });
      if (mode === "login") {
        router.replace(result.user.email_verified_at && result.user.beta_status === "approved" ? nextDestination() : withInvite("/acesso"));
        router.refresh();
      } else if (mode === "access") { router.replace("/"); router.refresh(); }
      else {
        // O cadastro mostra seu próprio painel de confirmação; a mensagem genérica do servidor não é repetida.
        if (mode !== "register") setMessage(result.message || (mode === "verify-email" ? "E-mail confirmado. Entre para acompanhar seu acesso ao beta." : "Senha redefinida. Entre com sua nova senha."));
        setDone(true); setPassword(""); setConfirmPassword(""); setToken("");
      }
    });
  }
  const emailField = ["login", "register", "forgot-password"].includes(mode);
  const passwordField = ["login", "register", "reset-password"].includes(mode);
  const social = google && (mode === "login" || mode === "register");
  const registered = mode === "register" && done;
  const onResend = (text: string, failure?: string) => { setError(failure || ""); setMessage(failure ? "" : text); };
  return <main className="relative isolate min-h-screen bg-bg flex items-center justify-center px-4 py-10">
    {(mode === "login" || mode === "register") && <ConnectionsBackground />}
    <div className="relative w-full max-w-[440px]">
      <div className="flex justify-center mb-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/agentflows-logo.png" alt="Agentflows" width={184} height={40} className="h-10 w-auto" />
      </div>
      <section className="card p-7 max-md:p-6">
        <h1 className="text-[22px] font-extrabold mb-2 text-center">{registered ? "Confira seu e-mail" : titles[mode]}</h1>
        {!registered && <p className="text-muted text-sm mb-5 text-center">{mode === "register" ? "Crie sua conta e confirme seu e-mail. O beta exige um convite ou a liberação da equipe." : mode === "access" ? "Seus fluxos, conexões e bases de conhecimento ficam no seu espaço." : "Acesse seu espaço de agentes."}</p>}
        {error && <p role="alert" className="mb-4 text-sm text-danger text-center">{error}</p>}
        {message && <p role="status" className="mb-4 text-sm text-center">{message}</p>}
        {registered ? <div className="text-center">
          <span aria-hidden="true" className="mx-auto mb-4 w-14 h-14 rounded-full bg-accent-soft text-accent-ink grid place-items-center"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16v12H4z" /><path d="m4 7 8 6 8-6" /></svg></span>
          <p className="text-sm mb-2">Enviamos um link de confirmação para <strong className="break-all">{email}</strong>.</p>
          <p className="text-sm text-muted mb-5">Abra o link para ativar sua conta. Ele vale por 24 horas. Não chegou? Confira a pasta de spam ou promoções. Se você já tinha conta com este e-mail, entre com sua senha.</p>
          <ResendButton email={email} initialWait={30} busy={busy} onResult={onResend} />
        </div> : mode === "access" ? <>
          {!loaded ? <p role="status">Consultando seu acesso…</p> : !user ? <p><Link href={withInvite("/entrar")}>Entre na sua conta</Link> para acompanhar sua liberação.</p> : <>
            <div className="flex items-center gap-3 rounded-field border border-line bg-surface-2 px-4 py-3 mb-5">
              <span aria-hidden="true" className="w-9 h-9 shrink-0 rounded-full bg-accent-soft text-accent-ink grid place-items-center font-bold">{user.name.trim().charAt(0).toUpperCase() || "?"}</span>
              <span className="min-w-0 flex-1"><strong className="block text-sm truncate">{user.name}</strong><span className="block text-xs text-muted truncate">{user.email}</span></span>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${user.beta_status === "blocked" ? "bg-danger/10 text-danger" : !user.email_verified_at ? "bg-warn/10 text-warn" : user.beta_status === "approved" ? "bg-ok/10 text-ok" : "bg-accent-soft text-accent-ink"}`}>{user.beta_status === "blocked" ? "Suspenso" : !user.email_verified_at ? "E-mail pendente" : user.beta_status === "approved" ? "Liberado" : "Lista de espera"}</span>
            </div>
            {user.beta_status === "blocked" ? <p role="status" className="text-sm">Seu acesso está suspenso. Entre em contato com a equipe do beta.</p>
              : !user.email_verified_at ? <><p className="text-sm mb-4">Confirme o link enviado para <strong>{user.email}</strong> antes de utilizar seu convite.{invitePending && " Seu convite fica guardado e será aplicado quando você voltar a esta página com o e-mail confirmado."}</p><p className="text-sm text-muted mb-4">Não chegou? Confira a pasta de spam ou promoções.</p><ResendButton email={user.email} initialWait={15} busy={busy} onResult={onResend} /></>
              : user.beta_status === "approved" ? <Link className="btn-primary" href="/">Abrir meu espaço</Link>
              : redeeming ? <p role="status" className="text-sm">Validando seu convite…</p>
              : <><form onSubmit={submit}>
                  <label htmlFor="invite-code" className="block text-sm font-semibold mb-1">Tem um código de convite?</label>
                  <p id="invite-help" className="text-xs text-muted mb-2">Informe o código para liberar seu acesso na hora.</p>
                  <input id="invite-code" aria-describedby="invite-help" className="input mb-3 font-mono tracking-wide" placeholder="Cole o código aqui" value={code} onChange={(e) => setCode(e.target.value)} required minLength={8} maxLength={128} autoComplete="off" spellCheck={false} />
                  <button className="btn-primary" disabled={busy}>{busy ? "Conferindo…" : "Usar convite"}</button>
                </form>
                <div className="flex items-center gap-3 my-5 text-xs text-muted" aria-hidden="true"><span className="h-px flex-1 bg-line" />ou<span className="h-px flex-1 bg-line" /></div>
                <p className="text-sm text-muted mb-3">Sem convite? A equipe libera novos acessos aos poucos. Você pode conferir se já foi liberado.</p>
                <button className="btn-secundario" disabled={busy} onClick={() => void act(async () => { const result = await request("session"); setUser(result.user); if (result.user?.beta_status !== "approved") setMessage("Seu acesso ainda está na lista de espera."); })}>Verificar liberação</button></>}
          </>}
        </> : !done && <>
          {social && <>
            <form action="/api/auth/google" method="get"><button className="btn-secundario" disabled={busy}><GoogleIcon />Continuar com Google</button></form>
            <div className="flex items-center gap-3 my-5 text-xs text-muted" aria-hidden="true"><span className="h-px flex-1 bg-line" />ou com e-mail<span className="h-px flex-1 bg-line" /></div>
          </>}
          <form onSubmit={submit} className="space-y-4">
          {mode === "register" && <label className="block text-sm" htmlFor="name">Seu nome<input id="name" className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name" /></label>}
          {emailField && <label className="block text-sm" htmlFor="email">E-mail<input id="email" className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="email" /></label>}
          {passwordField && <div>
            <label className="block text-sm" htmlFor="password">Senha<input id="password" className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={256} autoComplete={mode === "login" ? "current-password" : "new-password"} aria-describedby={mode === "login" ? undefined : "password-rule"} /></label>
            {mode !== "login" && <><span id="password-rule" className="text-muted text-xs block mt-1">{REGRA_SENHA}</span><PasswordStrength password={password} /></>}
          </div>}
          {mode === "login" && <p className="-mt-2 text-right"><Link href={withInvite("/recuperar-senha")} className="btn-link text-xs">Esqueci minha senha</Link></p>}
          {(mode === "register" || mode === "reset-password") && <label className="block text-sm" htmlFor="confirm-password">Confirmar senha<input id="confirm-password" className="input mt-1" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required maxLength={256} autoComplete="new-password" /></label>}
          {(mode === "verify-email" || mode === "reset-password") && !token && <p className="text-sm">Abra o link recebido por e-mail para continuar.</p>}
          <button className="btn-primary" disabled={busy || ((mode === "verify-email" || mode === "reset-password") && !token)}>{busy ? "Aguarde…" : titles[mode]}</button>
          </form>
        </>}
        {(mode !== "access" || user) && <nav aria-label="Opções de acesso" className="flex gap-x-4 gap-y-2 flex-wrap justify-center mt-6 pt-5 border-t border-line text-sm text-muted">
          {mode === "login" && <span>Não tem conta? <Link href={withInvite("/conta")} className="btn-link">Criar conta</Link></span>}
          {mode === "register" && <span>{registered ? "Já confirmou? " : "Já tem conta? "}<Link href={withInvite("/entrar")} className="btn-link">Entrar</Link></span>}
          {mode !== "login" && mode !== "register" && mode !== "access" && <Link href={withInvite("/entrar")} className="btn-link">Entrar</Link>}
          {mode === "verify-email" && <Link href={withInvite("/acesso")} className="btn-link">Reenviar confirmação</Link>}
          {mode === "reset-password" && <Link href={withInvite("/recuperar-senha")} className="btn-link">Pedir novo link</Link>}
          {mode === "access" && user && <span>Não é você? <button type="button" className="btn-link" disabled={busy} onClick={() => void act(async () => { await request("logout", {}); router.replace(withInvite("/entrar")); router.refresh(); })}>Sair da conta</button></span>}
        </nav>}
      </section>
    </div>
  </main>;
}
