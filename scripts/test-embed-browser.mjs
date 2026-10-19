import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// Called by the isolated Docker fixture; uses no real credentials or paid models.
export async function verifyEmbedBrowser(origin, fixture) {
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const a = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await a.addCookies([{ name: "agentflows_session", value: fixture.tokenA, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const page = await a.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/credenciais");
    await page.getByText(/Replicate.*conexão existente/).waitFor();
    assert.equal(await page.getByText(/Replicate.*conexão existente/).count(), 1);
    await page.goto(origin + "/embed-preview/" + fixture.flowId);
    await page.getByRole("button", { name: "Abrir conversa", exact: true }).click();
    const chat = page.frameLocator('iframe[title="Conversa com o assistente"]');
    await chat.getByRole("textbox", { name: "Sua mensagem" }).fill("Teste no navegador");
    await chat.getByRole("button", { name: "Enviar mensagem" }).click();
    await chat.getByText("Worker completed", { exact: true }).waitFor({ timeout: 30000 });
    await page.reload();
    await chat.getByText("Worker completed", { exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/agentflows-embed-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await chat.locator("body").evaluate(body => body.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: "/tmp/agentflows-embed-mobile.png", fullPage: true });
    assert.deepEqual(errors, []);

    // Sair e voltar ao fluxo traz a conversa de teste; depois de limpa, ela não volta.
    page.on("dialog", dialog => dialog.accept());
    await page.setViewportSize({ width: 1280, height: 900 });
    const chatKey = "agentflows-chat:" + fixture.flowId;
    const reopen = async () => {
      await page.goto(origin + "/");
      await page.goto(origin + "/flows/" + fixture.flowId);
      await page.getByRole("button", { name: "Testar Fluxo Agêntico" }).click();
    };
    await page.goto(origin + "/");
    await page.evaluate(([key, ids]) => localStorage.setItem(key, JSON.stringify(ids)), [chatKey, fixture.runs.slice(0, 2)]);
    await reopen();
    const popup = page.locator(".chat-popup");
    await popup.getByText("Test 1", { exact: true }).waitFor();
    assert.equal(await popup.getByText("Test 0", { exact: true }).count(), 1);
    assert.equal(await popup.getByText("Worker completed", { exact: true }).count(), 2);
    await page.getByRole("button", { name: "Limpar conversa" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Limpar conversa" }).click();
    await reopen();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), chatKey), "[]");
    assert.equal(await popup.getByText("Test 1", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);

    const b = await browser.newContext();
    await b.addCookies([{ name: "agentflows_session", value: fixture.tokenB, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const other = await b.newPage();
    const connections = other.waitForResponse(response => response.url().endsWith("/api/tool-credentials") && response.request().method() === "GET");
    await other.goto(origin + "/credenciais");
    const media = await connections;
    assert.equal(media.status(), 200);
    assert.equal((await media.json()).some(c => c.provider.startsWith("ai_")), false);
    await other.getByText(/Nenhuma credencial salva/).waitFor();
    assert.equal((await b.request.get(origin + "/api/flows/" + fixture.flowId + "/embed")).status(), 404);

    // Bloco que não pode fechar: o motivo fica visível no rodapé do diálogo, e dá para descartar as alterações.
    const llmFlowId = await other.evaluate(async (graph) => (await (await fetch("/api/flows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Docker LLM", description: "", graph }) })).json()).id, fixture.llmGraph);
    assert.ok(llmFlowId);
    await other.goto(origin + "/flows/" + llmFlowId);
    await other.locator(".react-flow__node").filter({ hasText: /LLM/ }).first().dblclick();
    const dialog = other.locator("dialog.studio-modal[open]");
    await dialog.getByRole("combobox", { name: "Fornecedor" }).click();
    await dialog.getByRole("option", { name: "Replicate" }).click();
    await dialog.getByRole("textbox", { name: "Modelo da Replicate" }).waitFor();
    await dialog.evaluate(el => { el.scrollTop = 0; });
    const close = () => dialog.locator("header").getByRole("button", { name: "Fechar diálogo" }).click();
    await close();
    const blocked = dialog.locator(".node-close-error");
    await blocked.getByText(/Replicate/).waitFor();
    assert.equal(await dialog.count(), 1);
    const inView = () => blocked.evaluate(el => { const box = el.getBoundingClientRect(), frame = el.closest("dialog").getBoundingClientRect(); return box.top >= frame.top && box.bottom <= frame.bottom + 1; });
    assert.ok(await inView(), "aviso de fechamento fora da área visível do diálogo");
    await other.screenshot({ path: "/tmp/agentflows-node-close-error.png" });
    await other.setViewportSize({ width: 390, height: 844 });
    assert.ok(await inView(), "aviso de fechamento fora da área visível no celular");
    await other.screenshot({ path: "/tmp/agentflows-node-close-error-mobile.png" });
    await dialog.getByRole("textbox", { name: "Modelo da Replicate" }).fill("google/nano-banana");
    assert.equal(await blocked.count(), 0);
    await dialog.getByRole("textbox", { name: "Modelo da Replicate" }).fill("");
    await close();
    await blocked.getByRole("button", { name: "Descartar alterações" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await other.evaluate(async (id) => (await fetch("/api/flows/" + id, { method: "DELETE" })).status, llmFlowId), 200);

    // Decisão: fornecedor, credencial, modelo e perguntas no diálogo; cada opção da primeira pergunta vira uma saída.
    await other.setViewportSize({ width: 1280, height: 900 });
    const decisionFlowId = await other.evaluate(async (graph) => (await (await fetch("/api/flows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Docker Decisão", description: "", graph }) })).json()).id, fixture.decisionGraph);
    assert.ok(decisionFlowId);
    await other.goto(origin + "/flows/" + decisionFlowId);
    const decisionNode = other.locator(".react-flow__node").filter({ hasText: /Decisão/ }).first();
    await decisionNode.getByLabel("Saída Incerta de Decisão").waitFor({ state: "attached" });
    await decisionNode.dblclick();
    await dialog.getByRole("combobox", { name: "Credencial OpenRouter" }).waitFor();
    assert.equal(await dialog.getByRole("combobox", { name: "Modelo de decisão" }).inputValue(), "openrouter:~typesafe/jev-latest");
    // Trocar o fornecedor escolhe o modelo da OpenAI e a credencial passa a ser da OpenAI.
    await dialog.getByRole("combobox", { name: "Fornecedor da decisão" }).selectOption("openai");
    assert.equal(await dialog.getByRole("combobox", { name: "Modelo de decisão" }).inputValue(), "openai:gpt-6-luna");
    await dialog.getByRole("combobox", { name: "Credencial OpenAI" }).waitFor();
    assert.equal(await dialog.getByRole("textbox", { name: "Opção 1 da pergunta 1", exact: true }).inputValue(), "suporte");
    await dialog.getByRole("button", { name: "Adicionar opção" }).click();
    await close();
    await blocked.getByText(/Preencha todas as opções/).waitFor();
    await dialog.getByRole("textbox", { name: "Opção 3 da pergunta 1", exact: true }).fill("financeiro");
    assert.equal(await blocked.count(), 0);
    await other.screenshot({ path: "/tmp/agentflows-decision-dialog.png" });
    await close();
    await dialog.waitFor({ state: "detached" });
    await decisionNode.getByLabel("Saída financeiro de Decisão").waitFor({ state: "attached" });
    assert.equal(await decisionNode.locator(".af-handle-out").count(), 4);
    await other.setViewportSize({ width: 390, height: 844 });
    await decisionNode.dblclick();
    await dialog.getByRole("group", { name: "Pergunta 1" }).waitFor();
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "diálogo da Decisão rola na horizontal no celular");
    await other.screenshot({ path: "/tmp/agentflows-decision-dialog-mobile.png" });
    await dialog.locator("header").getByRole("button", { name: "Fechar diálogo" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await other.evaluate(async (id) => (await fetch("/api/flows/" + id, { method: "DELETE" })).status, decisionFlowId), 200);
    console.log("Browser passed: separate accounts, iframe preview, queued conversation, reload, desktop and mobile.");
  } finally { await browser.close(); }
}
