"use client";
import { forcaSenha } from "@/lib/conta-comum";

/**
 * Nível da senha em quatro barras (fraca, razoável, boa, forte), calculado por forcaSenha.
 * Usado no cadastro, na redefinição de senha e em Minha conta; o texto é anunciado por leitores de tela.
 */
export function PasswordStrength({ password }: { password: string }) {
  const { nivel, rotulo } = forcaSenha(password);
  return (
    <div className="password-strength" data-level={nivel} role="status" aria-live="polite">
      <span className="password-strength-bars" aria-hidden="true">
        {[1, 2, 3, 4].map((bar) => <span key={bar} className={bar <= nivel ? "filled" : undefined} />)}
      </span>
      <span className="password-strength-label">{rotulo}</span>
    </div>
  );
}
