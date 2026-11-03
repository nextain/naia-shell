import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const base = process.env.TMPDIR;
assert.ok(base, 'TMPDIR must point to the run tmp directory');
for (const kind of ['unregistered', 'corrupt', 'registered']) {
  test(`conform TS ${kind}`, () => {
    const root = mkdtempSync(join(base, 'conform-'));
    try {
      mkdirSync(join(root, 'src/main'), { recursive: true });
      mkdirSync(join(root, '.agents/context'), { recursive: true });
      writeFileSync(join(root, 'src/main/example.ts'), 'export const example = 1;');
      writeFileSync(join(root, '.agents/context/module-manifest.json'), kind === 'corrupt' ? '{' : JSON.stringify({ files: kind === 'registered' ? { 'src/main/example.ts': { layer: 'domain', uc: 'UC1', contract: 'example' } } : { 'src/main/missing.ts': { layer: 'domain', uc: 'UC1', contract: 'example' } } }));
      const result = spawnSync(process.execPath, ['.agents/hooks/conform-gate.js'], {
        env: { ...process.env, M3_PROJECT_ROOT: root }, encoding: 'utf8',
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(root, 'src/main/example.ts') } }),
      });
      assert.equal(result.status, 0);
      if (kind === 'registered') assert.equal(result.stdout, '');
      else assert.equal(JSON.parse(result.stdout).decision, 'block');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
