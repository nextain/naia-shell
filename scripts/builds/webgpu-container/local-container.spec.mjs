// Run against the built container: NAIA_TEST_URL=http://127.0.0.1:18026 TMPDIR=<run>/tmp node <this file>
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(process.env.NAIA_WEB_SOURCE_DIR ? `${process.env.NAIA_WEB_SOURCE_DIR}/packages/shell/package.json` : new URL('../../../packages/shell/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const base = process.env.NAIA_TEST_URL ?? 'http://127.0.0.1:18026';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const inference = process.env.NAIA_TEST_INFERENCE;
assert(inference && /^naia-026-r[356][_-]inference[_-]1$/.test(inference), 'Use the isolated round3/round5/round6 inference container');
const dir = process.env.TMPDIR;
assert(dir?.startsWith('/'), 'TMPDIR must be the run tmp directory');
mkdirSync(`${dir}/r3-shots`, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// Prohibit every remote service, including upstream optional metadata requests.
await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
const page = await context.newPage();
const logs = [], errors = [], requests = [];
page.on('console', msg => logs.push(msg.text()));
page.on('pageerror', error => errors.push(String(error)));
page.on('request', req => requests.push(req.url()));
let inferenceStopped = false;
const shot = name => page.screenshot({ path: `${dir}/r3-shots/${name}.png` });
try {
    await page.goto(base);
    await page.waitForFunction(() => window.__NAIA_WEB_ADK_STATUS__?.().phase !== 'checking' && !!window.__NAIA_WEB_ADK_STATUS__, null, { timeout: 60000 });
    const setup = page.getByTestId('web-workspace-start-default');
    if (await page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase) === "needs-setup") {
        await expect(setup).toBeVisible({ timeout: 15000 });
        await setup.click();
    }
    await page.waitForFunction(() => window.__NAIA_WEB_ADK_STATUS__?.().phase === 'ready', null, { timeout: 60000 });
    await page.locator('.app-bar-settings-btn').count();
    // Stable app action data attribute, or localized accessible title resolved from the rendered DOM.
    const settings = page.locator('.app-bar-settings');
    if (await settings.count()) await settings.click();
    else await page.locator('.app-bar button').filter({ has: page.locator('svg') }).last().click();
    let releaseModels;
    const modelGate = new Promise(resolve => { releaseModels = resolve; });
    await page.route('**/local-llm/v1/models', async route => { await modelGate; await route.continue(); });
    await page.locator('[data-settings-tab="brain"]').click();
    await expect(page.getByTestId('local-container-models').locator('button')).toBeDisabled();
    await shot('loading');
    releaseModels();
    await expect(page.locator('#provider-select')).toBeVisible({ timeout: 20000 });
    await page.locator('#provider-select').selectOption('local-container');
    const panel = page.getByTestId('local-container-models');
    await expect(panel.locator('select')).toBeVisible({ timeout: 15000 });
    await expect(panel.locator('select option[value="qwen2.5:0.5b"]')).toHaveCount(1);
    await page.unroute('**/local-llm/v1/models');
    await shot('models');
    await panel.locator('select').selectOption('qwen2.5:0.5b');
    await shot('models-selected');
    // Return through the same settings toggle.
    if (await settings.count()) await settings.click();
    else await page.locator('.app-bar button').filter({ has: page.locator('svg') }).last().click();
    const input = page.locator('.naia-chat-area .chat-input');
    await expect(input).toBeEnabled({ timeout: 20000 });
    const chunks = [];
    const session = await context.newCDPSession(page);
    await session.send('Network.enable');
    // Worker requests are verified by response text and Ollama logs; DOM mutation proves partial output.
    await page.evaluate(() => { window.__r2Mutations = []; new MutationObserver(() => { const el = document.querySelector('.naia-chat-area'); window.__r2Mutations.push(el?.querySelector(".chat-message.assistant.streaming .message-content")?.textContent); }).observe(document.querySelector('.naia-chat-area'), { subtree: true, childList: true, characterData: true }); });
    await input.fill('Reply in English. Count from one to ten.');
    await input.press('Enter');
    await expect(page.locator('.chat-cancel-btn')).toBeVisible({ timeout: 15000 });
    await shot('streaming');
    await expect(page.locator('.chat-cancel-btn')).toHaveCount(0, { timeout: 180000 });
    const texts = await page.evaluate(() => [...new Set(window.__r2Mutations.filter(Boolean))]);
    assert(texts.length > 3, 'Expected multiple streaming DOM updates');
    await shot('response');
    writeFileSync(`${dir}/r3-response.txt`, await page.locator('.naia-chat-area').innerText());
    // Cancellation on the actual Worker/provider path.
    await input.fill('Write a long story about the sea, at least 500 words.');
    await input.press('Enter');
    await expect(page.locator('.chat-cancel-btn')).toBeVisible();
    await page.waitForFunction(() => (document.querySelector('.chat-message.assistant.streaming .message-content')?.textContent?.trim().length ?? 0) > 20, null, {timeout:120000});
    await page.locator('.chat-cancel-btn').evaluate(button => { button.click(); button.click(); });
    await expect(input).toBeEnabled({ timeout: 15000 });
    await expect(page.locator('.chat-cancel-btn')).toHaveCount(0);
    await shot('cancelled');
    // Switch real models twice, preserving the same UI→Worker→server path.
    for (const id of ['smollm2:135m', 'qwen2.5:0.5b', 'smollm2:135m']) {
        await settings.click();
        await panel.locator('select').selectOption(id);
        await settings.click();
        const responseEvent = page.waitForResponse(r => r.url().includes('/local-llm/v1/chat/completions'));
        await input.fill('Say hello in one word.'); await input.press('Enter');
        const response = await responseEvent;
        assert.equal(response.status(),200);
        assert.equal(response.request().postDataJSON().model,id);
        await expect(page.locator('.chat-cancel-btn')).toHaveCount(0,{timeout:180000});
    }
    // A removed model is no longer selectable; refreshing clears its saved selection.
    execFileSync('podman',['exec',inference,'ollama','rm','smollm2:135m']);
    await settings.click(); await panel.locator('button').click();
    await expect(panel.locator('select option[value="smollm2:135m"]')).toHaveCount(0);
    await expect(panel.locator('select')).toHaveValue(''); await shot('deleted-model');
    const missing = await context.request.post(`${base}/local-llm/v1/chat/completions`, {data:{model:'round3-not-installed',messages:[{role:'user',content:'hello'}]}});
    assert.equal(missing.status(),404);
    await panel.locator('select').selectOption('qwen2.5:0.5b'); await settings.click();
    // Stop the actual server after partial response bytes, then recover on the same page.
    const outageResponseEvent = page.waitForResponse(r => r.url().includes('/local-llm/v1/chat/completions'));
    await input.fill('Write a very long story, at least 1000 words.'); await input.press('Enter');
    const outageResponse = await outageResponseEvent; assert.equal(outageResponse.status(),200);
    await page.waitForFunction(() => (document.querySelector('.chat-message.assistant.streaming .message-content')?.textContent?.trim().length ?? 0) > 30, null, {timeout:120000});
    await shot('midstream-before-stop');
    execFileSync('podman',['stop','--time','1',inference]); inferenceStopped=true;
    await expect(page.locator('.chat-cancel-btn')).toHaveCount(0,{timeout:30000});
    await expect(input).toBeEnabled();
    await expect(page.locator('.naia-chat-area')).toContainText(/could not finish|다시|오류|중단/i); await shot('midstream-outage');
    execFileSync('podman',['start',inference]); inferenceStopped=false;
    await expect.poll(async () => (await context.request.get(`${base}/local-llm/v1/models`)).status(),{timeout:30000}).toBe(200);
    await input.fill('Say hello.'); await input.press('Enter');
    await expect(page.locator('.chat-cancel-btn')).toHaveCount(0,{timeout:180000});
    await expect(page.locator('.chat-message.assistant').last()).not.toBeEmpty(); await shot('outage-recovered');
    if (await settings.count()) await settings.click();
    else await page.locator('.app-bar button').filter({ has: page.locator('svg') }).last().click();
    await expect(panel).toBeVisible();
    await page.route('**/local-llm/v1/models', route => route.fulfill({ json: { data: null } }));
    await panel.locator('button').click();
    await expect(panel.locator('select')).toHaveCount(0);
    await expect(panel.locator('[role="status"]')).toBeVisible();
    await shot('empty');
    await page.unroute('**/local-llm/v1/models');
    await page.route('**/local-llm/v1/models', route => route.fulfill({ json: { data: [] } }));
    await panel.locator('button').click();
    await expect(panel.locator('select')).toHaveCount(0);
    await expect(panel.locator('button')).toBeEnabled();
    await page.unroute('**/local-llm/v1/models');
    execFileSync('podman', ['stop', '--time', '1', inference]);
    inferenceStopped = true;
    await panel.locator('button').click();
    await expect(panel.locator('[role="alert"]')).toBeVisible({ timeout: 15000 });
    await shot('server-off');
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    await shot('narrow-error');
    const box = await panel.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 391 && box.width >= 250, 'Narrow controls must fit and retain readable width');
    const retryBox = await panel.locator('button').boundingBox();
    assert(retryBox.x >= 0 && retryBox.x + retryBox.width <= 390, 'Retry action must fit');
    await panel.locator('button').focus();
    await expect(panel.locator('button')).toBeFocused();
    execFileSync('podman', ['start', inference]);
    inferenceStopped = false;
    await expect.poll(async () => (await context.request.get(`${base}/local-llm/v1/models`)).status(), { timeout: 20000 }).toBe(200);
    await panel.locator('button').press('Enter');
    await expect(panel.locator('select')).toBeVisible();
    await shot('retry-success');
    writeFileSync(`${dir}/r3-requests.json`, JSON.stringify(requests, null, 2));
    assert(!requests.some(u => /huggingface.co|api.nextain.io/.test(u)), 'No external model/cloud request');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: real two-model switching, deletion/uninstalled 404/no auto-pull, midstream outage/recovery, duplicate cancel; models/SSE/empty/error/retry/narrow/keyboard/ARIA');
} catch (error) {
    await shot("failure");
    writeFileSync(`${dir}/r3-failure.html`, await page.content());
    throw error;
} finally {
    if (inferenceStopped) execFileSync('podman', ['start', inference]);
    writeFileSync(`${dir}/r3-browser.log`, logs.join('\n') + '\nERRORS\n' + errors.join('\n'));
    await browser.close();
}
