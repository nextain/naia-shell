// Actual OPFS + rendered UI acceptance; run only against the isolated local container.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(process.env.NAIA_WEB_SOURCE_DIR ? `${process.env.NAIA_WEB_SOURCE_DIR}/packages/shell/package.json` : new URL('../../../packages/shell/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const { unzipSync, strFromU8 } = require('fflate');
const dir = process.env.TMPDIR;
assert(dir?.startsWith('/'));
const base = process.env.NAIA_TEST_URL ?? 'http://127.0.0.1:18026';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'local test server only');
mkdirSync(`${dir}/r3-memory-shots`, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await context.route('**/*', r => new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const shot = name => page.screenshot({ path: `${dir}/r3-memory-shots/${name}.png` });
// All fixtures use the isolated browser context. No user profile is read.
const fs = async (op, path, text) => page.evaluate(async ({op,path,text}) => {
    let root = await navigator.storage.getDirectory();
    const parts = path.split('/'), name = parts.pop();
    for (const part of parts) root = await root.getDirectoryHandle(part, { create: op === 'write' });
    if (op === 'remove') { await root.removeEntry(name); return; }
    const h = await root.getFileHandle(name, { create: op === 'write' });
    if (op === 'write') { const s = await h.createWritable(); await s.write(text); await s.close(); }
    else return (await h.getFile()).text();
}, {op,path,text});
try {
    await page.goto(base);
    await page.waitForFunction(() => !!window.__NAIA_WEB_ADK_STATUS__ && window.__NAIA_WEB_ADK_STATUS__().phase !== 'checking', null, { timeout: 60000 });
    if (await page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__().phase) === 'needs-setup') await page.getByTestId('web-workspace-start-default').click();
    await page.waitForFunction(() => window.__NAIA_WEB_ADK_STATUS__().phase === 'ready', null, { timeout: 60000 });
    await fs('write', 'naia-adk/docs/restore-a.txt', 'round3-original-a');
    await fs('write', 'naia-adk/docs/restore-b.txt', 'round3-original-b');
    await fs('write', 'naia-adk/docs/service-secret.txt', 'excluded-secret-fixture');
    await fs('write', 'naia-adk/conversations/round3.jsonl', '{"role":"user","content":"round3 conversation","timestamp":1}\n');
    const fact = { id:'r3',content:'round3 memory fact',entities:[],topics:[],sourceEpisodes:[],createdAt:1,updatedAt:1,importance:1,recallCount:0,lastAccessed:1,strength:1 };
    await fs('write', 'naia-adk/naia-settings/memory/store.json', JSON.stringify({ facts: [fact] }));
    const config = JSON.parse(await fs('read', 'naia-adk/naia-settings/config.json'));
    await fs('write','naia-adk/naia-settings/config.json',JSON.stringify({...config,apiKey:'round3-private-fixture',llmRoles:{main:{provider:'local-container',model:'',apiKey:'round3-private-fixture'}}}));
    await page.locator('.app-bar-settings').click();
    if (!await page.getByTestId("web-memory-transfer").isVisible()) await page.locator('[data-settings-tab="profile"]').click();
    const panel = page.getByTestId('web-memory-transfer');
    await expect(panel).toBeVisible(); await shot('default');
    const downloadEvent = page.waitForEvent('download');
    await page.getByTestId('memory-transfer-export').click();
    const download = await downloadEvent;
    const zipPath = `${dir}/r3-memory-export.zip`;
    await download.saveAs(zipPath);
    const zip = unzipSync(readFileSync(zipPath));
    const manifest = JSON.parse(strFromU8(zip['manifest.json']));
    assert.equal(manifest.memoryFacts, 1);
    for (const f of manifest.files) assert.equal(createHash('sha256').update(zip[`files/${f.path}`]).digest('hex'),f.sha256);
    assert(!strFromU8(zip['files/naia-settings/config.json']).includes('round3-private-fixture'));
    assert(manifest.files.some(f => f.path === 'conversations/round3.jsonl'));
    assert.equal(strFromU8(zip['files/docs/restore-a.txt']), 'round3-original-a');
    assert(strFromU8(zip['files/naia-settings/memory/store.json']).includes('round3 memory fact'));
    assert(!Object.keys(zip).some(p => /service-secret|models\//.test(p)));
    writeFileSync(`${dir}/r3-memory-manifest.json`, JSON.stringify(manifest, null, 2));
    await shot('exported');
    await fs('write', 'naia-adk/docs/restore-a.txt', 'changed-a');
    await fs('write', 'naia-adk/docs/restore-b.txt', 'changed-b');
    await fs('write', 'naia-adk/docs/keep.txt', 'keep-unrelated');
    // Corruption must fail before touching existing data.
    await page.getByTestId('memory-transfer-import').setInputFiles({ name: 'broken.zip', mimeType:'application/zip', buffer: Buffer.from('broken ZIP') });
    await expect(panel.locator(':scope > [role="alert"]')).toBeVisible();
    assert.equal(await fs('read','naia-adk/docs/restore-a.txt'), 'changed-a'); await shot('corrupt-error');
    // Actual writable failure after at least one workspace overwrite exercises rollback.
    await page.evaluate(() => {
        const original = FileSystemFileHandle.prototype.createWritable;
        window.__restoreOriginal = original;
        let fired = false;
        FileSystemFileHandle.prototype.createWritable = async function(...args) {
            if (this.name === 'restore-a.txt' && !fired) { fired = true; throw new DOMException('test commit failure','QuotaExceededError'); }
            return original.apply(this,args);
        };
    });
    await page.getByTestId('memory-transfer-import').setInputFiles(zipPath);
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('restore-a.txt');
    await page.getByTestId('memory-transfer-restore').click();
    await shot('restoring');
    await expect(dialog.locator('[role="alert"]')).toBeVisible({timeout:60000});
    assert.equal(await fs('read','naia-adk/docs/restore-a.txt'), 'changed-a');
    assert.equal(await fs('read','naia-adk/docs/restore-b.txt'), 'changed-b');
    await shot('rollback-error');
    await page.evaluate(() => { FileSystemFileHandle.prototype.createWritable = window.__restoreOriginal; });
    await dialog.locator('button').first().click();
    await page.getByTestId('memory-transfer-import').setInputFiles(zipPath);
    await expect(dialog).toBeVisible(); await shot('preview');
    await page.setViewportSize({ width:390,height:844 }); await shot('narrow-preview');
    const box = await dialog.boundingBox(); assert(box.x >= 0 && box.x + box.width <= 391);
    const style = await dialog.evaluate(el => ({padding:parseFloat(getComputedStyle(el).padding),radius:parseFloat(getComputedStyle(el).borderRadius)}));
    assert(style.padding >= 16 && style.radius >= 8, 'The styled review dialog must be in the packaged CSS');
    for (const button of await dialog.locator('button').all()) {
        const b = await button.boundingBox(); assert(b.x >= 0 && b.x + b.width <= 391 && b.height >= 40);
    }
    await page.getByTestId('memory-transfer-restore').focus();
    await expect(page.getByTestId('memory-transfer-restore')).toBeFocused();
    await page.getByTestId('memory-transfer-restore').press('Enter');
    await expect(dialog.locator('[role="status"]')).toContainText(/Restored|복원/, { timeout:60000 });
    assert.equal(await fs('read','naia-adk/docs/restore-a.txt'), 'round3-original-a');
    assert.equal(await fs('read','naia-adk/docs/restore-b.txt'), 'round3-original-b');
    assert.equal(await fs('read','naia-adk/docs/keep.txt'), 'keep-unrelated');
    assert((await fs('read','naia-adk/conversations/round3.jsonl')).includes('round3 conversation'));
    await shot('restored');
    await dialog.locator('button').click();
    await page.waitForFunction(() => window.__NAIA_WEB_ADK_STATUS__?.().phase === 'ready', null, { timeout:60000 });
    assert.equal(await fs('read','naia-adk/docs/restore-a.txt'), 'round3-original-a');
    const leftovers = await page.evaluate(async () => { const r=await navigator.storage.getDirectory(); const names=[]; for await(const n of r.keys()) if(n.startsWith('naia-restore-')) names.push(n); return names; });
    assert.deepEqual(leftovers, []);
    // Explicitly show the absence of long-term memory without inventing facts.
    await fs('remove','naia-adk/naia-settings/memory/store.json');
    await page.locator('.app-bar-settings').click();
    await expect(panel).toBeVisible({timeout:15000});
    const absentEvent = page.waitForEvent('download'); await page.getByTestId('memory-transfer-export').click();
    await (await absentEvent).saveAs(`${dir}/r3-memory-absent.zip`);
    const absent = unzipSync(readFileSync(`${dir}/r3-memory-absent.zip`));
    assert.equal(JSON.parse(strFromU8(absent['manifest.json'])).memoryFacts, null);
    await page.getByTestId('memory-transfer-import').setInputFiles(`${dir}/r3-memory-absent.zip`);
    await expect(dialog).toContainText(/Not included|포함되지 않음/); await shot('memory-absent');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS: actual OPFS export content, manifest, exclusion, invalid ZIP, write-failure rollback, preview, keyboard/narrow restore, unrelated retention, reload persistence, missing long-term memory, staging cleanup');
} catch(e) { await shot('failure'); writeFileSync(`${dir}/r3-memory-failure.html`, await page.content()); throw e; }
finally { await browser.close(); }
