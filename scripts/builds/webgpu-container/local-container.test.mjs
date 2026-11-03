import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
