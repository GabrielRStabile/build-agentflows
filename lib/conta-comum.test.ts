import test from "node:test";
import assert from "node:assert/strict";
import { forcaSenha, senhaFraca } from "./conta-comum";

test("forcaSenha: vazia não tem nível nem rótulo", () => {
  assert.deepEqual(forcaSenha(""), { nivel: 0, rotulo: "" });
});

test("forcaSenha: curta ou de um só tipo é fraca", () => {
  assert.deepEqual(forcaSenha("abc"), { nivel: 1, rotulo: "Senha fraca" });
  assert.deepEqual(forcaSenha("abcdefgh"), { nivel: 1, rotulo: "Senha fraca" });
});

test("forcaSenha: enquanto a regra não é cumprida o nível para em razoável", () => {
  assert.equal(senhaFraca("Abcdefg1"), "Mínimo de 8 caracteres, com letra maiúscula, minúscula, número e caractere especial.");
  assert.deepEqual(forcaSenha("Abcdefg1"), { nivel: 2, rotulo: "Senha razoável" });
  // Longa, com especial, mas sem maiúscula nem número: continua bloqueada pelo servidor.
  assert.deepEqual(forcaSenha("abcdefghijkl!!!!"), { nivel: 2, rotulo: "Senha razoável" });
});

test("forcaSenha: senha válida é boa e, com 12 caracteres ou mais, forte", () => {
  assert.equal(senhaFraca("Abcdef1!"), null);
  assert.deepEqual(forcaSenha("Abcdef1!"), { nivel: 3, rotulo: "Senha boa" });
  assert.deepEqual(forcaSenha("Abcdefghij1!"), { nivel: 4, rotulo: "Senha forte" });
});
