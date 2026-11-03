// #794/#824 P04: real OPFS, controlled storage faults and browser-process crash.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const dir = process.env.TMPDIR, source = process.env.NAIA_WEB_SOURCE_DIR, base = process.env.NAIA_TEST_URL;
assert(dir?.startsWith('/') && source?.startsWith('/'));
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(base), 'loopback Vite source server required');
const { chromium } = createRequire(`${source}/packages/shell/package.json`)('@playwright/test');
const report = { cases: [], startedAt: new Date().toISOString() };
const profile = `${dir}/r6-opfs-profile-${Date.now()}`;
let context, page;
async function launch() {
  context = await chromium.launchPersistentContext(profile, { headless: true, args: ['--no-sandbox'], viewport: { width: 390, height: 844 } });
  await context.route('**/*', r => {
    if (r.request().url() === `${base}/r6-harness`) return r.fulfill({ contentType: 'text/html', body: '<html><body>Isolated OPFS boundary harness</body></html>' });
    return new URL(r.request().url()).origin === base ? r.continue() : r.abort();
  });
  page = context.pages()[0]; await page.goto(`${base}/r6-harness`);
  await page.evaluate(async () => {
    window.transfer = await import('/src/lib/transfer/restore-web.ts');
    window.archive = await import('/src/lib/transfer/archive.ts');
    window.root = await navigator.storage.getDirectory();
    window.put = async (path, bytes) => {
      const parts = path.split('/'), name = parts.pop(); let parent = root;
      for (const p of parts) parent = await parent.getDirectoryHandle(p, { create: true });
      const s = await (await parent.getFileHandle(name, { create: true })).createWritable();
      await s.write(bytes); await s.close();
    };
    window.read = async path => {
      const parts = path.split('/'), name = parts.pop(); let parent = root;
      try { for (const p of parts) parent = await parent.getDirectoryHandle(p); return await (await (await parent.getFileHandle(name)).getFile()).text(); }
      catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
    };
    window.zip = async (large = false) => {
      const files = new Map(large ? [['docs/large.bin', new Uint8Array(128 * 1024 * 1024).fill(67)]] : [['docs/a.txt','new-a'],['docs/b.txt','new-b'],['docs/c.txt','new-c']]);
      const chunks = [];
      await archive.createArchive({ list: async () => [...files.keys()], async *read(path) {
        const value = files.get(path), b = typeof value === 'string' ? new TextEncoder().encode(value) : value;
        for (let p=0;p<b.length;p+=65536) yield b.subarray(p,p+65536);
      } }, { write: async c => chunks.push(c.slice()) }, { shellFormat:'r6',adkFormat:'r6' });
      return new File(chunks, 'r6.zip');
    };
    window.originalWritable = FileSystemFileHandle.prototype.createWritable;
    window.originalRemove = FileSystemDirectoryHandle.prototype.removeEntry;
    window.originalEstimate = navigator.storage.estimate.bind(navigator.storage);
    window.reset = async () => {
      FileSystemFileHandle.prototype.createWritable = originalWritable;
      FileSystemDirectoryHandle.prototype.removeEntry = originalRemove;
      navigator.storage.estimate = originalEstimate;
      for await (const name of root.keys()) {
        // Chromium releases previous-document OPFS handles asynchronously after a crash.
        for (let attempt=0;;attempt++) {
          try { await root.removeEntry(name, { recursive: true }); break; }
          catch(e) { if(e.name!=='NoModificationAllowedError'||attempt>=50)throw e;await new Promise(r=>setTimeout(r,100)); }
        }
      }
      await put('naia-adk/docs/a.txt','old-a'); await put('naia-adk/docs/b.txt','old-b'); await put('naia-adk/docs/keep.txt','keep');
    };
    window.check = async (fresh = false) => {
      const values = await Promise.all(['a','b','c','keep'].map(n => read(`naia-adk/docs/${n}.txt`)));
      return { values, journal: await (async () => { for await (const n of root.keys()) if(n === 'naia-restore-journal') return true; return false; })() };
    };
  });
}
async function run(name, fn) { if(process.env.NAIA_RESTORE_CASES && !new RegExp(process.env.NAIA_RESTORE_CASES).test(name))return; const start=Date.now(); const data=await fn(); report.cases.push({ name, ms:Date.now()-start, data }); console.log('PASS',name); }
async function old(journal=false) { assert.deepEqual(await page.evaluate(() => check()), { values:['old-a','old-b',null,'keep'], journal }); }
async function crash() {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.crash').catch(() => {});
  await context.close().catch(() => {});
  await launch();
}
try {
  await launch();
  await run('128MiB streamed file restore and SHA256', async () => {
    await page.evaluate(() => reset());
    const result = await page.evaluate(async () => {
      const file = await zip(true); await transfer.restoreWebTransfer(file);
      const h = await (await (await root.getDirectoryHandle('naia-adk')).getDirectoryHandle('docs')).getFileHandle('large.bin');
      const f = await h.getFile(); const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
      return { size:f.size, hash:await digest(await f.arrayBuffer()), expected:await digest(new Uint8Array(f.size).fill(67)), state:await check() };
    });
    assert.equal(result.size,128*1024*1024); assert.equal(result.hash,result.expected); assert.equal(result.state.journal,false); return result;
  });
  await run('insufficient estimate rejects before workspace changes',async()=>{
    await page.evaluate(() => reset());
    const error = await page.evaluate(async()=>{navigator.storage.estimate=async()=>({quota:1,usage:0});try{await transfer.restoreWebTransfer(await zip());}catch(e){return e.name;}});
    assert.equal(error,'QuotaExceededError');await old();
  });
  for (const [name, phase, method] of [['stage write','stage-1','write'],['stage close','stage-1','close'],['snapshot write','backup-1','write'],['snapshot close','backup-1','close'],['journal close','journal.json','close'],['target write','b.txt','write'],['target close','b.txt','close'],['commit marker close','committed','close']]) {
    await run(`${name} quota/IO failure rolls back`, async()=>{
      await page.evaluate(()=>reset());
      const error=await page.evaluate(async({phase,method})=>{
        let fired=false;
        FileSystemFileHandle.prototype.createWritable=async function(...args){
          const stream=await originalWritable.apply(this,args);
          if(this.name!==phase||fired)return stream;fired=true;
          const original=stream[method].bind(stream);
          stream[method]=async()=>{throw new DOMException('injected disk full/IO failure',method==='close'?'UnknownError':'QuotaExceededError');};
          return stream;
        };
        try{await transfer.restoreWebTransfer(await zip());}catch(e){return e.name;}
      },{phase,method});
      assert(['QuotaExceededError','UnknownError'].includes(error));await old();
    });
  }
  await run('real Chromium storage quota, no host disk exhaustion',async()=>{
    await page.evaluate(()=>reset());
    const cdp=await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin',{origin:base,quotaSize:1024*1024});
    const result=await page.evaluate(async()=>{
      // Bypass estimate only, to exercise the browser's actual OPFS quota enforcement.
      navigator.storage.estimate=async()=>({});
      try{await transfer.restoreWebTransfer(await zip(true));return 'unexpected success';}catch(e){return e.name;}
    });
    await cdp.send('Storage.overrideQuotaForOrigin',{origin:base});
    assert.equal(result,'QuotaExceededError');await old();return result;
  });
  await run('rollback failure retains journal; next recovery is idempotent',async()=>{
    await page.evaluate(()=>reset());
    await page.evaluate(async()=>{
      let target=false;
      FileSystemFileHandle.prototype.createWritable=async function(...args){
        if(this.name==='b.txt'){target=true;throw new DOMException('commit fails','QuotaExceededError');}
        if(this.name==='a.txt'&&target)throw new DOMException('rollback fails','QuotaExceededError');
        return originalWritable.apply(this,args);
      };
      try{await transfer.restoreWebTransfer(await zip());}catch{}
    });
    const state=await page.evaluate(()=>check());assert.equal(state.journal,true);assert.equal(state.values[0],'new-a');
    await page.evaluate(async()=>{FileSystemFileHandle.prototype.createWritable=originalWritable;await transfer.recoverWebTransfer();await transfer.recoverWebTransfer();});await old();
  });
  for (const phase of ['stage-1','b.txt','c.txt','rollback','cleanup']) await run(`browser process crash at ${phase}; boot recovery`,async()=>{
    await page.evaluate(()=>reset());
    await page.evaluate(phase=>{
      window.paused=false; let failed=false;
      if(phase==='cleanup') FileSystemDirectoryHandle.prototype.removeEntry=async function(name,...args){if(name==='naia-restore-journal'){window.paused=true;return new Promise(()=>{});}return originalRemove.call(this,name,...args);};
      else FileSystemFileHandle.prototype.createWritable=async function(...args){if(phase==='rollback'&&this.name==='b.txt'){failed=true;throw new DOMException('commit failed','QuotaExceededError');}if(this.name===phase||(phase==='rollback'&&failed&&this.name==='a.txt')){window.paused=true;return new Promise(()=>{});}return originalWritable.apply(this,args);};
      void zip().then(f=>transfer.restoreWebTransfer(f));
    },phase);
    await page.waitForFunction(()=>window.paused,null,{timeout:30000});
    const before=await page.evaluate(()=>check());
    if(['b.txt','c.txt','rollback'].includes(phase))assert.equal(before.values[0],'new-a');
    await crash();
    // Actual application entry must recover before it exposes ready/starts model.
    await page.goto(base);
    await page.waitForFunction(()=>['needs-setup','ready'].includes(window.__NAIA_WEB_ADK_STATUS__?.().phase),null,{timeout:60000});
    await page.goto(`${base}/r6-harness`);
    // Helper functions belong to the previous document, so reopen the harness imports.
    await context.close(); await launch();
    if(phase==='cleanup')assert.deepEqual(await page.evaluate(()=>check()),{values:['new-a','new-b','new-c','keep'],journal:false});
    else await old();
    return {before};
  });
  await run('restore lock rejects a concurrent restore',async()=>{
    await page.evaluate(()=>reset());
    const result=await page.evaluate(async()=>{
      let release; const gate=new Promise(r=>release=r);let paused;const ready=new Promise(r=>paused=r);
      FileSystemFileHandle.prototype.createWritable=async function(...args){if(this.name==='b.txt'){paused();await gate;}return originalWritable.apply(this,args);};
      const file=await zip();const first=transfer.restoreWebTransfer(file);await ready;
      let error;try{await transfer.restoreWebTransfer(file);}catch(e){error=e.message;}release();await first;return error;
    });assert.equal(result,'transfer busy');
  });
  await run('damaged snapshot hash fails before any rollback write',async()=>{
    await page.evaluate(()=>reset());
    await page.evaluate(async()=>{
      let failed=false;FileSystemFileHandle.prototype.createWritable=async function(...args){if(this.name==='b.txt'){failed=true;throw new DOMException('quota','QuotaExceededError');}if(failed&&this.name==='a.txt')throw new Error('rollback blocked');return originalWritable.apply(this,args);};
      try{await transfer.restoreWebTransfer(await zip());}catch{}
      FileSystemFileHandle.prototype.createWritable=originalWritable;
      await put('naia-restore-journal/backup-0','bad-a');
    });
    const error=await page.evaluate(async()=>{try{await transfer.recoverWebTransfer();}catch(e){return e.message;}});
    assert.equal(error,'restore original damaged');const state=await page.evaluate(()=>check());assert.equal(state.values[0],'new-a');assert.equal(state.journal,true);
  });
  await run('journal file/directory collision rejected before any delete',async()=>{
    await page.evaluate(()=>reset());
    await page.evaluate(()=>put('naia-restore-journal/journal.json',JSON.stringify({version:1,files:[{path:'docs/a.txt',size:null,sha256:null},{path:'docs/a.txt/child',size:null,sha256:null}]})));
    const error=await page.evaluate(async()=>{try{await transfer.recoverWebTransfer();}catch(e){return e.message;}});
    assert.equal(error,'restore journal path collision');await old(true);
  });
  await run('malformed journal fails closed at real boot; originals preserved',async()=>{
    await page.evaluate(()=>reset());
    await page.evaluate(()=>put('naia-restore-journal/journal.json','{"version":1,"files":[{"path":"../escape"}]}'));
    await page.goto(base);
    await page.waitForFunction(()=>window.__NAIA_WEB_ADK_STATUS__?.().phase==='error',null,{timeout:60000});
    const reason=await page.evaluate(()=>window.__NAIA_WEB_ADK_STATUS__());
    const alert=page.getByRole('alert').filter({hasText:'Recovery could not finish'});
    await alert.waitFor();await page.locator('.splash-screen').waitFor({state:'hidden',timeout:60000});const box=await alert.boundingBox();assert(box.x>=0&&box.x+box.width<=391);
    const retry=page.getByTestId('web-workspace-retry');await retry.focus();const loaded=page.waitForEvent('load');await retry.press('Enter');await loaded;
    await page.waitForFunction(()=>window.__NAIA_WEB_ADK_STATUS__?.().phase==='error',null,{timeout:60000});
    await page.getByRole('alert').filter({hasText:'Recovery could not finish'}).waitFor();
    await page.locator('.splash-screen').waitFor({state:'hidden',timeout:60000});
    const layout=await page.getByRole('alert').filter({hasText:'Recovery could not finish'}).evaluate(el=>{
      const a=el.getBoundingClientRect(),c=el.closest('.chat-messages').getBoundingClientRect();
      return {top:a.top,bottom:a.bottom,left:a.left,right:a.right,containerTop:c.top,containerBottom:c.bottom};
    });
    assert(layout.top>=layout.containerTop && layout.bottom<=layout.containerBottom,'Entire recovery notice must fit the visible chat area');
    await page.screenshot({path:`${dir}/r6-corrupt-journal.png`});
    await context.close();await launch();await old(true);return reason;
  });
  report.passed=true;
} finally {
  report.finishedAt=new Date().toISOString();writeFileSync(`${dir}/${process.env.NAIA_RESTORE_CASES ? "r6-restore-filtered-report.json" : "r6-restore-report.json"}`,JSON.stringify(report,null,2));
  await context?.close().catch(()=>{});
}
