import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditPackage, publishedKey } from './b2c-package-audit.mjs';

assert.ok(process.env.TMPDIR, 'Set TMPDIR to the authorized execution tmp directory');
const root = mkdtempSync(join(process.env.TMPDIR, 'r5-audit-tests-'));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
let serial = 0;
function fixture(extra = [], options = {}) {
  const stem = join(root, String(serial++));
  const manifest = { id: 'test.roleplay', version: '1.0.0', permissions: ['model.ask', 'speech'] };
  const files = options.files ?? [['app.json', JSON.stringify(manifest)], ['index.html', '<p>Local roleplay</p>'], ['assets/character.webm', 'video-fixture'], ...extra];
  const zipped = spawnSync('python3', ['-c', `
import sys,json,zipfile,io
b=io.BytesIO()
with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,content in json.load(sys.stdin):
  if isinstance(content,dict):
   with z.open(name,'w') as stream:
    for _ in range(content['megabytes']*16): stream.write(b'0'*65536)
  elif name == 'link':
   entry=zipfile.ZipInfo(name); entry.create_system=3; entry.external_attr=0o120777<<16
   z.writestr(entry, content)
  else: z.writestr(name,content)
sys.stdout.buffer.write(b.getvalue())
`], { input: JSON.stringify(files), maxBuffer: 55 * 1024 * 1024 });
  assert.equal(zipped.status, 0);
  writeFileSync(`${stem}.zip`, zipped.stdout);
  const digest = sha(zipped.stdout);
  const receipt = { app_id: manifest.id, sha256: digest, signature: `ed25519:${sign(null, Buffer.from(digest, 'hex'), keys.privateKey).toString('base64')}` };
  const license = 'Test author evidence for every test fixture file; not a production grant.';
  writeFileSync(`${stem}.rights.txt`, license);
  writeFileSync(`${stem}.receipt.json`, JSON.stringify(receipt));
  const input = { appId: manifest.id, version: manifest.version, archive: `${stem}.zip`, receipt: `${stem}.receipt.json`, expectedPermissions: manifest.permissions, rights: [{ path: `${stem}.rights.txt`, sha256: sha(license), covers: files.map(([name]) => name) }] };
  const save = () => writeFileSync(`${stem}.json`, JSON.stringify(input));
  save();
  return { stem, input, receipt, save, run: () => { save(); return auditPackage(`${stem}.json`, publicKey); } };
}
function blocked(f, code) {
  const result = f.run();
  assert.equal(result.offlineChecksPassed, false);
  assert.ok(result.blockers.includes(code), JSON.stringify(result));
  return result;
}

test('real ZIP bytes and Ed25519 digest signature pass offline checks only', () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.offlineChecksPassed, true);
  assert.equal(result.signatureVerified, true);
  assert.equal(result.files.length, 3);
  assert.equal(result.files.find((x) => x.path === 'index.html').sha256, sha('<p>Local roleplay</p>'));
  assert.match(result.scope, /no entitlement, installation, legal approval or device acceptance/);
});

test('relative input paths are resolved against the input file', () => {
  const f = fixture();
  for (const key of ['archive', 'receipt']) f.input[key] = f.input[key].split('/').at(-1);
  f.input.rights[0].path = f.input.rights[0].path.split('/').at(-1);
  assert.equal(f.run().offlineChecksPassed, true);
});

test('unsigned archive still reports all hashes and explicit blockers', () => {
  const f = fixture(); delete f.input.receipt; delete f.input.rights;
  const result = blocked(f, 'STORE_SIGNATURE_MISSING_OR_INVALID');
  assert.equal(result.files.length, 3);
  assert.ok(result.blockers.includes('RIGHTS_EVIDENCE_MISSING'));
});

test('archive tampering, signature tampering, wrong app ID, other key and hex-string signature fail', () => {
  for (const kind of ['archive', 'signature', 'app', 'key', 'hex']) {
    const f = fixture();
    if (kind === 'archive') writeFileSync(`${f.stem}.zip`, Buffer.concat([readFileSync(`${f.stem}.zip`), Buffer.from('tamper')]));
    if (kind === 'signature') f.receipt.signature = `ed25519:${Buffer.alloc(64).toString('base64')}`;
    if (kind === 'app') f.receipt.app_id = 'other.app';
    if (kind === 'hex') f.receipt.signature = `ed25519:${sign(null, Buffer.from(f.receipt.sha256), keys.privateKey).toString('base64')}`;
    writeFileSync(`${f.stem}.receipt.json`, JSON.stringify(f.receipt));
    if (kind === 'key') {
      assert.equal(auditPackage(`${f.stem}.json`, publishedKey()).offlineChecksPassed, false);
    } else blocked(f, 'STORE_SIGNATURE_MISSING_OR_INVALID');
  }
});

test('ID/version/permissions must match the declared handoff', () => {
  for (const key of ['appId', 'version', 'expectedPermissions']) {
    const f = fixture(); f.input[key] = key === 'expectedPermissions' ? ['model.ask'] : 'other.value';
    blocked(f, key === 'expectedPermissions' ? 'PERMISSIONS_MISMATCH' : 'MANIFEST_IDENTITY_MISMATCH');
  }
  const f = fixture(); delete f.input.expectedPermissions;
  blocked(f, 'PERMISSIONS_MISMATCH');
});

test('rights evidence must be fixed, nonblank, and cover exact archive files', () => {
  for (const kind of ['tamper', 'missing', 'blank', 'unknown', 'partial']) {
    const f = fixture();
    if (kind === 'tamper') writeFileSync(`${f.stem}.rights.txt`, 'changed');
    if (kind === 'missing') f.input.rights[0].path = 'absent.txt';
    if (kind === 'blank') { writeFileSync(`${f.stem}.rights.txt`, ' '); f.input.rights[0].sha256 = sha(' '); }
    if (kind === 'unknown') f.input.rights[0].covers.push('not-in-zip');
    if (kind === 'partial') f.input.rights[0].covers.pop();
    blocked(f, kind === 'partial' ? 'RIGHTS_COVERAGE_INCOMPLETE' : 'RIGHTS_EVIDENCE_INVALID');
  }
});

test('unsafe ZIP paths, case collisions, duplicates and symlinks are rejected', () => {
  for (const name of ['../escape', '/absolute', 'C:/drive', 'assets\\escape', 'assets//empty', './dot', 'nul.txt', 'tail.', 'link', 'INDEX.HTML', 'index.html']) {
    blocked(fixture([[name, 'unsafe']]), 'ZIP_INVALID_OR_UNSAFE');
  }
  blocked(fixture([['assets', 'file']]), 'ZIP_INVALID_OR_UNSAFE');
  blocked(fixture([['parent', 'file'], ['parent/child', 'file']]), 'ZIP_INVALID_OR_UNSAFE');
});

test('corrupt ZIP, invalid manifest, missing entrypoint and entry-count limits fail', () => {
  const corrupt = fixture(); writeFileSync(`${corrupt.stem}.zip`, 'bad zip');
  blocked(corrupt, 'ZIP_INVALID_OR_UNSAFE');
  blocked(fixture([], { files: [['app.json', '{}']] }), 'ENTRYPOINT_MISSING');
  blocked(fixture([], { files: [['app.json', 'invalid json']] }), 'ZIP_INVALID_OR_UNSAFE');
  const tooMany = fixture(Array.from({ length: 4094 }, (_, i) => [`file-${i}`, '']));
  blocked(tooMany, 'ZIP_INVALID_OR_UNSAFE');
});

test('CRC damage is rejected even when the replacement archive has a valid signature', () => {
  const f = fixture();
  const bytes = readFileSync(`${f.stem}.zip`);
  const central = bytes.indexOf(Buffer.from('504b0102', 'hex'));
  assert.ok(central > 0);
  bytes.writeUInt32LE((bytes.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
  writeFileSync(`${f.stem}.zip`, bytes);
  f.receipt.sha256 = sha(bytes);
  f.receipt.signature = `ed25519:${sign(null, Buffer.from(f.receipt.sha256, 'hex'), keys.privateKey).toString('base64')}`;
  writeFileSync(`${f.stem}.receipt.json`, JSON.stringify(f.receipt));
  const result = blocked(f, 'ZIP_INVALID_OR_UNSAFE');
  assert.equal(result.signatureVerified, true);
});

test('expanded ZIP and outer ZIP limits fail before acceptance', () => {
  const expanded = fixture([['large.bin', { megabytes: 201 }]]);
  blocked(expanded, 'ZIP_INVALID_OR_UNSAFE');
  const outer = fixture();
  const file = readFileSync(`${outer.stem}.zip`);
  writeFileSync(`${outer.stem}.zip`, Buffer.concat([file, Buffer.alloc(50 * 1024 * 1024)]));
  blocked(outer, 'ARCHIVE_MISSING_OR_INVALID');
});

test('symlink inputs and malformed input fail without throwing', () => {
  const f = fixture();
  symlinkSync(`${f.stem}.zip`, `${f.stem}.link`); f.input.archive = `${f.stem}.link`;
  blocked(f, 'ARCHIVE_MISSING_OR_INVALID');
  writeFileSync(`${f.stem}.json`, 'null');
  assert.equal(auditPackage(`${f.stem}.json`).offlineChecksPassed, false);
  writeFileSync(`${f.stem}.json`, '{broken');
  assert.deepEqual(auditPackage(`${f.stem}.json`).blockers, ['INPUT_INVALID']);
});

test('CLI cannot accept a test key, emits machine-readable blocked result and exit 1', () => {
  const f = fixture();
  const cli = resolve('scripts/b2c-package-audit.mjs');
  const run = spawnSync(process.execPath, [cli, `${f.stem}.json`]);
  assert.equal(run.status, 1);
  assert.ok(JSON.parse(run.stdout).blockers.includes('STORE_SIGNATURE_MISSING_OR_INVALID'));
  const override = spawnSync(process.execPath, [cli, `${f.stem}.json`, '--key', publicKey]);
  assert.equal(override.status, 1);
  assert.deepEqual(JSON.parse(override.stdout).blockers, ['USAGE_OR_TRUST_KEY_INVALID']);
});
