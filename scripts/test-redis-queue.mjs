// Uses an isolated Redis process, never the application's REDIS_URL.
// REDIS_SERVER=/path/to/redis-server npm run test:redis
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { notifyJob, nextJobNotification, waitJobNotification, queueReady, closeQueue } from "../lib/saas-queue.ts";

const binary = process.env.REDIS_SERVER;
if (!binary) throw new Error("Defina REDIS_SERVER para o executável redis-server de teste.");
const socket = createServer();
socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const dir = await mkdtemp(path.join(tmpdir(), "agentflows-redis-test-"));
const password = randomBytes(32).toString("hex");
process.env.REDIS_URL = `redis://:${password}@127.0.0.1:${port}`;
await writeFile(path.join(dir, "redis.conf"), `bind 127.0.0.1\nport ${port}\nrequirepass ${password}\nappendonly yes\nsave ""\ndir "${dir}"\nloglevel warning\n`, { mode: 0o600 });
let server;
async function start() {
  server = spawn(binary, [path.join(dir, "redis.conf")], { stdio: "ignore" });
  let error;
  server.on("error", (failure) => { error = failure; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (error) throw error;
    if (server.exitCode !== null) throw new Error("Redis de teste encerrou durante a inicialização.");
    if (await queueReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Redis de teste não ficou pronto.");
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exit = once(server, "exit"); server.kill("SIGTERM"); await exit;
}
try {
  await start();
  const first = randomUUID(), durable = randomUUID();
  assert.equal(await notifyJob(first), true);
  assert.equal(await nextJobNotification(), first);
  assert.equal(await nextJobNotification(), null);
  assert.equal(await notifyJob(durable), true);
  await stop();
  assert.equal(await notifyJob(randomUUID()), false, "queda não pode aparentar confirmação Redis");
  assert.equal(await nextJobNotification(), null);
  assert.equal(await queueReady(), false);
  await start();
  assert.equal(await nextJobNotification(), durable, "AOF preserva o aviso após reiniciar");
  const recovered = randomUUID();
  assert.equal(await notifyJob(recovered), true);
  assert.equal(await nextJobNotification(), recovered, "cliente reconecta sem reiniciar o app");
  const idleStarted = Date.now();
  assert.equal(await waitJobNotification(1), null, "espera bloqueante expira sem aviso");
  assert.ok(Date.now() - idleStarted >= 900, "espera bloqueante respeita o tempo");
  const awaited = randomUUID();
  const waiting = waitJobNotification(5);
  setTimeout(() => { void notifyJob(awaited); }, 100);
  const wakeStarted = Date.now();
  assert.equal(await waiting, awaited, "aviso acorda o worker imediatamente");
  assert.ok(Date.now() - wakeStarted < 2000, "acordou antes do tempo limite");
  console.log("Redis real: envio, consumo único, indisponibilidade, AOF e reconexão passaram.");
} finally {
  closeQueue(); await stop(); await rm(dir, { recursive: true, force: true });
}
