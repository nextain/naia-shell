// Verify the packaged PDF worker rather than replacing its ?url import with a mock.
import { createRequire } from 'node:module';
import { readdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = process.env.NAIA_WEB_SOURCE_DIR;
assert(source?.startsWith('/'));
const require = createRequire(`${source}/packages/shell/package.json`);
const { chromium } = require('@playwright/test');
const base = process.env.NAIA_TEST_URL ?? 'http://127.0.0.1:18026';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const asset = readdirSync(`${source}/packages/shell/dist-web/assets`).find(n => /^pdf\.worker.*\.mjs$/.test(n));
assert(asset, 'Packaged PDF worker required');
const browser = await chromium.launch({ args:['--no-sandbox'] });
try {
    const context = await browser.newContext();
    await context.route('**/*',r => new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : r.abort());
    const page = await context.newPage(); await page.goto(base);
    const result = await page.evaluate(async asset => {
        const path = `/assets/${asset}`;
        const response = await fetch(path);
        const mime = response.headers.get('content-type');
        if (!response.ok || !mime?.includes('javascript')) throw new Error(`PDF worker HTTP ${response.status}: ${mime}`);
        return new Promise((resolve,reject) => {
            const worker = new Worker(path,{type:'module'});
            const timer = setTimeout(() => { worker.terminate(); reject(new Error('PDF worker handshake timeout')); },15000);
            worker.onerror = e => { clearTimeout(timer);worker.terminate();reject(new Error(e.message)); };
            worker.onmessage = e => {
                if(e.data?.action==='ready') worker.postMessage({sourceName:'main',targetName:'worker',action:'test',data:new Uint8Array([255])});
                if(e.data?.action==='test') {clearTimeout(timer);worker.terminate();resolve({path,mime,test:e.data.data});}
            };
        });
    },asset);
    assert.equal(result.test,true);
    writeFileSync(`${process.env.TMPDIR}/r3-pdf-worker.json`,JSON.stringify(result,null,2));
    console.log('PASS: bundled PDF worker JavaScript MIME, module startup and typed-array handshake');
} finally { await browser.close(); }
