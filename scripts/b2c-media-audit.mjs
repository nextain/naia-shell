#!/usr/bin/env node
/** UC-B2C-026-R6: offline decode evidence; never a native acceptance verdict. */
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const hash = b => createHash('sha256').update(b).digest('hex');
function run(bin, args, maxBuffer = 8 * 1024 * 1024) {
  const r = spawnSync(bin, args, { timeout: 30000, maxBuffer });
  if (r.error || r.status !== 0) {
    const error = new Error(`${bin} failed: ${r.error?.code ?? r.status}`);
    error.infrastructure = Boolean(r.error) || r.signal !== null || r.status === null;
    throw error;
  }
  return r.stdout;
}
export function auditMedia(input, base = '.') {
  const result = { schema: 1, passed: false, nativeAcceptance: false, errors: [] };
  // Validate infrastructure and expectations separately: missing tools are never expected media failures.
  try {
    run('ffprobe', ['-version']); run('ffmpeg', ['-version']);
    if (!['alpha', 'stacked', 'opaque'].includes(input.mode)) throw new Error('invalid mode');
    if (!['success', 'decode-failure'].includes(input.expected)) throw new Error('invalid expected');
    const file = resolve(base, input.file);
    if (!statSync(file).isFile() || statSync(file).size > 50 * 1024 * 1024) throw new Error('file size/type');
    result.sha256 = hash(readFileSync(file));
    let stream;
    try {
      const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file]));
      stream = probe.streams[0];
      if (!stream) throw new Error('no video stream');
      if (!(stream.width > 0 && stream.height > 0) || stream.width * stream.height > 4096 * 4096) {
        const error = new Error('dimension limit'); error.infrastructure = true; throw error;
      }
      result.codec = stream.codec_name;
      result.width = stream.width; result.height = stream.height;
      // libvpx preserves VP9 WebM alpha; the default native VP9 decoder may discard it.
      const decoder = stream.codec_name === 'vp9' ? ['-c:v', 'libvpx-vp9'] : [];
      run('ffmpeg', ['-v', 'error', '-xerror', '-threads', '1', ...decoder, '-protocol_whitelist', 'file,pipe', '-i', file, '-map', '0:v:0', '-an', '-f', 'null', '-']);
      result.decoded = true;
      if (input.expected === 'decode-failure') throw new Error('expected decode failure but decoded');
      const pixels = run('ffmpeg', ['-v', 'error', ...decoder, '-protocol_whitelist', 'file,pipe', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-threads', '1', '-'], 70 * 1024 * 1024);
      if (pixels.length !== stream.width * stream.height * 4) throw new Error('incomplete frame');
      let min = 255, max = 0;
      if (input.mode === 'stacked' && stream.height % 2) throw new Error('stacked height must be even');
      for (let i = input.mode === 'stacked' ? pixels.length / 2 : 0; i < pixels.length; i += 4) {
        const value = input.mode === 'stacked' ? pixels[i] : pixels[i + 3];
        if (input.mode === 'stacked' && (Math.abs(pixels[i] - pixels[i + 1]) > 8 || Math.abs(pixels[i] - pixels[i + 2]) > 8)) throw new Error('stacked mask not grayscale');
        min = Math.min(min, value); max = Math.max(max, value);
      }
      result.sampleRange = [min, max];
      if (input.mode === 'opaque' ? min !== 255 : !(min < 64 && max > 191)) throw new Error('first-frame transparency expectation failed');
      if (input.codec && stream.codec_name !== input.codec) throw new Error('codec mismatch');
    } catch (error) {
      if (error.infrastructure || input.expected !== 'decode-failure' || result.decoded) throw error;
      result.decoded = false;
      result.decodeFailure = error.message;
    }
    if (input.expected === 'decode-failure') {
      const before = readFileSync(resolve(base, input.before));
      const after = readFileSync(resolve(base, input.after));
      for (const bytes of [before, after]) {
        const config = JSON.parse(bytes);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid settings snapshot');
      }
      result.beforeSha256 = hash(before); result.afterSha256 = hash(after);
      if (!before.equals(after)) throw new Error('settings changed after failure');
      result.snapshotPreserved = true;
    }
    result.passed = true;
  } catch (error) { result.errors.push(error.message); }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let result;
  try { const p = resolve(process.argv[2]); result = auditMedia(JSON.parse(readFileSync(p)), dirname(p)); }
  catch (error) { result = { passed: false, errors: [error.message] }; }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.passed ? 0 : 1;
}
