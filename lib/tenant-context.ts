import { AsyncLocalStorage } from "node:async_hooks";
import { findSession, requireBetaAccess, TENANT_USER_FIELDS, type SaasUser } from "./saas-auth";
import type { Database } from "./saas-db";
import { AuthError } from "./saas-security";
import { loadConfigState, commitConfigState, type ConfigState } from "./tenant-config-state";

type TenantContext = { readonly user: Readonly<SaasUser>; readonly db: Database; readonly config: ConfigState; active: boolean };
const contexts = new AsyncLocalStorage<TenantContext>();

export function currentTenant(): TenantContext {
  const context = contexts.getStore();
  if (!context?.active) throw new AuthError("Contexto de usuário ausente ou encerrado.", 401);
  return context;
}

export function tenantId(): string { return currentTenant().user.id; }

async function run<T>(db: Database, user: SaasUser, action: () => T | Promise<T>): Promise<T> {
  if (contexts.getStore()) throw new Error("Não é permitido trocar de usuário dentro de uma operação.");
  requireBetaAccess(user);
  const context: TenantContext = { db, user: Object.freeze({ ...user }), config: await loadConfigState(db, user.id), active: true };
  return contexts.run(context, async () => {
    try {
      const result = await action();
      if (!(result instanceof Response) || result.ok || (result.status >= 300 && result.status < 400)) {
        await commitConfigState(db, user.id, context.config);
      }
      return result;
    }
    finally { context.active = false; }
  });
}

/** HTTP/Server Component entry: identity comes only from the validated session. */
export async function withTenantSession<T>(db: Database, token: string | undefined, action: () => T | Promise<T>) {
  const user = await findSession(db, token);
  requireBetaAccess(user);
  return run(db, user, action);
}

/** Worker entry: userId must be read from the persisted job, never from a request payload. */
export async function withTenantJob<T>(db: Database, userId: string, action: () => T | Promise<T>) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(userId)) throw new AuthError("Usuário inválido.", 401);
  const { rows } = await db.query<SaasUser>(`SELECT ${TENANT_USER_FIELDS} FROM users u WHERE u.id=$1`, [userId]);
  const user = rows[0] || null;
  requireBetaAccess(user);
  return run(db, user, action);
}
