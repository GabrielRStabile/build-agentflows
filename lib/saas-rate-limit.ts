import type { Sql } from "./saas-db";
import { AuthError, hashToken } from "./saas-security";

export class RateLimitError extends AuthError {
  retryAfter: number;
  constructor(retryAfter: number) {
    super(`Muitas tentativas. Tente novamente em ${waitLabel(retryAfter)}.`, 429);
    this.retryAfter = retryAfter;
  }
}

const waitLabel = (seconds: number) => seconds < 60 ? `${seconds} segundo${seconds === 1 ? "" : "s"}` : `${Math.ceil(seconds / 60)} minuto${Math.ceil(seconds / 60) === 1 ? "" : "s"}`;
export const UNATTRIBUTED = "unattributed";
/** Without TRUSTED_CLIENT_IP_HEADER every request shares one key, so a per-address budget becomes app-wide. */
const SHARED_ADDRESS_FACTOR = 10;
/**
 * Per-address budget for account flows. A class on the same Wi-Fi leaves through one public IP (DEPLOY-COOLIFY.md,
 * 150 people), so these limits only stop floods; per-e-mail limits keep protecting accounts and inboxes.
 */
export const ADDRESS_LIMIT = 1000;
export const addressLimit = (client: string, perAddress = ADDRESS_LIMIT) => client === UNATTRIBUTED ? perAddress * SHARED_ADDRESS_FACTOR : perAddress;
/** Atomic shared fixed windows. No in-memory fallback when the database is unavailable. */
export async function consumeRateLimit(sql: Sql, key: string, limit: number, windowSeconds: number) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) throw new Error("Limite inválido.");
  const { rows } = await sql.query<{ hits: number; retry_after: number }>(`
    INSERT INTO rate_limits(key_hash,hits,resets_at) VALUES ($1,1,now()+$2*interval '1 second')
    ON CONFLICT(key_hash) DO UPDATE SET
      hits=CASE WHEN rate_limits.resets_at <= now() THEN 1 ELSE LEAST(rate_limits.hits+1,$3+1) END,
      resets_at=CASE WHEN rate_limits.resets_at <= now() THEN now()+$2*interval '1 second' ELSE rate_limits.resets_at END
    RETURNING hits, greatest(1,ceil(extract(epoch FROM resets_at-now())))::int AS retry_after
  `, [hashToken(key), windowSeconds, limit]);
  if (rows[0].hits > limit) throw new RateLimitError(rows[0].retry_after);
}

/** Only trust a header explicitly set AND overwritten by the deployment's reverse proxy. */
export function rateLimitClient(headers: Headers) {
  const header = process.env.TRUSTED_CLIENT_IP_HEADER;
  if (!header) return UNATTRIBUTED;
  return headers.get(header)?.trim().slice(0, 200) || UNATTRIBUTED;
}
