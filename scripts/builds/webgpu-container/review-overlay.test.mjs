import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { reviewOverlay, WEB_REVISION } from './review-overlay.mjs';
const tmp = process.env.TMPDIR;
test('review exports every patched file with verifiable hashes and leaves checkout unchanged', () => {
  const before = execFileSync('git', ['status', '--porcelain']).toString();
  const { output, manifest } = reviewOverlay();
  try {
    assert(manifest.files.length > 20);
    assert.equal(readFileSync(`${output}/review-manifest.json`, 'utf8'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const file of manifest.files) {
      const hash = createHash('sha256').update(readFileSync(`${output}/${file.path}`)).digest('hex');
      assert.equal(hash, file.afterSha256);
      assert.notEqual(file.beforeSha256, file.afterSha256);
      if (file.beforeSha256 !== null) {
        const original = execFileSync('git', ['show', `${WEB_REVISION}:${file.path}`]);
        assert.equal(createHash('sha256').update(original).digest('hex'), file.beforeSha256);
      } else {
        assert.throws(() => execFileSync('git', ['cat-file', '-e', `${WEB_REVISION}:${file.path}`], { stdio: 'pipe' }));
      }
    }
    assert.equal(execFileSync('git', ['status', '--porcelain']).toString(), before);
    assert.throws(() => execFileSync('git', ['apply', '--check', `${output}/local-container.patch`], { cwd: output, stdio: 'pipe' }));
  } finally { rmSync(output, { recursive: true, force: true }); }
});
test('conflicts and unsafe paths leave no success artifact', () => {
  const before = readdirSync(tmp).filter((p) => p.startsWith('container-overlay-review.'));
  for (const patch of [
    'diff --git a/packages/shell/src/missing.ts b/packages/shell/src/missing.ts\n--- a/packages/shell/src/missing.ts\n+++ b/packages/shell/src/missing.ts\n@@ -1 +1 @@\n-impossible\n+replacement\n',
    'diff --git a/../outside b/../outside\n',
    '',
  ]) assert.throws(() => reviewOverlay({ patch: Buffer.from(patch) }));
  assert.deepEqual(readdirSync(tmp).filter((p) => p.startsWith('container-overlay-review.')), before);
});
