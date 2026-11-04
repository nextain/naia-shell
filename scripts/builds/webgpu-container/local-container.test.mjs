import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const tmp = process.env.TMPDIR;
assert(tmp?.startsWith('/'), 'TMPDIR must be the run tmp directory');
test('the web overlay applies to the exact #824 source and rejects repeated application', () => {
  const dir = mkdtempSync(path.join(tmp, 'r2-patch-'));
  try {
    const archive = execFileSync('git', ['archive', '313c706996e5ab0c17add59a7144c0d9a5ba7bc4', 'packages/shell/src', 'packages/shell/web-worker'], { cwd: root, maxBuffer: 30 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    execFileSync('git', ['apply', '--check', path.join(here, 'local-container.patch')], { cwd: dir });
    execFileSync('git', ['apply', path.join(here, 'local-container.patch')], { cwd: dir });
    assert.notEqual(spawnSync('git', ['apply', '--check', path.join(here, 'local-container.patch')], { cwd: dir }).status, 0);
    // Regression: the local branch must precede the account credential gate.
    const worker = readFileSync(path.join(dir, 'packages/shell/web-worker/agent-worker.ts'), 'utf8');
    assert(worker.indexOf('config.provider === "local-container"') < worker.indexOf('if (!config.naiaKey)'));
    // Fourteen language notices must have the same keys and interpolation fields.
    const notices = lang => new Map([...readFileSync(path.join(dir, `packages/shell/src/lib/locales/${lang}.ts`), 'utf8').matchAll(/"((?:browserMemory|localContainer)\.[^"]+)":\s*("(?:[^"\\]|\\.)*")/g)].map(m => [m[1], JSON.parse(m[2])]));
    const reference = notices('en');
    assert(reference.has('browserMemory.recoveryError'));
    for (const lang of ['ar','bn','de','en','es','fr','hi','id','ja','ko','pt','ru','vi','zh']) {
      const translated = notices(lang);
      assert.deepEqual([...translated.keys()].sort(), [...reference.keys()].sort(), lang);
      for (const [key, value] of translated) {
        assert(value.trim() && !value.includes('�'), `${lang}:${key}`);
        assert.deepEqual(value.match(/\{[^}]+\}/g) ?? [], reference.get(key).match(/\{[^}]+\}/g) ?? [], `${lang}:${key} placeholders`);
      }
    }

  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Run the real duration script with an isolated preload. No container/network call escapes.
test('duration soak refuses completion with zero inference/cancel/restart coverage', () => {
 const dir=mkdtempSync(path.join(tmp,'r9-soak-coverage-'));
 try {
  const preload=path.join(dir,'preload.mjs');
  writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
   const read=fs.readFileSync;fs.readFileSync=(p,...args)=>{
    if(p==='/proc/123/cgroup')return '0::/r9-unit';
    if(p==='/sys/fs/cgroup/r9-unit/memory.max')return String(12*1024**3);
    if(p==='/sys/fs/cgroup/r9-unit/cpu.max')return '400000 100000';
    return read(p,...args);
   };
   cp.execFileSync=(command,args)=>{
    if(command!=='podman')throw Error('Unexpected subprocess');
    if(args[0]==='inspect')return Buffer.from(JSON.stringify([{Id:'unit-only',Config:{Labels:{'io.podman.compose.project':'naia-026-r9'}},HostConfig:{Devices:[]},State:{Pid:123}}]));
    if(args[0]==='stop')return Buffer.from('');
    throw Error('Unexpected podman operation');
   };
   syncBuiltinESMExports();let calls=0;Date.now=()=>++calls===1?0:4*60*60*1000;
   globalThis.fetch=()=>{throw Error('Network must not be called');};`);
  const child=spawnSync(process.execPath,['--import',preload,path.join(here,'cpu-duration-soak.mjs')],{env:{...process.env,TMPDIR:dir,NAIA_TEST_URL:'http://127.0.0.1:18039',NAIA_TEST_MODEL:'unit:fixture',NAIA_TEST_PROJECT:'naia-026-r9'},encoding:'utf8'});
  assert.equal(child.status,1,child.stderr);
  const report=JSON.parse(readFileSync(path.join(dir,'r9-soak-report.json'),'utf8'));
  assert.equal(report.status,'failed');assert.deepEqual(report.coverage,{cancelled:0,restarted:0});
  assert(report.errors.some(e=>e.fatal?.includes('Insufficient actual inference')));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
