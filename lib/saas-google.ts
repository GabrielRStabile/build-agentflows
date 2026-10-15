import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Database } from "./saas-db";
import { appOrigin, AuthError, hashToken, randomToken, seal, unseal } from "./saas-security";
import { loginGoogleIdentity } from "./saas-auth";
import { addressLimit, consumeRateLimit } from "./saas-rate-limit";

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
type OAuthPayload = { verifier: string; nonce: string };
function settings() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new AuthError("Login com Google indisponível.", 503);
  return { clientId, clientSecret, redirect: `${appOrigin()}/api/auth/google/callback` };
}

export async function beginGoogleLogin(db: Database, client: string) {
  await consumeRateLimit(db, `google:ip:${client}`, addressLimit(client), 600);
  const config = settings();
  const state = randomToken(), binding = randomToken(), verifier = randomToken(), nonce = randomToken();
  const stateHash = hashToken(state);
  await db.query(`INSERT INTO oauth_states(state_hash,binding_hash,payload_ciphertext,expires_at)
    VALUES ($1,$2,$3,now()+interval '10 minutes')`, [stateHash, hashToken(binding), seal(JSON.stringify({ verifier, nonce }), `oauth:${stateHash}`)]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirect, response_type: "code", scope: "openid email profile",
    state, nonce, code_challenge: Buffer.from(hashToken(verifier), "hex").toString("base64url"), code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), binding };
}

export async function verifyGoogleIdToken(idToken: string, nonce: string, keys: JWTVerifyGetKey = googleKeys) {
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: settings().clientId,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "nonce", "email", "email_verified"],
    maxTokenAge: "10m",
    clockTolerance: 5,
  });
  if (payload.nonce !== nonce || payload.email_verified !== true || typeof payload.email !== "string"
    || !payload.sub || payload.sub.length > 255 || (payload.azp !== undefined && payload.azp !== settings().clientId)) {
    throw new AuthError("Não foi possível validar sua conta Google.", 401);
  }
  return { sub: payload.sub, email: payload.email, name: typeof payload.name === "string" ? payload.name : "" };
}

export async function finishGoogleLogin(db: Database, data: { state: string | null; binding: string | undefined; code: string | null }, send: typeof fetch = fetch) {
  if (!data.state || !data.binding || !data.code || data.code.length > 4096
    || !/^[A-Za-z0-9_-]{43}$/.test(data.state) || !/^[A-Za-z0-9_-]{43}$/.test(data.binding)) throw new AuthError("Login Google expirado. Tente novamente.", 401);
  const stateHash = hashToken(data.state);
  // The browser binding is required; state alone cannot consume another browser's attempt.
  const { rows } = await db.query<{ payload_ciphertext: string }>(`DELETE FROM oauth_states
    WHERE state_hash=$1 AND binding_hash=$2 AND expires_at>now() RETURNING payload_ciphertext`, [stateHash, hashToken(data.binding)]);
  if (!rows[0]) throw new AuthError("Login Google expirado. Tente novamente.", 401);
  const payload = JSON.parse(unseal(rows[0].payload_ciphertext, `oauth:${stateHash}`)) as OAuthPayload;
  const config = settings();
  const response = await send("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirect,
      grant_type: "authorization_code", code: data.code, code_verifier: payload.verifier }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new AuthError("Não foi possível entrar com Google. Tente novamente.", 502); }
  const tokens = await response.json();
  if (typeof tokens.id_token !== "string") throw new AuthError("Resposta Google inválida.", 502);
  let identity;
  try { identity = await verifyGoogleIdToken(tokens.id_token, payload.nonce); }
  catch { throw new AuthError("Não foi possível validar sua conta Google.", 401); }
  // OAuth access/refresh tokens are never stored; this flow only authenticates the user.
  return loginGoogleIdentity(db, identity);
}
