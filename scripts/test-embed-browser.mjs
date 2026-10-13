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
    console.log("Browser passed: separate accounts, iframe preview, queued conversation, reload, desktop and mobile.");
  } finally { await browser.close(); }
}
