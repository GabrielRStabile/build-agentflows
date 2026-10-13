import test from "node:test";
import assert from "node:assert/strict";
import { editorChatKey, readEditorChat, writeEditorChat } from "./editor-chat";
function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}
test("conversa do editor volta ao reabrir o fluxo e some depois de limpa", () => {
  const store = memory();
  assert.deepEqual(readEditorChat(store, "f1"), []);
  writeEditorChat(store, "f1", ["r1", "r2"]);
  assert.deepEqual(readEditorChat(store, "f1"), ["r1", "r2"]);
  assert.deepEqual(readEditorChat(store, "f2"), []);
  writeEditorChat(store, "f1", []);
  assert.deepEqual(readEditorChat(store, "f1"), []);
});
test("conteúdo inválido ou armazenamento indisponível não quebra o editor", () => {
  const store = memory();
  store.data.set(editorChatKey("f1"), "{");
  assert.deepEqual(readEditorChat(store, "f1"), []);
  store.data.set(editorChatKey("f1"), JSON.stringify(["r1", 3, "", "r1", "r2"]));
  assert.deepEqual(readEditorChat(store, "f1"), ["r1", "r2"]);
  const broken = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("cota"); } };
  assert.deepEqual(readEditorChat(broken, "f1"), []);
  assert.doesNotThrow(() => writeEditorChat(broken, "f1", ["r1"]));
});
