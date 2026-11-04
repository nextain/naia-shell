// #824 P04: permanent regression from the independent Opus OPFS probe.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
const dir=process.env.TMPDIR,base=process.env.NAIA_TEST_URL,source=process.env.NAIA_WEB_SOURCE_DIR;
assert(dir?.startsWith('/')&&source?.startsWith('/')&&/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base));
const {chromium}=createRequire(`${source}/packages/shell/package.json`)('@playwright/test');

  const browser = await chromium.launch({args:["--no-sandbox"]});
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== base) return route.abort();
    if (u.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
    return route.continue();
  });
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const load = (p) => import(p);
    const out = {};
    localStorage.setItem("naia-remote-user-id", "acct.A@x");
    const auth = await load("/src/lib/web-runtime/web-auth.ts");
    auth.setWebLoginRequiredForTests(true);
    const cmds = await load("/src/lib/web-runtime/web-workspace-commands.ts");
    out.convDir = cmds.resolveWebConversationsDir();
    const { createArchive } = await load("/src/lib/transfer/archive.ts");
    const { restoreWebTransfer, recoverWebTransfer } = await load("/src/lib/transfer/restore-web.ts");
    const { downloadWebTransfer, loadTransfer } = await load("/src/lib/transfer/entry.ts");
    const { createOpfsWebFs } = await load("/src/lib/web-runtime/web-fs.ts");
    const fs = createOpfsWebFs(() => navigator.storage.getDirectory());
    await fs.writeBytes(`${out.convDir}/chat-1.jsonl`, "orig-A\n");
    await fs.writeBytes("naia-adk/conversations/u-other/chat-1.jsonl", "orig-other\n");
    const enc = new TextEncoder();
    const files = { "conversations/chat-1.jsonl": enc.encode("restored-A\n"), "docs/p.txt": enc.encode("doc") };
    const chunks = [];
    await createArchive({ list: async () => Object.keys(files), async *read(p) { yield files[p]; } }, { write: async (b) => { chunks.push(b.slice()); } }, { shellFormat: "0.2.6", adkFormat: "1" });
    const zip = new File(chunks, "a.zip");
    // B: restore while the shared lock is held must reject without touching files.
    let rel; const held = new Promise((ok) => { navigator.locks.request("naia-memory-transfer", () => new Promise((r) => { rel = r; ok(); })); });
    await held;
    try { await restoreWebTransfer(zip); out.busy = "allowed"; } catch (e) { out.busy = String(e); }
    // C: append queued behind held lock, then restore queued? restore uses ifAvailable so start restore after release.
    const appendP = cmds.appendWebConversationMessages("chat-1", [{ role: "user", content: "queued", timestamp: 1 }], fs);
    await new Promise((r) => setTimeout(r, 150));
    out.beforeRelease = await fs.readText(`${out.convDir}/chat-1.jsonl`);
    rel(); await appendP;
    out.afterAppend = await fs.readText(`${out.convDir}/chat-1.jsonl`);
    // A: mapped account restore
    await restoreWebTransfer(zip);
    out.afterRestoreA = await fs.readText(`${out.convDir}/chat-1.jsonl`);
    out.afterRestoreOther = await fs.readText("naia-adk/conversations/u-other/chat-1.jsonl");
    // Append after restore must build on restored content (no stale cache).
    await cmds.appendWebConversationMessages("chat-1", [{ role: "user", content: "post", timestamp: 2 }], fs);
    out.afterPostAppend = await fs.readText(`${out.convDir}/chat-1.jsonl`);
    // Restore while an append is mid-flight inside the lock: restore must reject or serialize.
    const write=fs.writeBytes;let releaseAppend,entered;
    const gate=new Promise(r=>releaseAppend=r),ready=new Promise(r=>entered=r);
    fs.writeBytes=async(...args)=>{entered();await gate;return write(...args);};
    const slow=cmds.appendWebConversationMessages("chat-1",[{role:"user",content:"race",timestamp:3}],fs);await ready;
    try{await restoreWebTransfer(zip);out.raceRestore="allowed";}catch(e){out.raceRestore=String(e);}
    releaseAppend();await slow;fs.writeBytes=write;
    out.afterRace=await fs.readText(`${out.convDir}/chat-1.jsonl`);
    // D: export (capture archive names) maps account dir and excludes u-other.
    const t = await loadTransfer();
    let names = [];
    const orig = t.createArchive;
    const spy = { ...t, createArchive: async (src, o, f) => { names = await src.list(); return orig(src, o, f); } };
    const origClick = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    await downloadWebTransfer(spy, out.convDir);
    HTMLAnchorElement.prototype.click = origClick;
    out.exportNames = names.sort();
    const root = await navigator.storage.getDirectory();
    try { await root.getDirectoryHandle("naia-restore-journal"); out.journalLeft = true; } catch { out.journalLeft = false; }
    // Trusted internal account journal targets must recover after a crash.
    const {Sha256}=await load("/src/lib/transfer/archive.ts");
    const original=new TextEncoder().encode("journal-original");const hash=new Sha256();hash.update(original);
    const journalPath=out.convDir.replace(/^naia-adk\//,"")+"/chat-1.jsonl";
    await fs.writeBytes("naia-adk/"+journalPath,"half-restored");
    await fs.writeBytes("naia-restore-journal/backup-0",original);
    await fs.writeBytes("naia-restore-journal/journal.json",JSON.stringify({version:1,files:[{path:journalPath,size:original.length,sha256:hash.digest()}]}));
    await recoverWebTransfer();out.recovered=await fs.readText("naia-adk/"+journalPath);
    await fs.writeBytes("naia-restore-journal/journal.json",JSON.stringify({version:1,files:[{path:journalPath.replace("/chat-1.jsonl","/u-other/private.jsonl"),size:null,sha256:null}]}));
    try{await recoverWebTransfer();out.nested="allowed";}catch(e){out.nested=String(e);}
    out.otherAfterRecovery=await fs.readText("naia-adk/conversations/u-other/chat-1.jsonl");
    return out;
  });
  assert.equal(result.convDir,"naia-adk/conversations/u-acct_A_x");
  assert.match(result.busy,/transfer busy/);assert.equal(result.beforeRelease,"orig-A\n");
  assert.match(result.afterAppend,/queued/);assert.equal(result.afterRestoreA,"restored-A\n");
  assert.equal(result.afterRestoreOther,"orig-other\n");assert.match(result.afterPostAppend,/^restored-A\n.*post/s);
  assert.match(result.raceRestore,/transfer busy/);assert.match(result.afterRace,/^restored-A\n.*race/s);
  assert.deepEqual(result.exportNames,["conversations/chat-1.jsonl","docs/p.txt"]);assert.equal(result.journalLeft,false);
  assert.equal(result.recovered,"journal-original");assert.match(result.nested,/account conversation path forbidden/);
  assert.equal(result.otherAfterRecovery,"orig-other\n");
  writeFileSync(`${dir}/r9-account-transfer-report.json`,JSON.stringify(result,null,2));
  console.log("PASS: mapped account restore/export, in-flight append lock rejection, journal rollback and other-account retention");
} finally {await browser.close();}
