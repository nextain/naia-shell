#!/usr/bin/env node
/** Offline evidence only; never installs, executes, downloads or signs a package. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const MAX_ZIP = 50 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => { throw new Error(code); };
function regularFile(path, limit) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('UNSAFE_OR_OVERSIZE_FILE');
  const bytes = readFileSync(path);
  if (bytes.length > limit) fail('OVERSIZE_FILE');
  return bytes;
}
const json = (path) => JSON.parse(regularFile(path, 1024 * 1024));
const strings = (value) => Array.isArray(value) && value.every((x) => typeof x === 'string' && x.length > 0) && new Set(value).size === value.length;
const sameSet = (a, b) => strings(a) && strings(b) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Read actual bytes (including CRC validation), without extracting anything.
// The Python subprocess has no access to a caller-selected executable or code.
const ZIP_INSPECT = String.raw`
import sys, io, json, zipfile, hashlib, stat, re
z = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read(50*1024*1024+1)))
entries = z.infolist()
if len(entries) > 4096: raise ValueError('ZIP_ENTRY_LIMIT')
seen = set(); file_names = set(); directories = set(); total = 0; files = []; manifest = None
for entry in entries:
    name = entry.filename
    parts = name.rstrip('/').split('/')
    if (not name or name.startswith('/') or '\\' in name or ':' in name or
        any(p in ('', '.', '..') or p.endswith((' ', '.')) or re.match(r'(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)', p) or any(ord(c)<32 for c in p) for p in parts)):
        raise ValueError('ZIP_UNSAFE_PATH')
    identity = name.rstrip('/').casefold()
    if identity in seen: raise ValueError('ZIP_DUPLICATE_PATH')
    parents = ['/'.join(parts[:i]).casefold() for i in range(1, len(parts))]
    if any(p in file_names for p in parents) or (not entry.is_dir() and identity in directories):
        raise ValueError('ZIP_FILE_DIRECTORY_COLLISION')
    directories.update(parents)
    if entry.is_dir(): directories.add(identity)
    else: file_names.add(identity)
    seen.add(identity)
    mode = entry.external_attr >> 16
    if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR): raise ValueError('ZIP_SPECIAL_FILE')
    if entry.flag_bits & 1: raise ValueError('ZIP_ENCRYPTED')
    total += entry.file_size
    if total > 200*1024*1024: raise ValueError('ZIP_EXPANDED_LIMIT')
    if entry.is_dir(): continue
    digest = hashlib.sha256(); count = 0; content = bytearray()
    with z.open(entry) as stream:
        while True:
            chunk = stream.read(65536)
            if not chunk: break
            count += len(chunk)
            if count > entry.file_size: raise ValueError('ZIP_SIZE_MISMATCH')
            digest.update(chunk)
            if name == 'app.json':
                if count > 1024*1024: raise ValueError('MANIFEST_LIMIT')
                content.extend(chunk)
    if count != entry.file_size: raise ValueError('ZIP_SIZE_MISMATCH')
    files.append(dict(path=name, bytes=count, sha256=digest.hexdigest()))
    if name == 'app.json': manifest = json.loads(content)
print(json.dumps(dict(files=sorted(files, key=lambda x:x['path']), expandedBytes=total, manifest=manifest)))
`;

export function publishedKey() {
  const rust = readFileSync(new URL('../packages/shell/src-tauri/src/app.rs', import.meta.url), 'utf8');
  const key = rust.match(/const PUBLISHED_APP_SIGNING_PUBLIC_KEY: &str = "([A-Za-z0-9+/=]+)";/)?.[1];
  if (!key) fail('PUBLISHED_KEY_NOT_FOUND');
  return key;
}
function strictBase64(value, size) {
  if (typeof value !== 'string') fail('INVALID_BASE64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== size || bytes.toString('base64') !== value) fail('INVALID_BASE64');
  return bytes;
}

// Public-key injection supports deterministic test vectors only. CLI always
// resolves the published key from Rust and reports its fingerprint.
export function auditPackage(inputPath, publicKey = publishedKey()) {
  const report = {
    schemaVersion: 1, offlineChecksPassed: false,
    scope: 'offline package evidence; no entitlement, installation, legal approval or device acceptance',
    blockers: [], files: [], rightsEvidence: [],
  };
  const check = (code, fn) => {
    try { return fn(); } catch { report.blockers.push(code); return undefined; }
  };
  const input = check('INPUT_INVALID', () => json(inputPath));
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (!report.blockers.length) report.blockers.push('INPUT_INVALID');
    return report;
  }
  const base = dirname(resolve(inputPath));
  const local = (path) => {
    if (typeof path !== 'string' || !path.length) fail('PATH_REQUIRED');
    return resolve(base, path);
  };
  const identityValid = typeof input.appId === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(input.appId) && typeof input.version === 'string' && input.version.trim().length > 0;
  if (!identityValid) report.blockers.push('EXPECTED_IDENTITY_REQUIRED');
  report.expected = { appId: input.appId, version: input.version, permissions: input.expectedPermissions };
  const archive = check('ARCHIVE_MISSING_OR_INVALID', () => {
    const bytes = regularFile(local(input.archive), MAX_ZIP);
    if (!bytes.length) fail('EMPTY_ARCHIVE');
    report.archive = { path: local(input.archive), bytes: bytes.length, sha256: hash(bytes) };
    return bytes;
  });
  if (archive) {
    const inspected = check('ZIP_INVALID_OR_UNSAFE', () => {
      const result = spawnSync('python3', ['-c', ZIP_INSPECT], { input: archive, maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
      if (result.status !== 0 || result.error) fail('ZIP_INSPECTION_FAILED');
      return JSON.parse(result.stdout);
    });
    if (inspected) {
      report.files = inspected.files;
      report.expandedBytes = inspected.expandedBytes;
      const manifest = inspected.manifest;
      report.manifest = manifest;
      if (!manifest || manifest.id !== input.appId || manifest.version !== input.version) report.blockers.push('MANIFEST_IDENTITY_MISMATCH');
      if (!sameSet(manifest?.permissions === undefined ? [] : manifest.permissions, input.expectedPermissions)) report.blockers.push('PERMISSIONS_MISMATCH');
      if (!report.files.some((file) => file.path === 'index.html')) report.blockers.push('ENTRYPOINT_MISSING');
    }
  }
  check('STORE_SIGNATURE_MISSING_OR_INVALID', () => {
    const keyBytes = strictBase64(publicKey, 32);
    report.signingKeySha256 = hash(keyBytes);
    report.signingKeySource = publicKey === publishedKey() ? 'published Rust key' : 'test or external key; not CLI acceptance';
    const receipt = json(local(input.receipt));
    if (!archive || receipt.app_id !== input.appId || !/^[a-fA-F0-9]{64}$/.test(receipt.sha256) || receipt.sha256.toLowerCase() !== hash(archive)) fail('RECEIPT_MISMATCH');
    if (typeof receipt.signature !== 'string' || !receipt.signature.startsWith('ed25519:')) fail('SIGNATURE_FORMAT');
    const signature = strictBase64(receipt.signature.slice(8), 64);
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keyBytes]), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(receipt.sha256, 'hex'), key, signature)) fail('SIGNATURE_FAILED');
    report.signatureVerified = true;
  });
  const covered = new Set();
  if (!Array.isArray(input.rights) || !input.rights.length) report.blockers.push('RIGHTS_EVIDENCE_MISSING');
  else for (const evidence of input.rights) {
    check('RIGHTS_EVIDENCE_INVALID', () => {
      if (!evidence || !strings(evidence.covers) || !evidence.covers.length || !/^[a-f0-9]{64}$/.test(evidence.sha256)) fail('RIGHTS_INVALID');
      const bytes = regularFile(local(evidence.path), 1024 * 1024);
      if (!bytes.toString('utf8').trim() || hash(bytes) !== evidence.sha256) fail('RIGHTS_HASH_MISMATCH');
      for (const path of evidence.covers) {
        if (!report.files.some((file) => file.path === path)) fail('RIGHTS_UNKNOWN_FILE');
      }
      for (const path of evidence.covers) covered.add(path);
      report.rightsEvidence.push({ path: local(evidence.path), sha256: evidence.sha256, covers: evidence.covers });
    });
  }
  report.uncoveredFiles = report.files.filter((file) => !covered.has(file.path)).map((file) => file.path);
  if (report.uncoveredFiles.length) report.blockers.push('RIGHTS_COVERAGE_INCOMPLETE');
  report.offlineChecksPassed = report.blockers.length === 0;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report;
  try {
    if (process.argv.length !== 3) fail('USAGE');
    report = auditPackage(process.argv[2]);
  } catch {
    report = { schemaVersion: 1, offlineChecksPassed: false, blockers: ['USAGE_OR_TRUST_KEY_INVALID'], usage: 'node scripts/b2c-package-audit.mjs input.json' };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.offlineChecksPassed ? 0 : 1;
}
