"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AccountUsage } from "@/lib/saas-plan";
import { REGRA_SENHA } from "@/lib/conta-comum";
import { Icon, StudioShell, request } from "./StudioUI";
import { PasswordStrength } from "./PasswordStrength";

type Account = { name: string; email: string; hasPassword: boolean; google: boolean; usage: AccountUsage };

const monthLabel = (month: string) => {
  const [year, value] = month.split("-").map(Number);
  return new Date(year, value - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
};

const count = (n: number) => n.toLocaleString("pt-BR");
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;

function UsageMeter({ label, used, limit, note, format = count }: { label: string; used: number; limit: number | null; note: string; format?: (n: number) => string }) {
  const left = limit === null ? null : Math.max(0, limit - used);
  return (
    <div className={"account-usage" + (left === 0 ? " exhausted" : "")}>
      <div><strong>{label}</strong><span>{limit === null ? `${format(used)} · ilimitado` : `${format(used)} de ${format(limit)}`}</span></div>
      {limit !== null && <progress aria-label={`${label}: ${format(used)} de ${format(limit)}`} value={Math.min(used, limit)} max={limit} />}
      <small>{limit === null ? "Sem limite no seu plano." : left === 0 ? "Limite atingido." : note}</small>
    </div>
  );
}

function Coupon({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the code stays visible to copy by hand */ }
  }
  return (
    <span className="account-coupon">
      <code>{code}</code>
      <button type="button" className="studio-button subtle" onClick={() => void copy()} aria-label={`Copiar cupom ${code}`}>
        <Icon name={copied ? "check" : "copy"} size={14} />{copied ? "Copiado" : "Copiar"}
      </button>
    </span>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState(""), [password, setPassword] = useState(""), [confirmPassword, setConfirm] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(""); setMessage("");
    if (password !== confirmPassword) { setError("As senhas não são iguais."); return; }
    setBusy(true);
    try {
      await request("/api/conta/senha", "POST", { current, password, confirmPassword });
      setCurrent(""); setPassword(""); setConfirm("");
      setMessage("Senha alterada. As outras sessões desta conta foram encerradas.");
    } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível alterar a senha."); }
    finally { setBusy(false); }
  }
  return (
    <form className="account-password" onSubmit={submit}>
      <label className="account-field">Senha atual<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required maxLength={256} autoComplete="current-password" /></label>
      <div className="account-new-password">
        <label className="account-field">Nova senha<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={256} autoComplete="new-password" aria-describedby="password-rule" /></label>
        <small id="password-rule">{REGRA_SENHA}</small>
        <PasswordStrength password={password} />
      </div>
      <label className="account-field">Confirmar nova senha<input type="password" value={confirmPassword} onChange={(e) => setConfirm(e.target.value)} required maxLength={256} autoComplete="new-password" /></label>
      {error && <p role="alert" className="account-error">{error}</p>}
      {message && <p role="status" className="account-success">{message}</p>}
      <div><button type="submit" className="studio-button primary" disabled={busy}>{busy ? "Alterando…" : "Alterar senha"}</button></div>
    </form>
  );
}

export function MyAccount() {
  const [account, setAccount] = useState<Account | null>(null), [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setAccount(await request<Account>("/api/conta")); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Não foi possível carregar sua conta."); }
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  const usage = account?.usage, beta = usage?.plan === "beta";
  return (
    <StudioShell active="account">
      <main className="library-page account-page">
        <header className="library-header">
          <div>
            <div className="studio-breadcrumb">Workspace / Minha conta</div>
            <h1>Minha conta</h1>
            <p>Seus dados de acesso e o uso do plano.</p>
          </div>
        </header>
        {error && <p role="alert" className="account-error">{error} <button type="button" className="studio-button subtle" onClick={() => void load()}>Tentar novamente</button></p>}
        {!account && !error && <p className="settings-loading" role="status">Carregando…</p>}
        {account && usage && <>
          {beta && (
            <section className="library-connect-banner account-upgrade account-card" aria-labelledby="account-ai-action">
              <Icon name="spark" size={23} />
              <div>
                <h2 id="account-ai-action">Faça parte do AI Action</h2>
                <p>Tenha execuções mensais e fluxos ilimitados. Seu cupom exclusivo já vai aplicado ao garantir a vaga:</p>
                <Coupon code={usage.coupon} />
              </div>
              <div className="account-upgrade-actions">
                <a className="studio-button" href={usage.upgradeUrl} target="_blank" rel="noopener noreferrer">Conhecer o programa</a>
                <a className="studio-button primary" href={usage.checkoutUrl} target="_blank" rel="noopener noreferrer">Garantir minha vaga</a>
              </div>
            </section>
          )}
          <section className="credential-manager-card account-card" aria-labelledby="account-profile">
            <h2 id="account-profile">Perfil</h2>
            <dl className="account-profile">
              <div><dt>Nome</dt><dd>{account.name}</dd></div>
              <div><dt>E-mail</dt><dd>{account.email}</dd></div>
              <div><dt>Acesso</dt><dd>{[account.hasPassword && "E-mail e senha", account.google && "Google"].filter(Boolean).join(" · ")}</dd></div>
            </dl>
          </section>
          <section className="credential-manager-card account-card" aria-labelledby="account-usage">
            <div className="account-card-title">
              <h2 id="account-usage">Limites de uso</h2>
              <span className={"account-plan" + (beta ? "" : " unlimited")}>{beta ? "Beta" : "AI Action"}</span>
            </div>
            <UsageMeter label={`Execuções em ${monthLabel(usage.month)}`} used={usage.runs.used} limit={usage.runs.limit} note="Renova no primeiro dia de cada mês." />
            <UsageMeter label="Fluxos" used={usage.flows.used} limit={usage.flows.limit} note="Excluir um fluxo libera espaço para outro." />
            <UsageMeter label="Armazenamento das bases de conhecimento" used={usage.storage.used} limit={usage.storage.limit} format={megabytes}
              note="Arquivos enviados às bases, até 10 MB cada. Excluir fontes libera espaço." />
          </section>
          {account.hasPassword && (
            <section className="credential-manager-card account-card" aria-labelledby="account-password">
              <h2 id="account-password">Alterar senha</h2>
              <PasswordForm />
            </section>
          )}
        </>}
      </main>
    </StudioShell>
  );
}
