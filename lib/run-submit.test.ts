import test from "node:test";
import assert from "node:assert/strict";
import { isTransient, submitRun } from "./run-submit";

const failure = (status?: number, message = "erro") => Object.assign(new Error(message), status === undefined ? {} : { status });
const sleep = async () => {};

test("erros de rede e de gateway são transitórios; respostas do servidor não", () => {
  assert.equal(isTransient(new TypeError("Failed to fetch")), true);
  assert.equal(isTransient(failure(502)), true);
  assert.equal(isTransient(failure(503)), true);
  assert.equal(isTransient(failure(0)), true);
  assert.equal(isTransient(failure(400, "Entrada inválida")), false);
  assert.equal(isTransient(failure(429)), false);
  assert.equal(isTransient(failure(500)), false);
});

test("resposta perdida: a repetição adota a execução já criada em vez de criar outra", async () => {
  let posts = 0, finds = 0;
  const run = { id: "r1" };
  const result = await submitRun({
    post: async () => { posts++; throw new TypeError("Failed to fetch"); },
    find: async () => { finds++; return finds >= 1 ? run : null; },
    sleep,
  });
  assert.equal(result, run);
  assert.equal(posts, 1);
});

test("servidor nunca recebeu o pedido: repete o POST até o limite e devolve o último erro", async () => {
  let posts = 0;
  const ok = { id: "r2" };
  const result = await submitRun({ post: async () => { posts++; if (posts < 3) throw failure(503); return ok; }, find: async () => null, sleep });
  assert.equal(result, ok); assert.equal(posts, 3);
  posts = 0;
  await assert.rejects(submitRun({ post: async () => { posts++; throw failure(502, "Bad gateway"); }, find: async () => null, attempts: 3, sleep }), /Bad gateway/);
  assert.equal(posts, 3);
});

test("erro de validação não repete; 409 adota a execução existente ou propaga", async () => {
  let posts = 0;
  await assert.rejects(submitRun({ post: async () => { posts++; throw failure(400, "Entrada inválida"); }, find: async () => ({ id: "x" }), sleep }), /Entrada inválida/);
  assert.equal(posts, 1);
  const existing = { id: "r3" };
  assert.equal(await submitRun({ post: async () => { throw failure(409, "Já existe"); }, find: async () => existing, sleep }), existing);
  await assert.rejects(submitRun({ post: async () => { throw failure(409, "Limite"); }, find: async () => null, sleep }), /Limite/);
});
