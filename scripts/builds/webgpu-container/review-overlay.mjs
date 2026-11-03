// #794/#824 P04: export an isolated, hash-addressed review of the pinned overlay.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_REVISION = '313c706996e5ab0c17add59a7144c0d9a5ba7bc4';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function reviewOverlay({ repo = path.resolve(here, '../../..'), tmp = process.env.TMPDIR,
  patch = readFileSync(path.join(here, 'local-container.patch')) } = {}) {
  if (!tmp || !path.isAbsolute(tmp)) throw new Error('TMPDIR must be an absolute run tmp directory');
  const output = mkdtempSync(path.join(tmp, 'container-overlay-review.'));
  const git = (args, options = {}) => execFileSync('git', args, { cwd: repo, maxBuffer: 50 * 1024 * 1024, ...options });
  try {
    // Freeze the exact patch bytes before interpreting or applying them.
    const patchPath = path.join(output, 'local-container.patch');
    writeFileSync(patchPath, patch);
    const files = [...patch.toString().matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((m) => {
      if (m[1] !== m[2] || !m[2].startsWith('packages/shell/') || m[2].split('/').some((s) => s === '..' || s === '.')) {
        throw new Error(`Unsupported overlay path: ${m[2]}`);
      }
      return m[2];
    });
    if (!files.length || new Set(files).size !== files.length) throw new Error('Empty or duplicate overlay file set');
    // Only the overlay paths are needed for review; no install, network or checkout mutation.
    const archive = git(['archive', WEB_REVISION, 'packages/shell/src', 'packages/shell/web-worker']);
    execFileSync('tar', ['-x', '-C', output], { input: archive });
    git(['apply', '--check', patchPath], { cwd: output });
    const originals = files.map((file) => {
      try { return sha256(readFileSync(path.join(output, file))); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    });
    git(['apply', patchPath], { cwd: output });
    const manifest = {
      schemaVersion: 1, webRevision: WEB_REVISION,
      packagingRevision: git(['rev-parse', 'HEAD']).toString().trim(),
      patchSha256: sha256(patch),
      agentRevision: 'cc2acfa0d496a73e7f9d0cb3052145d1caeda433',
      adkRevision: '13ea427991542965091f2f3211b9325a36dbd522',
      scope: 'Source review only; not a build or approval to merge another checkout',
      files: files.map((file, index) => ({ path: file, beforeSha256: originals[index], afterSha256: sha256(readFileSync(path.join(output, file))) })),
    };
    writeFileSync(path.join(output, 'review-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { output, manifest };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { output, manifest } = reviewOverlay();
  process.stdout.write(`${JSON.stringify({ output, patchSha256: manifest.patchSha256, files: manifest.files.length })}\n`);
}
