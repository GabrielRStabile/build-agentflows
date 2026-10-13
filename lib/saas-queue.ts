import { createClient } from "redis";

const newClient = () => createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true, commandOptions: { timeout: 2000 }, socket: { connectTimeout: 2000, reconnectStrategy: false } });
type Connection = ReturnType<typeof newClient>;
let connection: Connection | undefined;
let connecting: Promise<Connection> | undefined;
const KEY = "agentflows:jobs:v1";
export async function redisClient() {
  if (!process.env.REDIS_URL) throw new Error("Configure REDIS_URL.");
  if (connection?.isReady) return connection;
  if (connecting) return connecting;
  if (connection?.isOpen) connection.destroy();
  const next = newClient();
  next.on("error", () => {}); // Never log connection URLs/passwords.
  connection = next;
  connecting = next.connect().then(() => next).finally(() => { connecting = undefined; });
  return connecting;
}
/** Queue contains opaque job IDs only. The database handles authorization, leases and recovery. */
export async function notifyJob(id: string) {
  try {
    const redis = await redisClient();
    await redis.multi().rPush(KEY, id).lTrim(KEY, -2000, -1).exec();
    return true;
  } catch { return false; } // Accepted PostgreSQL jobs remain available to the worker's reconciliation.
}
export async function nextJobNotification() {
  try { return await (await redisClient()).lPop(KEY); } catch { return null; }
}
/** Blocks up to `seconds` for the next notification, so a worker with a free slot starts a job the moment it is queued
 * instead of on its next tick. Returns null on timeout or when Redis is unavailable (the caller then paces itself). */
export async function waitJobNotification(seconds: number) {
  try { return (await (await redisClient()).blPop(KEY, seconds))?.element ?? null; } catch { return null; }
}
export async function queueReady() { try { return await (await redisClient()).ping() === "PONG"; } catch { return false; } }
export function closeQueue() { if (connection?.isOpen) connection.destroy(); connection = undefined; }
