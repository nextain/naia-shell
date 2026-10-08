import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeEtag, planIsoPrune, runCli } from "./r2-iso-prune.mjs";
import {
  ALLOWED_BUCKET,
  checkActiveWorkflows,
  comparePrefixObjects,
  deleteObjectKey,
  findMissingValueFlag,
  listObjectsV2Pages,
  loadAndValidateListing,
  parseResultJsonl,
  parseResultJsonlFile,
  renderPlanMarkdown,
  renderResultMarkdown,
  resolveBucketArg,
  ResultRecorder,
  runHelperCli,
  safeExec,
  VALUE_FLAGS,
} from "./r2-iso-prune-helper.mjs";

test("r2-iso-prune: 무리별 최신 2개 보존", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    // nvidia (3 builds older than 3 days)
    { key: "builds/nvidia/0.1.20260920T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-20T00:00:00Z", ETag: '"etag-1"' },
    { key: "builds/nvidia/0.1.20260921T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-21T00:00:00Z", ETag: '"etag-2"' },
    { key: "builds/nvidia/0.1.20260922T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-22T00:00:00Z", ETag: '"etag-3"' },
    // amd (3 builds older than 3 days)
    { key: "builds/amd/0.1.20260920T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-20T00:00:00Z", ETag: '"etag-4"' },
    { key: "builds/amd/0.1.20260921T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-21T00:00:00Z", ETag: '"etag-5"' },
    { key: "builds/amd/0.1.20260922T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-22T00:00:00Z", ETag: '"etag-6"' },
    // amd-server (3 builds older than 3 days)
    { key: "builds/amd-server/0.1.20260920T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-20T00:00:00Z", ETag: '"etag-7"' },
    { key: "builds/amd-server/0.1.20260921T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-21T00:00:00Z", ETag: '"etag-8"' },
    { key: "builds/amd-server/0.1.20260922T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-22T00:00:00Z", ETag: '"etag-9"' },
  ];

  const plan = planIsoPrune(objects, now, { maxDelete: 10 });
  const deletedPrefixes = plan.delete.map((d) => d.prefix);
  const keptPrefixes = plan.keep.map((k) => k.prefix);

  // Oldest in each group should be deleted
  assert.ok(deletedPrefixes.includes("builds/nvidia/0.1.20260920T000000Z/"));
  assert.ok(deletedPrefixes.includes("builds/amd/0.1.20260920T000000Z/"));
  assert.ok(deletedPrefixes.includes("builds/amd-server/0.1.20260920T000000Z/"));
  assert.equal(plan.delete.length, 3);

  // Latest 2 in each group should be kept
  assert.ok(keptPrefixes.includes("builds/nvidia/0.1.20260922T000000Z/"));
  assert.ok(keptPrefixes.includes("builds/nvidia/0.1.20260921T000000Z/"));
  assert.ok(keptPrefixes.includes("builds/amd/0.1.20260922T000000Z/"));
  assert.ok(keptPrefixes.includes("builds/amd/0.1.20260921T000000Z/"));
  assert.ok(keptPrefixes.includes("builds/amd-server/0.1.20260922T000000Z/"));
  assert.ok(keptPrefixes.includes("builds/amd-server/0.1.20260921T000000Z/"));
  assert.equal(plan.keep.length, 6);
});

test("r2-iso-prune: 3일 미만 보존(최신 2개 밖이어도)", () => {
  const now = "2026-10-05T12:00:00Z"; // now
  const objects = [
    // Candidate 1: 5 days ago (old, > 3 days)
    { key: "builds/nvidia/0.1.20260930T120000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-30T12:00:00Z", ETag: '"e1"' },
    // Candidate 2: 2 days ago (recent, <= 3 days, 3rd newest)
    { key: "builds/nvidia/0.1.20261003T120000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-10-03T12:00:00Z", ETag: '"e2"' },
    // Candidate 3: 1.5 days ago (recent, <= 3 days, 2nd newest)
    { key: "builds/nvidia/0.1.20261004T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-10-04T00:00:00Z", ETag: '"e3"' },
    // Candidate 4: 0.5 days ago (recent, <= 3 days, newest)
    { key: "builds/nvidia/0.1.20261005T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-10-05T00:00:00Z", ETag: '"e4"' },
  ];

  const plan = planIsoPrune(objects, now, { keepPerGroup: 2, minAgeDays: 3 });

  // Candidate 1 should be deleted (older than 3 days and not in top 2)
  assert.equal(plan.delete.length, 1);
  assert.equal(plan.delete[0].prefix, "builds/nvidia/0.1.20260930T120000Z/");

  // Candidates 2, 3, 4 must all be in keep! Candidate 2 is kept because age < 3 days.
  const keptPrefixes = plan.keep.map((k) => k.prefix);
  assert.ok(keptPrefixes.includes("builds/nvidia/0.1.20261005T000000Z/"));
  assert.ok(keptPrefixes.includes("builds/nvidia/0.1.20261004T000000Z/"));
  assert.ok(keptPrefixes.includes("builds/nvidia/0.1.20261003T120000Z/"));
  assert.equal(plan.keep.length, 3);
});

test("r2-iso-prune: 옛 형식 = nvidia 무리", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    // 2 modern nvidia builds
    { key: "builds/nvidia/0.2.3.20260925T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-25T00:00:00Z", ETag: '"e1"' },
    { key: "builds/nvidia/0.2.3.20260926T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-26T00:00:00Z", ETag: '"e2"' },
    // 1 legacy format without variant (starts with digit under builds/)
    { key: "builds/0.2.2.20260831T044236Z/naia-os-live-amd64.iso", size: 200, lastModified: "2026-08-31T04:42:36Z", ETag: '"e3"' },
  ];

  const plan = planIsoPrune(objects, now, { keepPerGroup: 2 });
  // The legacy build should be treated as group 'nvidia' and marked for deletion because the 2 modern ones are newer
  assert.equal(plan.delete.length, 1);
  assert.equal(plan.delete[0].prefix, "builds/0.2.2.20260831T044236Z/");
  assert.equal(plan.delete[0].group, "nvidia");
  assert.equal(plan.delete[0].bytes, 200);

  const kept = plan.keep.map((k) => k.prefix);
  assert.ok(kept.includes("builds/nvidia/0.2.3.20260926T000000Z/"));
  assert.ok(kept.includes("builds/nvidia/0.2.3.20260925T000000Z/"));
});

test("r2-iso-prune: 공개 키·previous/·범위 밖 키는 절대 대상 아님", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    { key: "naia-os-live-amd64.iso", size: 7800000000, lastModified: "2026-06-10T12:00:00Z", ETag: '"e1"' },
    { key: "naia-os-amd-live-amd64.iso", size: 7800000000, lastModified: "2026-06-10T12:00:00Z", ETag: '"e2"' },
    { key: "naia-os-amd-server-live-amd64.iso", size: 7800000000, lastModified: "2026-06-10T12:00:00Z", ETag: '"e3"' },
    { key: "previous/naia-os-live-amd64.iso", size: 7800000000, lastModified: "2026-06-10T12:00:00Z", ETag: '"e4"' },
    { key: "previous/naia-os-live-amd64.iso-CHECKSUM", size: 1000, lastModified: "2026-06-10T12:00:00Z", ETag: '"e5"' },
    { key: "logos/naia-logo.png", size: 50000, lastModified: "2026-05-01T00:00:00Z", ETag: '"e6"' },
    { key: "private-transfer/secret.tar.gz", size: 10000, lastModified: "2026-05-01T00:00:00Z", ETag: '"e7"' },
    { key: "stats-reports/daily-20261001.json", size: 2000, lastModified: "2026-10-01T00:00:00Z", ETag: '"e8"' },
  ];

  const plan = planIsoPrune(objects, now);
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.keep.length, 0);
  assert.equal(plan.totalDeleteBytes, 0);
});

test("r2-iso-prune: 형식 이상한 builds/ 키 무시", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    { key: "builds/file-directly-under-builds.iso", size: 100, lastModified: "2026-08-01T00:00:00Z", ETag: '"e1"' },
    { key: "builds/nvidia/", size: 0, lastModified: "2026-08-01T00:00:00Z", ETag: '"e2"' },
    { key: "builds/nvidia/not_a_valid_build_id/x.iso", size: 100, lastModified: "2026-08-01T00:00:00Z", ETag: '"e3"' },
  ];

  const plan = planIsoPrune(objects, now);
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.keep.length, 0);
});

test("r2-iso-prune: 상한 초과 시 오래된 순 자르기 + truncated", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    // 5 builds in nvidia group, all older than 3 days
    { key: "builds/nvidia/0.1.20260901T000000Z/x.iso", size: 10, lastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' },
    { key: "builds/nvidia/0.1.20260902T000000Z/x.iso", size: 20, lastModified: "2026-09-02T00:00:00Z", ETag: '"e2"' },
    { key: "builds/nvidia/0.1.20260903T000000Z/x.iso", size: 30, lastModified: "2026-09-03T00:00:00Z", ETag: '"e3"' },
    { key: "builds/nvidia/0.1.20260904T000000Z/x.iso", size: 40, lastModified: "2026-09-04T00:00:00Z", ETag: '"e4"' },
    { key: "builds/nvidia/0.1.20260905T000000Z/x.iso", size: 50, lastModified: "2026-09-05T00:00:00Z", ETag: '"e5"' },
  ];

  // keepPerGroup=2 means 3 candidates for deletion (0901, 0902, 0903).
  // maxDelete=2 means only the oldest 2 (0901, 0902) should be deleted!
  const plan = planIsoPrune(objects, now, { keepPerGroup: 2, maxDelete: 2 });
  assert.equal(plan.delete.length, 2);
  assert.equal(plan.truncated, true);
  assert.equal(plan.delete[0].prefix, "builds/nvidia/0.1.20260901T000000Z/");
  assert.equal(plan.delete[1].prefix, "builds/nvidia/0.1.20260902T000000Z/");
  assert.equal(plan.totalDeleteBytes, 30); // 10 + 20

  // The 3rd candidate (0903) was deferred and kept
  const kept = plan.keep.map((k) => k.prefix);
  assert.ok(kept.includes("builds/nvidia/0.1.20260903T000000Z/"));
  assert.ok(kept.includes("builds/nvidia/0.1.20260904T000000Z/"));
  assert.ok(kept.includes("builds/nvidia/0.1.20260905T000000Z/"));
});

test("r2-iso-prune: 허용 목록 밖 변형(builds/foo/0.1/x.iso) 제외", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    { key: "builds/foo/0.1/x.iso", size: 100, lastModified: "2026-08-01T00:00:00Z", ETag: '"e1"' },
  ];

  const plan = planIsoPrune(objects, now);
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.keep.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /variant/i);
});

test("r2-iso-prune: 더 깊은 하위 키가 있는 접두사 통째 제외", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    { key: "builds/nvidia/0.2.3.20260908T141606Z-13980895/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-08T14:16:06Z", ETag: '"e1"' },
    { key: "builds/nvidia/0.2.3.20260908T141606Z-13980895/extra/nested/file.txt", size: 100, lastModified: "2026-09-08T14:16:06Z", ETag: '"e2"' },
  ];

  const plan = planIsoPrune(objects, now);
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.keep.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].prefix, "builds/nvidia/0.2.3.20260908T141606Z-13980895/");
  assert.match(plan.skipped[0].reason, /deeper/i);
});

test("r2-iso-prune: previous/<STAMP>/ 최신 2개 보존·previous/<공개 키> 절대 대상 아님", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    { key: "previous/naia-os-live-amd64.iso", size: 7800000000, lastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' },
    { key: "previous/naia-os-live-amd64.iso-CHECKSUM", size: 1000, lastModified: "2026-09-01T00:00:00Z", ETag: '"e2"' },
    { key: "previous/20260901T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-01T00:00:00Z", ETag: '"e3"' },
    { key: "previous/20260902T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-02T00:00:00Z", ETag: '"e4"' },
    { key: "previous/20260903T000000Z/naia-os-live-amd64.iso", size: 100, lastModified: "2026-09-03T00:00:00Z", ETag: '"e5"' },
  ];

  const plan = planIsoPrune(objects, now, { keepPerGroup: 2 });
  // The oldest stamp (20260901) should be deleted
  assert.equal(plan.delete.length, 1);
  assert.equal(plan.delete[0].prefix, "previous/20260901T000000Z/");
  assert.equal(plan.delete[0].group, "previous");

  // Latest 2 stamps kept
  const kept = plan.keep.map((k) => k.prefix);
  assert.ok(kept.includes("previous/20260903T000000Z/"));
  assert.ok(kept.includes("previous/20260902T000000Z/"));
  assert.ok(!kept.includes("previous/naia-os-live-amd64.iso"));
});

test("r2-iso-prune: 빈 목록", () => {
  const plan1 = planIsoPrune([], "2026-10-05T12:00:00Z");
  assert.deepEqual(plan1, {
    delete: [],
    keep: [],
    skipped: [],
    totalDeleteBytes: 0,
    truncated: false,
  });

  const plan2 = planIsoPrune(null, "2026-10-05T12:00:00Z");
  assert.equal(plan2.delete.length, 0);
});

test("r2-iso-prune: CLI 가 list-objects-v2 형식과 다중 페이지를 읽음", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "prune-test-"));
  try {
    const singlePageFile = join(tmpDir, "single.json");
    const multiPageFile = join(tmpDir, "multi.json");
    const prefixesOut = join(tmpDir, "out-prefixes.txt");

    // Single page with Contents
    writeFileSync(
      singlePageFile,
      JSON.stringify({
        Contents: [
          { Key: "builds/nvidia/0.1.20260901T000000Z/a.iso", Size: 50, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' },
          { Key: "builds/nvidia/0.1.20260902T000000Z/a.iso", Size: 50, LastModified: "2026-09-02T00:00:00Z", ETag: '"e2"' },
          { Key: "builds/nvidia/0.1.20260903T000000Z/a.iso", Size: 50, LastModified: "2026-09-03T00:00:00Z", ETag: '"e3"' },
        ],
      })
    );

    const planSingle = runCli([
      "--listing",
      singlePageFile,
      "--now",
      "2026-10-05T12:00:00Z",
      "--prefixes-out",
      prefixesOut,
    ]);
    assert.equal(planSingle.delete.length, 1);
    const writtenPrefixes = readFileSync(prefixesOut, "utf-8");
    assert.equal(writtenPrefixes.trim(), "builds/nvidia/0.1.20260901T000000Z/");

    // Multi-page array of objects with Contents
    writeFileSync(
      multiPageFile,
      JSON.stringify([
        {
          Contents: [
            { Key: "builds/amd/0.1.20260901T000000Z/a.iso", Size: 50, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' },
          ],
        },
        {
          Contents: [
            { Key: "builds/amd/0.1.20260902T000000Z/a.iso", Size: 50, LastModified: "2026-09-02T00:00:00Z", ETag: '"e2"' },
            { Key: "builds/amd/0.1.20260903T000000Z/a.iso", Size: 50, LastModified: "2026-09-03T00:00:00Z", ETag: '"e3"' },
          ],
        },
      ])
    );

    const planMulti = runCli([
      "--listing",
      multiPageFile,
      "--now",
      "2026-10-05T12:00:00Z",
      "--prefixes-out",
      prefixesOut,
    ]);
    assert.equal(planMulti.delete.length, 1);
    assert.equal(planMulti.delete[0].prefix, "builds/amd/0.1.20260901T000000Z/");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune: 2026-10-05 실측 형태 고정 데이터 검증", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [];

  const NVIDIA_ISO_BYTES = 8_200_000_000; // 8,200,000,000 bytes
  const AMD_ISO_BYTES = 8_280_000_000; // 8,280,000,000 bytes
  const CHECKSUM_BYTES = 1000; // 1KB

  // 1. 22 modern nvidia builds: dates 2026-09-09 to 2026-09-30 (1 build per day)
  for (let d = 9; d <= 30; d++) {
    const dayStr = d.toString().padStart(2, "0");
    const stamp = `202609${dayStr}T120000Z`;
    const buildId = `0.2.3.${stamp}`;
    const prefix = `builds/nvidia/${buildId}/`;
    const dateIso = `2026-09-${dayStr}T12:00:00Z`;
    objects.push({ key: `${prefix}naia-os-live-amd64.iso`, size: NVIDIA_ISO_BYTES, lastModified: dateIso, ETag: `"etag-${dayStr}-iso"` });
    objects.push({ key: `${prefix}naia-os-live-amd64.iso-CHECKSUM`, size: CHECKSUM_BYTES, lastModified: dateIso, ETag: `"etag-${dayStr}-chk"` });
  }

  // 2. 10 modern amd builds: dates 2026-09-21 to 2026-09-30 (1 build per day)
  for (let d = 21; d <= 30; d++) {
    const dayStr = d.toString().padStart(2, "0");
    const stamp = `202609${dayStr}T120000Z`;
    const buildId = `0.2.3.${stamp}`;
    const prefix = `builds/amd/${buildId}/`;
    const dateIso = `2026-09-${dayStr}T12:00:00Z`;
    objects.push({ key: `${prefix}naia-os-live-amd64.iso`, size: AMD_ISO_BYTES, lastModified: dateIso, ETag: `"etag-${dayStr}-amd-iso"` });
    objects.push({ key: `${prefix}naia-os-live-amd64.iso-CHECKSUM`, size: CHECKSUM_BYTES, lastModified: dateIso, ETag: `"etag-${dayStr}-amd-chk"` });
  }

  // 3. 2 legacy builds without variant (dates 2026-08-30 and 2026-08-31)
  objects.push({
    key: "builds/0.2.2.20260830T120000Z/naia-os-live-amd64.iso",
    size: NVIDIA_ISO_BYTES,
    lastModified: "2026-08-30T12:00:00Z",
    ETag: '"etag-legacy-30-iso"',
  });
  objects.push({
    key: "builds/0.2.2.20260830T120000Z/naia-os-live-amd64.iso-CHECKSUM",
    size: CHECKSUM_BYTES,
    lastModified: "2026-08-30T12:00:00Z",
    ETag: '"etag-legacy-30-chk"',
  });

  objects.push({
    key: "builds/0.2.2.20260831T120000Z/naia-os-live-amd64.iso",
    size: NVIDIA_ISO_BYTES,
    lastModified: "2026-08-31T12:00:00Z",
    ETag: '"etag-legacy-31-iso"',
  });
  objects.push({
    key: "builds/0.2.2.20260831T120000Z/naia-os-live-amd64.iso-CHECKSUM",
    size: CHECKSUM_BYTES,
    lastModified: "2026-08-31T12:00:00Z",
    ETag: '"etag-legacy-31-chk"',
  });

  // 4. Public release download key
  objects.push({
    key: "naia-os-live-amd64.iso",
    size: 7800000000,
    lastModified: "2026-06-10T12:00:00Z",
    ETag: '"etag-public"',
  });

  // 5. previous/ file
  objects.push({
    key: "previous/naia-os-live-amd64.iso-CHECKSUM",
    size: CHECKSUM_BYTES,
    lastModified: "2026-06-10T12:00:00Z",
    ETag: '"etag-prev-chk"',
  });

  // 6. logos/ out-of-scope key
  objects.push({
    key: "logos/logo.png",
    size: 100000,
    lastModified: "2026-05-01T00:00:00Z",
    ETag: '"etag-logo"',
  });

  // Calculate prune plan with maxDelete = Infinity
  const plan = planIsoPrune(objects, now, { keepPerGroup: 2, minAgeDays: 3, maxDelete: Infinity });

  // Verification against expectations:
  // - nvidia group has 22 + 2 = 24 candidates. 2 kept -> 22 deleted.
  // - amd group has 10 candidates. 2 kept -> 8 deleted.
  // - Total delete candidates = 22 + 8 = 30.
  assert.equal(plan.delete.length, 30);
  assert.equal(plan.truncated, false);

  const deletedNvidia = plan.delete.filter((d) => d.group === "nvidia");
  const deletedAmd = plan.delete.filter((d) => d.group === "amd");
  assert.equal(deletedNvidia.length, 22);
  assert.equal(deletedAmd.length, 8);

  // Bytes calculation:
  // 22 nvidia prefixes * (8.2 GB + 1KB) = 22 * 8,200,001,000 = 180,400,022,000 bytes
  // 8 amd prefixes * (8.28 GB + 1KB) = 8 * 8,280,001,000 = 66,240,008,000 bytes
  // Total = 246,640,030,000 bytes (≈ 246.64 GB)
  const expectedBytes = 22 * (NVIDIA_ISO_BYTES + CHECKSUM_BYTES) + 8 * (AMD_ISO_BYTES + CHECKSUM_BYTES);
  assert.equal(plan.totalDeleteBytes, expectedBytes);
  assert.equal(plan.totalDeleteBytes, 246640030000);

  // Verify kept builds are exactly 2 for nvidia and 2 for amd
  const keptNvidia = plan.keep.filter((k) => k.group === "nvidia");
  const keptAmd = plan.keep.filter((k) => k.group === "amd");
  assert.equal(keptNvidia.length, 2);
  assert.equal(keptAmd.length, 2);

  // Check that public key and previous CHECKSUM are untouched
  assert.ok(!plan.delete.some((d) => d.prefix.includes("naia-os-live-amd64.iso")));
  assert.ok(!plan.keep.some((k) => k.prefix.includes("logos")));
});

test("r2-iso-prune: 별도 사례로 now 기준 1일 전 빌드가 최신 2개 밖이어도 보존", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    // 1st newest (0.2 days ago)
    { key: "builds/nvidia/0.2.3.20261005T060000Z/x.iso", size: 100, lastModified: "2026-10-05T06:00:00Z", ETag: '"e1"' },
    // 2nd newest (0.5 days ago)
    { key: "builds/nvidia/0.2.3.20261005T000000Z/x.iso", size: 100, lastModified: "2026-10-05T00:00:00Z", ETag: '"e2"' },
    // 3rd newest: 1 day ago (2026-10-04T12:00:00Z) -> outside top 2, but age = 1 day < 3 days!
    { key: "builds/nvidia/0.2.3.20261004T120000Z/x.iso", size: 100, lastModified: "2026-10-04T12:00:00Z", ETag: '"e3"' },
    // 4th: 10 days ago -> deleted
    { key: "builds/nvidia/0.2.3.20260925T120000Z/x.iso", size: 100, lastModified: "2026-09-25T12:00:00Z", ETag: '"e4"' },
  ];

  const plan = planIsoPrune(objects, now, { keepPerGroup: 2, minAgeDays: 3 });
  assert.equal(plan.delete.length, 1);
  assert.equal(plan.delete[0].prefix, "builds/nvidia/0.2.3.20260925T120000Z/");

  const kept = plan.keep.map((k) => k.prefix);
  assert.ok(kept.includes("builds/nvidia/0.2.3.20261004T120000Z/"));
  assert.equal(plan.keep.length, 3);
});

test("r2-iso-prune: 잘못된 시각(lastModified 부재·파싱불가) 접두사는 skipped(invalid-timestamp)로 보존되고 최신2개 순위에서 제외", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    // Valid builds in nvidia group (older than 3 days)
    { key: "builds/nvidia/0.1.20260920T000000Z/a.iso", size: 100, lastModified: "2026-09-20T00:00:00Z", ETag: '"e1"' },
    { key: "builds/nvidia/0.1.20260921T000000Z/a.iso", size: 100, lastModified: "2026-09-21T00:00:00Z", ETag: '"e2"' },
    { key: "builds/nvidia/0.1.20260922T000000Z/a.iso", size: 100, lastModified: "2026-09-22T00:00:00Z", ETag: '"e3"' },
    // Build with unparseable lastModified string
    { key: "builds/nvidia/0.1.20260923T000000Z/a.iso", size: 100, lastModified: "invalid-date-string", ETag: '"e4"' },
    // Build with missing lastModified (null / undefined)
    { key: "builds/nvidia/0.1.20260924T000000Z/a.iso", size: 100, lastModified: null, ETag: '"e5"' },
  ];

  const plan = planIsoPrune(objects, now, { keepPerGroup: 2, minAgeDays: 3 });

  // The invalid-timestamp prefixes must NOT be deleted!
  assert.ok(!plan.delete.some((d) => d.prefix.includes("0.1.20260923T000000Z")));
  assert.ok(!plan.delete.some((d) => d.prefix.includes("0.1.20260924T000000Z")));

  // They must be recorded in skipped with reason 'invalid-timestamp'
  const skippedPrefixes = plan.skipped.map((s) => s.prefix);
  assert.ok(skippedPrefixes.includes("builds/nvidia/0.1.20260923T000000Z/"));
  assert.ok(skippedPrefixes.includes("builds/nvidia/0.1.20260924T000000Z/"));
  assert.equal(plan.skipped.find((s) => s.prefix === "builds/nvidia/0.1.20260923T000000Z/")?.reason, "invalid-timestamp");

  // They must NOT count toward the top-2 ranking:
  // The valid top 2 are 0922 and 0921, which must be in keep
  const kept = plan.keep.map((k) => k.prefix);
  assert.ok(kept.includes("builds/nvidia/0.1.20260922T000000Z/"));
  assert.ok(kept.includes("builds/nvidia/0.1.20260921T000000Z/"));

  // And the remaining valid build 0920 is deleted
  assert.equal(plan.delete.length, 1);
  assert.equal(plan.delete[0].prefix, "builds/nvidia/0.1.20260920T000000Z/");

  // Invalid 'now' parameter must throw an Error
  assert.throws(() => planIsoPrune(objects, "invalid-now-time"), /Invalid now timestamp/);
});

test("r2-iso-prune: 3일 경계 시험 (정확히 72시간 된 것은 삭제 후보, 72시간 미만은 보존)", () => {
  const now = "2026-10-05T12:00:00Z";
  // Cutoff is exactly 2026-10-02T12:00:00Z (72 hours prior)
  const objects = [
    // Top 2 builds (newest) -> retained regardless
    { key: "builds/amd/0.1.20261004T120000Z/a.iso", size: 100, lastModified: "2026-10-04T12:00:00Z", ETag: '"e1"' },
    { key: "builds/amd/0.1.20261003T120000Z/a.iso", size: 100, lastModified: "2026-10-03T12:00:00Z", ETag: '"e2"' },
    // Build 3: 71 hours 59 minutes 59 seconds old (> cutoffMs) -> age < 3 days -> must be kept!
    { key: "builds/amd/0.1.20261002T120001Z/a.iso", size: 100, lastModified: "2026-10-02T12:00:01Z", ETag: '"e3"' },
    // Build 4: Exactly 72 hours old (== cutoffMs) -> age is NOT < 3 days -> must be deleted!
    { key: "builds/amd/0.1.20261002T120000Z/a.iso", size: 100, lastModified: "2026-10-02T12:00:00Z", ETag: '"e4"' },
    // Build 5: 72 hours 1 second old (< cutoffMs) -> must be deleted!
    { key: "builds/amd/0.1.20261002T115959Z/a.iso", size: 100, lastModified: "2026-10-02T11:59:59Z", ETag: '"e5"' },
  ];

  const plan = planIsoPrune(objects, now, { keepPerGroup: 2, minAgeDays: 3 });

  // Exactly 72h and older must be deleted candidates
  const deleted = plan.delete.map((d) => d.prefix);
  assert.ok(deleted.includes("builds/amd/0.1.20261002T120000Z/"));
  assert.ok(deleted.includes("builds/amd/0.1.20261002T115959Z/"));
  assert.equal(plan.delete.length, 2);

  // 71h 59m 59s build must be in keep
  const kept = plan.keep.map((k) => k.prefix);
  assert.ok(kept.includes("builds/amd/0.1.20261002T120001Z/"));
  assert.ok(kept.includes("builds/amd/0.1.20261003T120000Z/"));
  assert.ok(kept.includes("builds/amd/0.1.20261004T120000Z/"));
  assert.equal(plan.keep.length, 3);
});

test("r2-iso-prune: 계획 출력에 접두사별 키 목록과 최신 시각 및 ETag 포함", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    // Top 2 builds to satisfy keepPerGroup
    { key: "builds/nvidia/0.1.20260929T000000Z/a.iso", size: 100, lastModified: "2026-09-29T00:00:00Z", ETag: '"etag-top1"' },
    { key: "builds/nvidia/0.1.20260928T000000Z/a.iso", size: 100, lastModified: "2026-09-28T00:00:00Z", ETag: '"etag-top2"' },
    // Prefix with two objects having different timestamps and sizes
    { key: "builds/nvidia/0.1.20260901T000000Z/a.iso", size: 5000, lastModified: "2026-09-01T10:00:00Z", ETag: '"etag-iso-val"' },
    { key: "builds/nvidia/0.1.20260901T000000Z/a.iso-CHECKSUM", size: 100, lastModified: "2026-09-01T10:05:00Z", ETag: '"etag-chk-val"' },
  ];

  const plan = planIsoPrune(objects, now, { keepPerGroup: 2 });
  assert.equal(plan.delete.length, 1);
  const target = plan.delete[0];

  assert.equal(target.prefix, "builds/nvidia/0.1.20260901T000000Z/");
  // builtAt must reflect the latest LastModified of all objects in the prefix
  assert.equal(target.builtAt, "2026-09-01T10:05:00.000Z");
  assert.equal(target.bytes, 5100);

  // keys must be a sorted array of key strings
  assert.deepEqual(target.keys, [
    "builds/nvidia/0.1.20260901T000000Z/a.iso",
    "builds/nvidia/0.1.20260901T000000Z/a.iso-CHECKSUM",
  ]);

  // objects must contain detailed item objects with normalized ETag
  assert.equal(target.objects.length, 2);
  assert.equal(target.objects[0].key, "builds/nvidia/0.1.20260901T000000Z/a.iso");
  assert.equal(target.objects[0].size, 5000);
  assert.equal(target.objects[0].etag, "etag-iso-val");
  assert.equal(target.objects[1].key, "builds/nvidia/0.1.20260901T000000Z/a.iso-CHECKSUM");
  assert.equal(target.objects[1].size, 100);
  assert.equal(target.objects[1].etag, "etag-chk-val");
});

test("r2-iso-prune: CLI 실패 조건 (파일 없음·JSON 파싱 실패·알 수 없는 인자·잘못된 숫자 인자)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "prune-cli-test-"));
  try {
    const invalidJsonFile = join(tmpDir, "invalid.json");
    writeFileSync(invalidJsonFile, "{ invalid json content");

    const emptyContentsFile = join(tmpDir, "empty-contents.json");
    writeFileSync(emptyContentsFile, JSON.stringify({ Contents: [] }));

    let exitCode = null;
    const testIo = {
      exit: (code) => {
        exitCode = code;
      },
      error: () => {},
      log: () => {},
    };

    // 1. Missing listing file
    exitCode = null;
    assert.throws(
      () => runCli(["--listing", join(tmpDir, "nonexistent.json")], testIo),
      /Failed to read listing file/
    );
    assert.equal(exitCode, 1);

    // 2. Malformed JSON file
    exitCode = null;
    assert.throws(
      () => runCli(["--listing", invalidJsonFile], testIo),
      /Failed to parse listing JSON/
    );
    assert.equal(exitCode, 1);

    // 3. Unknown argument
    exitCode = null;
    assert.throws(
      () => runCli(["--listing", emptyContentsFile, "--unknown-flag"], testIo),
      /Unknown argument/
    );
    assert.equal(exitCode, 1);

    // 4. Invalid max-delete (0, negative, non-integer)
    exitCode = null;
    assert.throws(
      () => runCli(["--listing", emptyContentsFile, "--max-delete", "0"], testIo),
      /--max-delete must be an integer >= 1/
    );
    assert.equal(exitCode, 1);

    exitCode = null;
    assert.throws(
      () => runCli(["--listing", emptyContentsFile, "--max-delete", "abc"], testIo),
      /--max-delete must be an integer >= 1/
    );
    assert.equal(exitCode, 1);

    // 5. Invalid now timestamp
    exitCode = null;
    assert.throws(
      () => runCli(["--listing", emptyContentsFile, "--now", "invalid-now"], testIo),
      /--now must be a valid date\/timestamp/
    );
    assert.equal(exitCode, 1);

    // 6. Valid listing with empty Contents -> succeeds with code 0
    exitCode = null;
    const emptyResult = runCli(["--listing", emptyContentsFile], testIo);
    assert.equal(exitCode, null); // Did not call exit(1)
    assert.equal(emptyResult.delete.length, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune: ETag 부재(missing-etag) 접두사는 skipped로 보존되고 순위 계산에서 제외", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    // Valid builds in nvidia group
    { key: "builds/nvidia/0.1.20260920T000000Z/a.iso", size: 100, lastModified: "2026-09-20T00:00:00Z", ETag: '"etag-valid-1"' },
    { key: "builds/nvidia/0.1.20260921T000000Z/a.iso", size: 100, lastModified: "2026-09-21T00:00:00Z", ETag: '"etag-valid-2"' },
    { key: "builds/nvidia/0.1.20260922T000000Z/a.iso", size: 100, lastModified: "2026-09-22T00:00:00Z", ETag: '"etag-valid-3"' },
    // Build with missing ETag (undefined)
    { key: "builds/nvidia/0.1.20260923T000000Z/a.iso", size: 100, lastModified: "2026-09-23T00:00:00Z" },
    // Build with empty string ETag
    { key: "builds/nvidia/0.1.20260924T000000Z/a.iso", size: 100, lastModified: "2026-09-24T00:00:00Z", ETag: '""' },
  ];

  const plan = planIsoPrune(objects, now, { keepPerGroup: 2 });

  // Missing ETag prefixes must NOT be deleted
  assert.ok(!plan.delete.some((d) => d.prefix.includes("0.1.20260923T000000Z")));
  assert.ok(!plan.delete.some((d) => d.prefix.includes("0.1.20260924T000000Z")));

  // Must be in skipped with reason missing-etag
  const skipped0923 = plan.skipped.find((s) => s.prefix === "builds/nvidia/0.1.20260923T000000Z/");
  const skipped0924 = plan.skipped.find((s) => s.prefix === "builds/nvidia/0.1.20260924T000000Z/");
  assert.equal(skipped0923?.reason, "missing-etag");
  assert.equal(skipped0924?.reason, "missing-etag");

  // Valid top 2 (0922 and 0921) are in keep
  const kept = plan.keep.map((k) => k.prefix);
  assert.ok(kept.includes("builds/nvidia/0.1.20260922T000000Z/"));
  assert.ok(kept.includes("builds/nvidia/0.1.20260921T000000Z/"));

  // Remaining valid build 0920 is deleted
  assert.equal(plan.delete.length, 1);
  assert.equal(plan.delete[0].prefix, "builds/nvidia/0.1.20260920T000000Z/");
});

test("r2-iso-prune: normalizeEtag 따옴표 및 공백 제거 검증", () => {
  assert.equal(normalizeEtag('"abcd"'), "abcd");
  assert.equal(normalizeEtag('  "abcd"  '), "abcd");
  assert.equal(normalizeEtag("abcd"), "abcd");
  assert.equal(normalizeEtag('""'), null);
  assert.equal(normalizeEtag("   "), null);
  assert.equal(normalizeEtag(null), null);
  assert.equal(normalizeEtag(undefined), null);
});

test("r2-iso-prune: 동일 listing·동일 now 로 두 번 계산 시 완전히 같은 계획 산출 (N3)", () => {
  const now = "2026-10-05T12:00:00Z";
  const objects = [
    { key: "builds/nvidia/0.1.20260920T000000Z/a.iso", size: 100, lastModified: "2026-09-20T00:00:00Z", ETag: '"e1"' },
    { key: "builds/nvidia/0.1.20260921T000000Z/a.iso", size: 100, lastModified: "2026-09-21T00:00:00Z", ETag: '"e2"' },
    { key: "builds/nvidia/0.1.20260922T000000Z/a.iso", size: 100, lastModified: "2026-09-22T00:00:00Z", ETag: '"e3"' },
  ];

  const planA = planIsoPrune(objects, now, { keepPerGroup: 2 });
  const planB = planIsoPrune(objects, now, { keepPerGroup: 2 });

  assert.deepEqual(planA, planB);
});

test("r2-iso-prune: 72시간 경계를 넘는 다른 now 를 주면 계획 결과가 달라짐 (N3)", () => {
  // Candidate built at 2026-10-02T12:00:01Z
  // Top 2 builds exist to force candidate into age-based retention evaluation
  const objects = [
    { key: "builds/nvidia/0.1.20261004T000000Z/a.iso", size: 100, lastModified: "2026-10-04T00:00:00Z", ETag: '"top1"' },
    { key: "builds/nvidia/0.1.20261003T000000Z/a.iso", size: 100, lastModified: "2026-10-03T00:00:00Z", ETag: '"top2"' },
    { key: "builds/nvidia/0.1.20261002T120001Z/a.iso", size: 100, lastModified: "2026-10-02T12:00:01Z", ETag: '"cand"' },
  ];

  // now1: 2026-10-05T12:00:00Z -> candidate age is 71h 59m 59s (< 72h) -> candidate is KEPT
  const plan1 = planIsoPrune(objects, "2026-10-05T12:00:00Z", { keepPerGroup: 2 });
  assert.equal(plan1.delete.length, 0);
  assert.equal(plan1.keep.length, 3);

  // now2: 2026-10-05T12:00:02Z -> candidate age is 72h 00m 01s (> 72h) -> candidate is DELETED
  const plan2 = planIsoPrune(objects, "2026-10-05T12:00:02Z", { keepPerGroup: 2 });
  assert.equal(plan2.delete.length, 1);
  assert.equal(plan2.delete[0].prefix, "builds/nvidia/0.1.20261002T120001Z/");

  assert.notDeepEqual(plan1, plan2);
});

test("r2-iso-prune-helper: checkActiveWorkflows 전수 조회 및 saturation·fail-closed 검증 (R1-4)", () => {
  // Case 1: All 5 statuses across both workflows have 0 runs -> active: false
  const execInactive = () => JSON.stringify([]);
  const resInactive = checkActiveWorkflows({ execFn: execInactive });
  assert.deepEqual(resInactive, { active: false });

  // Case 2: One status on promote workflow returns 1 run -> active: true, reason: promote-active
  const execPromoteActive = (cmd, args) => {
    if (args.includes("naia-os-iso-promote.yml") && args.includes("in_progress")) {
      return JSON.stringify([{ databaseId: 12345 }]);
    }
    return JSON.stringify([]);
  };
  const resPromote = checkActiveWorkflows({ execFn: execPromoteActive });
  assert.equal(resPromote.active, true);
  assert.equal(resPromote.reason, "promote-active");

  // Case 3: Exactly 100 runs returned (saturation) -> active: true
  const execSaturated = (cmd, args) => {
    if (args.includes("naia-os-iso.yml") && args.includes("queued")) {
      return JSON.stringify(new Array(100).fill({ databaseId: 1 }));
    }
    return JSON.stringify([]);
  };
  const resSaturated = checkActiveWorkflows({ execFn: execSaturated });
  assert.equal(resSaturated.active, true);
  assert.equal(resSaturated.reason, "iso-build-active");

  // Case 4: gh command error -> fail-closed (active: true, reason: gh-error)
  const execError = () => {
    throw new Error("gh run failed (exit 1)");
  };
  const resError = checkActiveWorkflows({ execFn: execError });
  assert.equal(resError.active, true);
  assert.equal(resError.reason, "gh-error");
});

test("r2-iso-prune-helper: listObjectsV2Pages 페이지네이션 및 Truncated/Contents 검증 (R1-6)", () => {
  // Case 1: Single page non-truncated returns all items
  const execSingle = () =>
    JSON.stringify({
      IsTruncated: false,
      KeyCount: 2,
      Contents: [
        { Key: "builds/nvidia/0.1/a.iso", Size: 100, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' },
        { Key: "builds/nvidia/0.1/b.iso", Size: 200, LastModified: "2026-09-01T00:00:00Z", ETag: '"e2"' },
      ],
    });
  const singleItems = listObjectsV2Pages({ bucket: "naia-releases", prefix: "builds/" }, execSingle);
  assert.equal(singleItems.length, 2);

  // Case 2: Multi-page pagination
  const execMulti = (cmd, args) => {
    if (!args.includes("--continuation-token")) {
      return JSON.stringify({
        IsTruncated: true,
        NextContinuationToken: "token-page-2",
        KeyCount: 1,
        Contents: [{ Key: "builds/nvidia/0.1/p1.iso", Size: 10, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' }],
      });
    } else if (args.includes("token-page-2")) {
      return JSON.stringify({
        IsTruncated: false,
        KeyCount: 1,
        Contents: [{ Key: "builds/nvidia/0.1/p2.iso", Size: 20, LastModified: "2026-09-01T00:00:00Z", ETag: '"e2"' }],
      });
    }
    throw new Error("Unexpected token");
  };
  const multiItems = listObjectsV2Pages({ bucket: "naia-releases", prefix: "builds/" }, execMulti);
  assert.equal(multiItems.length, 2);
  assert.equal(multiItems[0].Key, "builds/nvidia/0.1/p1.iso");
  assert.equal(multiItems[1].Key, "builds/nvidia/0.1/p2.iso");

  // Case 3: IsTruncated == true without NextContinuationToken -> throws error
  const execTruncatedNoToken = () =>
    JSON.stringify({
      IsTruncated: true,
      KeyCount: 1,
      Contents: [{ Key: "builds/x.iso", Size: 10, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' }],
    });
  assert.throws(
    () => listObjectsV2Pages({ bucket: "naia-releases", prefix: "builds/" }, execTruncatedNoToken),
    /NextContinuationToken is missing/
  );

  // Case 4: KeyCount > 0 but Contents missing -> throws error
  const execMissingContents = () =>
    JSON.stringify({
      IsTruncated: false,
      KeyCount: 5,
    });
  assert.throws(
    () => listObjectsV2Pages({ bucket: "naia-releases", prefix: "builds/" }, execMissingContents),
    /Contents missing with non-zero KeyCount/
  );

  // Case 5: Exceeding maxPages -> throws error
  const execInfinite = () =>
    JSON.stringify({
      IsTruncated: true,
      NextContinuationToken: "next-infinite",
      KeyCount: 1,
      Contents: [{ Key: "k", Size: 1, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' }],
    });
  assert.throws(
    () => listObjectsV2Pages({ bucket: "naia-releases", prefix: "builds/", maxPages: 3 }, execInfinite),
    /exceeded maximum allowed pages/
  );
});

test("r2-iso-prune-helper: comparePrefixObjects 키·ETag·Size·LastModified 대조 검증 (R1-5 / N2)", () => {
  const prefix = "builds/nvidia/0.1.20260901T000000Z/";
  const plannedObjects = [
    {
      key: `${prefix}naia-os-live-amd64.iso`,
      size: 5000,
      lastModified: "2026-09-01T10:00:00.000Z",
      etag: "etag-iso",
    },
    {
      key: `${prefix}naia-os-live-amd64.iso-CHECKSUM`,
      size: 100,
      lastModified: "2026-09-01T10:05:00.000Z",
      etag: "etag-chk",
    },
  ];

  // Identical current contents
  const currentMatching = [
    {
      Key: `${prefix}naia-os-live-amd64.iso`,
      Size: 5000,
      LastModified: "2026-09-01T10:00:00.000Z",
      ETag: '"etag-iso"',
    },
    {
      Key: `${prefix}naia-os-live-amd64.iso-CHECKSUM`,
      Size: 100,
      LastModified: "2026-09-01T10:05:00.000Z",
      ETag: '"etag-chk"',
    },
  ];
  assert.deepEqual(comparePrefixObjects(plannedObjects, currentMatching, prefix), { match: true });

  // Key count mismatch
  assert.deepEqual(comparePrefixObjects(plannedObjects, [currentMatching[0]], prefix), {
    match: false,
    reason: "changed-since-plan",
  });

  // ETag mismatch
  const currentEtagMismatch = [
    { ...currentMatching[0], ETag: '"different-etag"' },
    currentMatching[1],
  ];
  assert.deepEqual(comparePrefixObjects(plannedObjects, currentEtagMismatch, prefix), {
    match: false,
    reason: "changed-since-plan",
  });

  // Size mismatch
  const currentSizeMismatch = [
    { ...currentMatching[0], Size: 5001 },
    currentMatching[1],
  ];
  assert.deepEqual(comparePrefixObjects(plannedObjects, currentSizeMismatch, prefix), {
    match: false,
    reason: "changed-since-plan",
  });

  // LastModified mismatch
  const currentTimeMismatch = [
    { ...currentMatching[0], LastModified: "2026-09-01T10:00:01.000Z" },
    currentMatching[1],
  ];
  assert.deepEqual(comparePrefixObjects(plannedObjects, currentTimeMismatch, prefix), {
    match: false,
    reason: "changed-since-plan",
  });

  // Key does not start with prefix
  const currentBadPrefix = [
    { ...currentMatching[0], Key: "other-prefix/file.iso" },
    currentMatching[1],
  ];
  assert.deepEqual(comparePrefixObjects(plannedObjects, currentBadPrefix, prefix), {
    match: false,
    reason: "changed-since-plan",
  });
});

test("r2-iso-prune-helper: deleteObjectKey 단일 객체 삭제 및 접두사 검증 (R1-5 / N2)", () => {
  const executedCalls = [];
  const mockExec = (cmd, args) => {
    executedCalls.push({ cmd, args });
    return "";
  };

  const prefix = "builds/nvidia/0.1/";
  const key = "builds/nvidia/0.1/a.iso";

  deleteObjectKey("naia-releases", key, prefix, mockExec);
  assert.equal(executedCalls.length, 1);
  assert.deepEqual(executedCalls[0].args, [
    "s3api",
    "delete-object",
    "--bucket",
    "naia-releases",
    "--key",
    key,
  ]);

  // Key not starting with prefix must throw error
  assert.throws(
    () => deleteObjectKey("naia-releases", "different/prefix/a.iso", prefix, mockExec),
    /does not start with prefix/
  );
});

test("r2-iso-prune-helper: ResultRecorder 및 parseResultJsonl 정확도·unknown 판정 검증 (R1-7)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "result-test-"));
  try {
    const resultFile = join(tmpDir, "prune-result.jsonl");

    // Scenario 1: Normal completed execution
    const rec1 = new ResultRecorder(resultFile);
    rec1.init("live", "running", "");
    rec1.startPrefix("builds/nvidia/0.1/", "nvidia", 1000);
    rec1.finishPrefix("builds/nvidia/0.1/", "nvidia", "deleted", "ok", 1000);
    rec1.startPrefix("builds/nvidia/0.2/", "nvidia", 2000);
    rec1.finishPrefix("builds/nvidia/0.2/", "nvidia", "skipped", "changed-since-plan", 2000);
    rec1.writeStatus("partial", "");

    const parsed1 = parseResultJsonlFile(resultFile);
    assert.deepEqual(parsed1, parseResultJsonl(readFileSync(resultFile, "utf-8")));
    assert.equal(parsed1.mode, "live");
    assert.equal(parsed1.status, "partial");
    assert.equal(parsed1.deleted.length, 1);
    assert.equal(parsed1.deleted[0].prefix, "builds/nvidia/0.1/");
    assert.equal(parsed1.totalDeletedBytes, 1000);
    assert.equal(parsed1.skipped.length, 1);
    assert.equal(parsed1.unknown.length, 0);

    // Scenario 2: Cancellation during prefix deletion (prefix-start exists without prefix-result)
    const rec2 = new ResultRecorder(resultFile);
    rec2.init("live", "running", "");
    rec2.startPrefix("builds/nvidia/0.1/", "nvidia", 1000);
    rec2.finishPrefix("builds/nvidia/0.1/", "nvidia", "deleted", "ok", 1000);
    rec2.startPrefix("builds/nvidia/0.2/", "nvidia", 2000); // Interrupted before finishPrefix!

    const parsed2 = parseResultJsonlFile(resultFile);
    assert.deepEqual(parsed2, parseResultJsonl(readFileSync(resultFile, "utf-8")));
    assert.equal(parsed2.status, "aborted");
    assert.equal(parsed2.deleted.length, 1);
    assert.equal(parsed2.totalDeletedBytes, 1000); // Only finished deletes counted
    assert.equal(parsed2.unknown.length, 1);
    assert.equal(parsed2.unknown[0].prefix, "builds/nvidia/0.2/");

    // Scenario 3: Aborted early at start (e.g. promote-active)
    const rec3 = new ResultRecorder(resultFile);
    rec3.init("live", "aborted", "promote-active");
    rec3.writeStatus("aborted", "promote-active");

    const parsed3 = parseResultJsonlFile(resultFile);
    assert.deepEqual(parsed3, parseResultJsonl(readFileSync(resultFile, "utf-8")));
    assert.equal(parsed3.status, "aborted");
    assert.equal(parsed3.reason, "promote-active");
    assert.equal(parsed3.deleted.length, 0);
    assert.equal(parsed3.totalDeletedBytes, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune-helper: safeExec 오류 노출 방지(종료 코드만 포함, stderr/args 배제) (N4)", () => {
  // Test that safeExec formats errors as `<cmd> <subcmd> failed (exit <status>)`
  assert.throws(
    () => safeExec("nonexistent-command-for-safe-exec", ["subcommand", "secret-key", "https://secret-endpoint"]),
    (err) => {
      // Must not expose full arguments or sensitive strings
      assert.ok(!err.message.includes("secret-key"));
      assert.ok(!err.message.includes("secret-endpoint"));
      assert.match(err.message, /nonexistent-command-for-safe-exec subcommand failed \(exit /);
      return true;
    }
  );
});

test("r2-iso-prune-helper: ResultRecorder 단일 type:status 보장 및 중복 기록 방지 (S1)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rec-dedup-test-"));
  try {
    const resultFile = join(tmpDir, "prune-result.jsonl");

    // Case 1: Multiple writeStatus calls on same instance are ignored after first
    const rec = new ResultRecorder(resultFile);
    rec.init("live", "running", "");
    rec.writeStatus("aborted", "promote-active");
    rec.writeStatus("completed", ""); // Should be blocked
    rec.writeStatus("partial", "");   // Should be blocked

    const raw1 = readFileSync(resultFile, "utf-8").trim().split("\n");
    const statusLines1 = raw1.filter((l) => JSON.parse(l).type === "status");
    assert.equal(statusLines1.length, 1);
    assert.equal(JSON.parse(statusLines1[0]).status, "aborted");
    assert.equal(JSON.parse(statusLines1[0]).reason, "promote-active");

    // Case 2: New ResultRecorder pointing to existing file with status line is also blocked
    const recSecond = new ResultRecorder(resultFile);
    recSecond.writeStatus("completed", "should-not-be-written");
    const raw2 = readFileSync(resultFile, "utf-8").trim().split("\n");
    const statusLines2 = raw2.filter((l) => JSON.parse(l).type === "status");
    assert.equal(statusLines2.length, 1);

    // Case 3: check-active pattern: header with status, then writeStatus once
    const checkFile = join(tmpDir, "check-active.jsonl");
    const recCheck = new ResultRecorder(checkFile);
    recCheck.init("live", "aborted", "promote-active");
    recCheck.writeStatus("aborted", "promote-active");
    recCheck.writeStatus("completed", ""); // Second call blocked
    const rawCheck = readFileSync(checkFile, "utf-8").trim().split("\n");
    const headerLines = rawCheck.filter((l) => JSON.parse(l).type === "header");
    const statusLinesCheck = rawCheck.filter((l) => JSON.parse(l).type === "status");
    assert.equal(headerLines.length, 1);
    assert.equal(statusLinesCheck.length, 1);
    assert.equal(JSON.parse(statusLinesCheck[0]).status, "aborted");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune-helper: execute 도중 워크플로 활성 감지 시 단일 상태(partial|aborted) 기록 후 즉시 exit 0 (S1)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "exec-active-test-"));
  try {
    const listingFile = join(tmpDir, "listing.json");
    writeFileSync(
      listingFile,
      JSON.stringify({
        Contents: [
          { Key: "builds/nvidia/0.1.20260901T000000Z/a.iso", Size: 1000, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' },
          { Key: "builds/nvidia/0.1.20260902T000000Z/a.iso", Size: 2000, LastModified: "2026-09-02T00:00:00Z", ETag: '"e2"' },
          { Key: "builds/nvidia/0.1.20260903T000000Z/a.iso", Size: 3000, LastModified: "2026-09-03T00:00:00Z", ETag: '"e3"' },
          { Key: "builds/nvidia/0.1.20260904T000000Z/a.iso", Size: 4000, LastModified: "2026-09-04T00:00:00Z", ETag: '"e4"' },
        ],
      })
    );

    const candidatePagesMock = (opts) => {
      if (opts.prefix.includes("20260901")) {
        return [{ Key: "builds/nvidia/0.1.20260901T000000Z/a.iso", Size: 1000, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' }];
      }
      if (opts.prefix.includes("20260902")) {
        return [{ Key: "builds/nvidia/0.1.20260902T000000Z/a.iso", Size: 2000, LastModified: "2026-09-02T00:00:00Z", ETag: '"e2"' }];
      }
      return [];
    };

    // Subcase A: Active immediately on first target -> deleted 0 bytes -> status aborted, exit 0
    const resultFileA = join(tmpDir, "res-a.jsonl");
    let exitCodeA = null;
    runHelperCli(
      [
        "execute",
        "--listing", listingFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "false",
        "--max-delete", "10",
        "--result-out", resultFileA,
      ],
      {
        exit: (code) => { exitCodeA = code; },
        error: () => {},
        log: () => {},
        checkActiveFn: () => ({ active: true, reason: "promote-active" }),
        listPagesFn: candidatePagesMock,
      }
    );
    assert.equal(exitCodeA, 0);
    const parsedA = parseResultJsonlFile(resultFileA);
    assert.equal(parsedA.status, "aborted");
    assert.equal(parsedA.reason, "promote-active");
    assert.equal(parsedA.totalDeletedBytes, 0);
    const linesA = readFileSync(resultFileA, "utf-8").trim().split("\n");
    const statusLinesA = linesA.filter((l) => JSON.parse(l).type === "status");
    assert.equal(statusLinesA.length, 1);

    // Subcase B: Active after 1st prefix deleted -> status partial, exit 0
    const resultFileB = join(tmpDir, "res-b.jsonl");
    let exitCodeB = null;
    let callCount = 0;
    runHelperCli(
      [
        "execute",
        "--listing", listingFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "false",
        "--max-delete", "10",
        "--result-out", resultFileB,
      ],
      {
        exit: (code) => { exitCodeB = code; },
        error: () => {},
        log: () => {},
        checkActiveFn: () => {
          callCount++;
          return callCount === 1 ? { active: false } : { active: true, reason: "iso-build-active" };
        },
        listPagesFn: candidatePagesMock,
        deleteKeyFn: () => {},
      }
    );
    assert.equal(exitCodeB, 0);
    const parsedB = parseResultJsonlFile(resultFileB);
    assert.equal(parsedB.status, "partial");
    assert.equal(parsedB.reason, "iso-build-active");
    assert.equal(parsedB.deleted.length, 1);
    assert.equal(parsedB.totalDeletedBytes, 1000);
    const linesB = readFileSync(resultFileB, "utf-8").trim().split("\n");
    const statusLinesB = linesB.filter((l) => JSON.parse(l).type === "status");
    assert.equal(statusLinesB.length, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune-helper: plan 및 execute 인자 엄격 검증 (max-delete, now, dry-run) (M1)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "arg-val-test-"));
  try {
    const listingFile = join(tmpDir, "listing.json");
    writeFileSync(listingFile, JSON.stringify({ Contents: [] }));

    const runWithArgs = (cliArgs) => {
      let exitCode = null;
      let errorMsg = "";
      const fullArgs = [...cliArgs];
      if (cliArgs[0] === "plan" && !cliArgs.includes("--plan-out")) {
        fullArgs.push("--plan-out", join(tmpDir, "plan.json"));
      }
      if (cliArgs[0] === "execute" && !cliArgs.includes("--result-out")) {
        fullArgs.push("--result-out", join(tmpDir, "prune-result.jsonl"));
      }
      runHelperCli(fullArgs, {
        exit: (code) => { exitCode = code; },
        error: (msg) => { errorMsg = msg; },
        log: () => {},
      });
      return { exitCode, errorMsg };
    };

    // plan max-delete validation
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--max-delete", "NaN", "--dry-run", "true"]).exitCode, 1);
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--max-delete", "10abc", "--dry-run", "true"]).exitCode, 1);
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--max-delete", "0", "--dry-run", "true"]).exitCode, 1);
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--max-delete", "51", "--dry-run", "true"]).exitCode, 1);
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--max-delete", "", "--dry-run", "true"]).exitCode, 1);
    // plan without --max-delete succeeds (defaults to 10)
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--dry-run", "true"]).exitCode, 0);

    // plan dry-run validation
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--dry-run", "maybe"]).exitCode, 1);
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--dry-run", ""]).exitCode, 1);
    assert.equal(runWithArgs(["plan", "--listing", listingFile]).exitCode, 1); // missing dry-run
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--dry-run", "true"]).exitCode, 0);
    assert.equal(runWithArgs(["plan", "--listing", listingFile, "--dry-run", "false"]).exitCode, 0);

    // execute now validation
    assert.equal(runWithArgs(["execute", "--listing", listingFile, "--dry-run", "true"]).exitCode, 1); // missing now
    assert.equal(runWithArgs(["execute", "--listing", listingFile, "--now", "invalid-now-val", "--dry-run", "true"]).exitCode, 1);

    // execute max-delete validation
    assert.equal(runWithArgs(["execute", "--listing", listingFile, "--now", "2026-10-05T12:00:00Z", "--dry-run", "true", "--max-delete", "NaN"]).exitCode, 1);
    assert.equal(runWithArgs(["execute", "--listing", listingFile, "--now", "2026-10-05T12:00:00Z", "--dry-run", "true", "--max-delete", "0"]).exitCode, 1);
    assert.equal(runWithArgs(["execute", "--listing", listingFile, "--now", "2026-10-05T12:00:00Z", "--dry-run", "true", "--max-delete", "51"]).exitCode, 1);
    assert.equal(runWithArgs(["execute", "--listing", listingFile, "--now", "2026-10-05T12:00:00Z", "--dry-run", "true", "--max-delete", ""]).exitCode, 1);

    // execute dry-run validation
    assert.equal(runWithArgs(["execute", "--listing", listingFile, "--now", "2026-10-05T12:00:00Z", "--dry-run", "1"]).exitCode, 1);
    assert.equal(runWithArgs(["execute", "--listing", listingFile, "--now", "2026-10-05T12:00:00Z"]).exitCode, 1);
    assert.equal(runWithArgs(["execute", "--listing", listingFile, "--now", "2026-10-05T12:00:00Z", "--dry-run", "true"]).exitCode, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune-helper: listObjectsV2Pages 응답 형태 엄격 검사 (M2)", () => {
  const assertThrowsPage = (pageObj, expectedMsg) => {
    assert.throws(
      () => listObjectsV2Pages({ bucket: "naia-releases", prefix: "builds/" }, () => JSON.stringify(pageObj)),
      (err) => {
        assert.match(err.message, expectedMsg);
        assert.match(err.message, /page 1/);
        // Error message must NOT leak keys or endpoints
        assert.ok(!err.message.includes("secret"));
        assert.ok(!err.message.includes("https://"));
        return true;
      }
    );
  };

  const validItem = { Key: "builds/nvidia/0.1/a.iso", Size: 100, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' };

  // 1. IsTruncated not boolean
  assertThrowsPage({ IsTruncated: "true", KeyCount: 1, Contents: [validItem] }, /IsTruncated must be a boolean/);
  assertThrowsPage({ KeyCount: 0, Contents: [] }, /IsTruncated must be a boolean/);
  assertThrowsPage({ IsTruncated: 1, KeyCount: 1, Contents: [validItem] }, /IsTruncated must be a boolean/);

  // 2. KeyCount missing or non-integer or negative
  assertThrowsPage({ IsTruncated: false, Contents: [] }, /KeyCount must be a non-negative integer/);
  assertThrowsPage({ IsTruncated: false, KeyCount: "1", Contents: [validItem] }, /KeyCount must be a non-negative integer/);
  assertThrowsPage({ IsTruncated: false, KeyCount: -1, Contents: [] }, /KeyCount must be a non-negative integer/);
  assertThrowsPage({ IsTruncated: false, KeyCount: 1.5, Contents: [validItem] }, /KeyCount must be a non-negative integer/);

  // 3. Contents length != KeyCount
  assertThrowsPage({ IsTruncated: false, KeyCount: 2, Contents: [validItem] }, /Contents length must match KeyCount/);
  assertThrowsPage({ IsTruncated: false, KeyCount: 1, Contents: [] }, /Contents length must match KeyCount/);
  assertThrowsPage({ IsTruncated: false, KeyCount: 1, Contents: null }, /Contents missing with non-zero KeyCount/);

  // 4. KeyCount == 0 with Contents missing is valid
  const emptyRes = listObjectsV2Pages({ bucket: "naia-releases", prefix: "builds/" }, () =>
    JSON.stringify({ IsTruncated: false, KeyCount: 0 })
  );
  assert.deepEqual(emptyRes, []);

  // 5. Item validation: Key, Size, LastModified, ETag
  assertThrowsPage(
    { IsTruncated: false, KeyCount: 1, Contents: [{ ...validItem, Key: "" }] },
    /item Key must be a non-empty string/
  );
  assertThrowsPage(
    { IsTruncated: false, KeyCount: 1, Contents: [{ ...validItem, Size: -5 }] },
    /item Size must be a non-negative integer/
  );
  assertThrowsPage(
    { IsTruncated: false, KeyCount: 1, Contents: [{ ...validItem, Size: "100" }] },
    /item Size must be a non-negative integer/
  );
  assertThrowsPage(
    { IsTruncated: false, KeyCount: 1, Contents: [{ ...validItem, LastModified: "" }] },
    /item LastModified must be a non-empty string/
  );
  assertThrowsPage(
    { IsTruncated: false, KeyCount: 1, Contents: [{ ...validItem, ETag: "" }] },
    /item ETag must be a non-empty string/
  );
  assertThrowsPage(
    { IsTruncated: false, KeyCount: 1, Contents: [{ ...validItem, ETag: "   " }] },
    /item ETag must be a non-empty string/
  );
});

test("r2-iso-prune-helper: 접두사 일부 삭제 후 실패 시 partial-failed 및 회수 용량 집계 (M3)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "part-fail-test-"));
  try {
    const listingFile = join(tmpDir, "listing.json");
    writeFileSync(
      listingFile,
      JSON.stringify({
        Contents: [
          { Key: "builds/nvidia/0.1.20260901T000000Z/a.iso", Size: 5000, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' },
          { Key: "builds/nvidia/0.1.20260901T000000Z/a.iso-CHECKSUM", Size: 100, LastModified: "2026-09-01T00:00:00Z", ETag: '"e2"' },
          { Key: "builds/nvidia/0.1.20260902T000000Z/a.iso", Size: 1000, LastModified: "2026-09-02T00:00:00Z", ETag: '"e3"' },
          { Key: "builds/nvidia/0.1.20260903T000000Z/a.iso", Size: 1000, LastModified: "2026-09-03T00:00:00Z", ETag: '"e4"' },
        ],
      })
    );

    // Case 1: Key 1 succeeds (5000 bytes deleted), Key 2 fails -> partial-failed, totalDeletedBytes = 5000, status partial
    const resultFile1 = join(tmpDir, "res1.jsonl");
    let exitCode1 = null;
    let deleteCount1 = 0;
    runHelperCli(
      [
        "execute",
        "--listing", listingFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "false",
        "--max-delete", "10",
        "--result-out", resultFile1,
      ],
      {
        exit: (code) => { exitCode1 = code; },
        error: () => {},
        log: () => {},
        checkActiveFn: () => ({ active: false }),
        listPagesFn: () => [
          { Key: "builds/nvidia/0.1.20260901T000000Z/a.iso", Size: 5000, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' },
          { Key: "builds/nvidia/0.1.20260901T000000Z/a.iso-CHECKSUM", Size: 100, LastModified: "2026-09-01T00:00:00Z", ETag: '"e2"' },
        ],
        deleteKeyFn: () => {
          deleteCount1++;
          if (deleteCount1 > 1) {
            throw new Error("delete key failed");
          }
        },
      }
    );
    assert.equal(exitCode1, 1);

    const parsed1 = parseResultJsonlFile(resultFile1);
    assert.equal(parsed1.status, "partial");
    assert.equal(parsed1.reason, "delete-failed");
    assert.equal(parsed1.totalDeletedBytes, 5000); // 5000 bytes reclaimed!
    assert.equal(parsed1.failed.length, 1);
    assert.equal(parsed1.failed[0].partial, true);
    assert.equal(parsed1.failed[0].bytes, 5000);
    assert.equal(parsed1.failed[0].deletedKeys, 1);
    assert.equal(parsed1.failed[0].totalKeys, 2);

    const md1 = renderResultMarkdown(parsed1);
    assert.match(md1, /Execution Status:\*\*\s*`partial`/);
    assert.match(md1, /Failed Deletions/);
    assert.match(md1, /1\/2 keys/);

    // Case 2: Key 1 fails (0 bytes deleted) -> failed, totalDeletedBytes = 0, status aborted
    const resultFile2 = join(tmpDir, "res2.jsonl");
    let exitCode2 = null;
    runHelperCli(
      [
        "execute",
        "--listing", listingFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "false",
        "--max-delete", "10",
        "--result-out", resultFile2,
      ],
      {
        exit: (code) => { exitCode2 = code; },
        error: () => {},
        log: () => {},
        checkActiveFn: () => ({ active: false }),
        listPagesFn: () => [
          { Key: "builds/nvidia/0.1.20260901T000000Z/a.iso", Size: 5000, LastModified: "2026-09-01T00:00:00Z", ETag: '"e1"' },
          { Key: "builds/nvidia/0.1.20260901T000000Z/a.iso-CHECKSUM", Size: 100, LastModified: "2026-09-01T00:00:00Z", ETag: '"e2"' },
        ],
        deleteKeyFn: () => {
          throw new Error("delete key failed immediately");
        },
      }
    );
    assert.equal(exitCode2, 1);

    const parsed2 = parseResultJsonlFile(resultFile2);
    assert.equal(parsed2.status, "aborted");
    assert.equal(parsed2.reason, "delete-failed");
    assert.equal(parsed2.totalDeletedBytes, 0);
    assert.equal(parsed2.failed.length, 1);
    assert.equal(parsed2.failed[0].partial, false);
    assert.equal(parsed2.failed[0].bytes, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune-helper: check-active 및 fetch-listing 의 --dry-run 헤더 mode 반영 (M5)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "mode-test-"));
  try {
    const resCheckDry = join(tmpDir, "check-dry.jsonl");
    runHelperCli(
      ["check-active", "--dry-run", "true", "--result-out", resCheckDry],
      {
        exit: () => {},
        error: () => {},
        log: () => {},
        checkActiveFn: () => ({ active: true, reason: "promote-active" }),
      }
    );
    const headerCheckDry = JSON.parse(readFileSync(resCheckDry, "utf-8").trim().split("\n")[0]);
    assert.equal(headerCheckDry.mode, "dry-run");

    const resCheckLive = join(tmpDir, "check-live.jsonl");
    runHelperCli(
      ["check-active", "--dry-run", "false", "--result-out", resCheckLive],
      {
        exit: () => {},
        error: () => {},
        log: () => {},
        checkActiveFn: () => ({ active: true, reason: "promote-active" }),
      }
    );
    const headerCheckLive = JSON.parse(readFileSync(resCheckLive, "utf-8").trim().split("\n")[0]);
    assert.equal(headerCheckLive.mode, "live");

    const resFetchDry = join(tmpDir, "fetch-dry.jsonl");
    runHelperCli(
      ["fetch-listing", "--dry-run", "true", "--out", join(tmpDir, "out-dry.json"), "--result-out", resFetchDry],
      {
        exit: () => {},
        error: () => {},
        log: () => {},
        execFn: () => { throw new Error("listing failed"); },
      }
    );
    const headerFetchDry = JSON.parse(readFileSync(resFetchDry, "utf-8").trim().split("\n")[0]);
    assert.equal(headerFetchDry.mode, "dry-run");

    const resFetchLive = join(tmpDir, "fetch-live.jsonl");
    runHelperCli(
      ["fetch-listing", "--dry-run", "false", "--out", join(tmpDir, "out-live.json"), "--result-out", resFetchLive],
      {
        exit: () => {},
        error: () => {},
        log: () => {},
        execFn: () => { throw new Error("listing failed"); },
      }
    );
    const headerFetchLive = JSON.parse(readFileSync(resFetchLive, "utf-8").trim().split("\n")[0]);
    assert.equal(headerFetchLive.mode, "live");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune-helper: 결과 파일 부재 시 missing-result 및 parseResultJsonl 분리 (M6)", () => {
  const missingResult = parseResultJsonlFile("nonexistent-result-file-path.jsonl");
  assert.equal(missingResult.status, "aborted");
  assert.equal(missingResult.reason, "missing-result");
  assert.equal(missingResult.mode, "unknown");

  const md = renderResultMarkdown(missingResult);
  assert.match(md, /Execution Status:\*\*\s*`aborted`/);
  assert.match(md, /Status Reason:\*\*\s*missing-result/);

  // parseResultJsonl receives string only
  const content = JSON.stringify({ type: "header", mode: "live", status: "completed" }) + "\n";
  const parsed = parseResultJsonl(content);
  assert.equal(parsed.mode, "live");
  assert.equal(parsed.status, "completed");
});

test("r2-iso-prune-helper: renderPlanMarkdown 계획 표 LIVE RUN 문구 (S2)", () => {
  const plan = {
    delete: [],
    keep: [],
    skipped: [],
    totalDeleteBytes: 0,
    truncated: false,
  };

  const mdLive = renderPlanMarkdown(plan, { dryRun: false, maxDelete: 10 });
  assert.match(mdLive, /⚠️ LIVE RUN \(deletion follows\)/);
  assert.ok(!mdLive.includes("Objects deleted"));

  const mdDry = renderPlanMarkdown(plan, { dryRun: true, maxDelete: 10 });
  assert.match(mdDry, /🔍 Dry Run \(No objects deleted\)/);
});

test("r2-iso-prune-helper: 버킷 고정 검증 및 invalid-bucket 기록 (P1)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "bucket-test-"));
  try {
    // 1. Constant check
    assert.equal(ALLOWED_BUCKET, "naia-releases");

    // 2. resolveBucketArg unit check
    assert.deepEqual(resolveBucketArg([]), { ok: true, bucket: "naia-releases" });
    assert.deepEqual(resolveBucketArg(["--other", "val"]), { ok: true, bucket: "naia-releases" });
    assert.deepEqual(resolveBucketArg(["--bucket", "naia-releases"]), { ok: true, bucket: "naia-releases" });
    assert.equal(resolveBucketArg(["--bucket", "other-bucket"]).ok, false);
    assert.equal(resolveBucketArg(["--bucket", ""]).ok, false);
    assert.equal(resolveBucketArg(["--bucket"]).ok, false);

    // 3. deleteObjectKey bucket check
    const mockExec = () => "";
    assert.throws(
      () => deleteObjectKey("wrong-bucket", "builds/nvidia/0.1/a.iso", "builds/nvidia/0.1/", mockExec),
      /Bucket 'wrong-bucket' is not allowed/
    );
    assert.doesNotThrow(() =>
      deleteObjectKey("naia-releases", "builds/nvidia/0.1/a.iso", "builds/nvidia/0.1/", mockExec)
    );

    // 4. fetch-listing with wrong bucket -> records aborted / invalid-bucket to result-out
    const resFetchWrong = join(tmpDir, "res-fetch-wrong.jsonl");
    let exitFetchWrong = null;
    runHelperCli(
      [
        "fetch-listing",
        "--bucket", "wrong-bucket",
        "--out", join(tmpDir, "out1.json"),
        "--result-out", resFetchWrong,
      ],
      {
        exit: (code) => { exitFetchWrong = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitFetchWrong, 1);
    const parsedFetchWrong = parseResultJsonlFile(resFetchWrong);
    assert.equal(parsedFetchWrong.status, "aborted");
    assert.equal(parsedFetchWrong.reason, "invalid-bucket");

    // fetch-listing with empty string bucket
    const resFetchEmpty = join(tmpDir, "res-fetch-empty.jsonl");
    let exitFetchEmpty = null;
    runHelperCli(
      [
        "fetch-listing",
        "--bucket", "",
        "--out", join(tmpDir, "out2.json"),
        "--result-out", resFetchEmpty,
      ],
      {
        exit: (code) => { exitFetchEmpty = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitFetchEmpty, 1);
    const parsedFetchEmpty = parseResultJsonlFile(resFetchEmpty);
    assert.equal(parsedFetchEmpty.status, "aborted");
    assert.equal(parsedFetchEmpty.reason, "invalid-bucket");

    // fetch-listing with flag without value
    let exitFetchNoVal = null;
    runHelperCli(
      [
        "fetch-listing",
        "--out", join(tmpDir, "out3.json"),
        "--bucket",
      ],
      {
        exit: (code) => { exitFetchNoVal = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitFetchNoVal, 1);

    // fetch-listing with omitted bucket succeeds with default ALLOWED_BUCKET
    let exitFetchOmitted = null;
    let recordedBucket = null;
    runHelperCli(
      [
        "fetch-listing",
        "--out", join(tmpDir, "out4.json"),
        "--result-out", join(tmpDir, "res-fetch-ok.jsonl"),
      ],
      {
        exit: (code) => { exitFetchOmitted = code; },
        error: () => {},
        log: () => {},
        execFn: (cmd, args) => {
          const bIdx = args.indexOf("--bucket");
          if (bIdx !== -1) recordedBucket = args[bIdx + 1];
          return JSON.stringify({ IsTruncated: false, KeyCount: 0, Contents: [] });
        },
      }
    );
    assert.equal(exitFetchOmitted, 0);
    assert.equal(recordedBucket, "naia-releases");

    // 5. execute with wrong bucket -> records aborted / invalid-bucket to result-out
    const listingFile = join(tmpDir, "listing.json");
    writeFileSync(listingFile, JSON.stringify({ Contents: [] }));

    const resExecWrong = join(tmpDir, "res-exec-wrong.jsonl");
    let exitExecWrong = null;
    runHelperCli(
      [
        "execute",
        "--bucket", "wrong-bucket",
        "--listing", listingFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "true",
        "--result-out", resExecWrong,
      ],
      {
        exit: (code) => { exitExecWrong = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitExecWrong, 1);
    const parsedExecWrong = parseResultJsonlFile(resExecWrong);
    assert.equal(parsedExecWrong.status, "aborted");
    assert.equal(parsedExecWrong.reason, "invalid-bucket");

    // execute with empty string bucket
    const resExecEmpty = join(tmpDir, "res-exec-empty.jsonl");
    let exitExecEmpty = null;
    runHelperCli(
      [
        "execute",
        "--bucket", "",
        "--listing", listingFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "true",
        "--result-out", resExecEmpty,
      ],
      {
        exit: (code) => { exitExecEmpty = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitExecEmpty, 1);
    const parsedExecEmpty = parseResultJsonlFile(resExecEmpty);
    assert.equal(parsedExecEmpty.status, "aborted");
    assert.equal(parsedExecEmpty.reason, "invalid-bucket");

    // execute with flag without value (last argument)
    const resExecNoVal = join(tmpDir, "res-exec-noval.jsonl");
    let exitExecNoVal = null;
    runHelperCli(
      [
        "execute",
        "--listing", listingFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "true",
        "--result-out", resExecNoVal,
        "--bucket",
      ],
      {
        exit: (code) => { exitExecNoVal = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitExecNoVal, 1);
    const parsedExecNoVal = parseResultJsonlFile(resExecNoVal);
    assert.equal(parsedExecNoVal.status, "aborted");
    assert.equal(parsedExecNoVal.reason, "invalid-bucket");

    // execute with omitted bucket succeeds with default ALLOWED_BUCKET
    const resExecOmitted = join(tmpDir, "res-exec-ok.jsonl");
    let exitExecOmitted = null;
    runHelperCli(
      [
        "execute",
        "--listing", listingFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "true",
        "--result-out", resExecOmitted,
      ],
      {
        exit: (code) => { exitExecOmitted = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitExecOmitted, 0);
    const parsedExecOmitted = parseResultJsonlFile(resExecOmitted);
    assert.equal(parsedExecOmitted.status, "dry-run");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune-helper: listing 파일 형태 엄격 검증 및 listing-invalid 기록 (P2)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "listing-val-test-"));
  try {
    // 1. loadAndValidateListing unit tests
    // 1a. File read failure
    assert.throws(
      () => loadAndValidateListing(join(tmpDir, "nonexistent-file.json")),
      /Failed to read listing file/
    );

    // 1b. JSON parse failure
    const malformedFile = join(tmpDir, "malformed.json");
    writeFileSync(malformedFile, "{ malformed json");
    assert.throws(
      () => loadAndValidateListing(malformedFile),
      /Failed to parse listing JSON/
    );

    // 1c. Not a non-null object
    const nullFile = join(tmpDir, "null.json");
    writeFileSync(nullFile, "null");
    assert.throws(() => loadAndValidateListing(nullFile), /root must be a non-null object/);

    const arrayFile = join(tmpDir, "array.json");
    writeFileSync(arrayFile, JSON.stringify([{ Contents: [] }]));
    assert.throws(() => loadAndValidateListing(arrayFile), /root must be a non-null object/);

    const primitiveFile = join(tmpDir, "primitive.json");
    writeFileSync(primitiveFile, "12345");
    assert.throws(() => loadAndValidateListing(primitiveFile), /root must be a non-null object/);

    // 1d. Contents missing or not an array
    const noContentsFile = join(tmpDir, "no-contents.json");
    writeFileSync(noContentsFile, JSON.stringify({ NotContents: [] }));
    assert.throws(() => loadAndValidateListing(noContentsFile), /'Contents' must be an array/);

    const notArrayContentsFile = join(tmpDir, "not-array-contents.json");
    writeFileSync(notArrayContentsFile, JSON.stringify({ Contents: "string" }));
    assert.throws(() => loadAndValidateListing(notArrayContentsFile), /'Contents' must be an array/);

    const nullContentsFile = join(tmpDir, "null-contents.json");
    writeFileSync(nullContentsFile, JSON.stringify({ Contents: null }));
    assert.throws(() => loadAndValidateListing(nullContentsFile), /'Contents' must be an array/);

    // 1e. Normal empty Contents succeeds
    const emptyContentsFile = join(tmpDir, "empty-contents.json");
    writeFileSync(emptyContentsFile, JSON.stringify({ Contents: [] }));
    assert.deepEqual(loadAndValidateListing(emptyContentsFile), []);

    // 2. plan subcommand failure recording when --result-out is provided
    const invalidFiles = [
      join(tmpDir, "nonexistent.json"),
      malformedFile,
      arrayFile,
      noContentsFile,
    ];

    for (const invFile of invalidFiles) {
      const resPlan = join(tmpDir, `res-plan-${join(invFile).replace(/[^a-zA-Z0-9]/g, "_")}.jsonl`);
      let exitPlan = null;
      runHelperCli(
        [
          "plan",
          "--listing", invFile,
          "--dry-run", "true",
          "--plan-out", join(tmpDir, "plan.json"),
          "--result-out", resPlan,
        ],
        {
          exit: (code) => { exitPlan = code; },
          error: () => {},
          log: () => {},
        }
      );
      assert.equal(exitPlan, 1);
      const parsedPlan = parseResultJsonlFile(resPlan);
      assert.equal(parsedPlan.status, "aborted");
      assert.equal(parsedPlan.reason, "listing-invalid");
      assert.equal(parsedPlan.mode, "dry-run");
    }

    // plan normal empty contents succeeds
    let exitPlanOk = null;
    runHelperCli(
      [
        "plan",
        "--listing", emptyContentsFile,
        "--dry-run", "true",
        "--plan-out", join(tmpDir, "plan-ok.json"),
        "--result-out", join(tmpDir, "res-plan-ok.jsonl"),
      ],
      {
        exit: (code) => { exitPlanOk = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitPlanOk, 0);

    // 3. execute subcommand failure recording with --result-out
    for (const invFile of invalidFiles) {
      const resExec = join(tmpDir, `res-exec-${join(invFile).replace(/[^a-zA-Z0-9]/g, "_")}.jsonl`);
      let exitExec = null;
      runHelperCli(
        [
          "execute",
          "--listing", invFile,
          "--now", "2026-10-05T12:00:00Z",
          "--dry-run", "false",
          "--result-out", resExec,
        ],
        {
          exit: (code) => { exitExec = code; },
          error: () => {},
          log: () => {},
        }
      );
      assert.equal(exitExec, 1);
      const parsedExec = parseResultJsonlFile(resExec);
      assert.equal(parsedExec.status, "aborted");
      assert.equal(parsedExec.reason, "listing-invalid");
      assert.equal(parsedExec.mode, "live");
    }

    // execute normal empty contents succeeds
    let exitExecOk = null;
    const resExecOk = join(tmpDir, "res-exec-ok.jsonl");
    runHelperCli(
      [
        "execute",
        "--listing", emptyContentsFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "true",
        "--result-out", resExecOk,
      ],
      {
        exit: (code) => { exitExecOk = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitExecOk, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("r2-iso-prune-helper: parseResultJsonl 결과 헤더 필수·무효 줄 집계·모드 불변 검증 (P3)", () => {
  // 1. Empty string & whitespace-only string -> missing-result, mode unknown, equal to parseResultJsonlFile(nonexistent)
  const emptyRes = parseResultJsonl("");
  const whitespaceRes = parseResultJsonl("   \n  \t  \n");
  const missingFileRes = parseResultJsonlFile("nonexistent-file.jsonl");
  assert.deepEqual(emptyRes, missingFileRes);
  assert.deepEqual(whitespaceRes, missingFileRes);
  assert.equal(emptyRes.status, "aborted");
  assert.equal(emptyRes.reason, "missing-result");
  assert.equal(emptyRes.mode, "unknown");

  // 2. Missing header on first non-empty line -> invalid-result, mode unknown
  const noHeaderContent = JSON.stringify({ type: "status", status: "completed", reason: "" }) + "\n";
  const noHeaderRes = parseResultJsonl(noHeaderContent);
  assert.equal(noHeaderRes.status, "aborted");
  assert.equal(noHeaderRes.reason, "invalid-result");
  assert.equal(noHeaderRes.mode, "unknown");

  // 3. Invalid mode in header -> invalid-result, mode unknown
  const invalidModeContent = JSON.stringify({ type: "header", mode: "invalid-mode", status: "running" }) + "\n";
  const invalidModeRes = parseResultJsonl(invalidModeContent);
  assert.equal(invalidModeRes.status, "aborted");
  assert.equal(invalidModeRes.reason, "invalid-result");
  assert.equal(invalidModeRes.mode, "unknown");

  // 4. Header appears only on second line -> mode unknown, invalid-result, but valid items preserved!
  const lateHeaderContent = [
    JSON.stringify({ type: "prefix-result", prefix: "builds/nvidia/0.1/", group: "nvidia", result: "deleted", bytes: 1500 }),
    JSON.stringify({ type: "header", mode: "live", status: "running" }),
  ].join("\n");
  const lateHeaderRes = parseResultJsonl(lateHeaderContent);
  assert.equal(lateHeaderRes.mode, "unknown");
  assert.equal(lateHeaderRes.status, "aborted");
  assert.equal(lateHeaderRes.reason, "invalid-result");
  assert.equal(lateHeaderRes.deleted.length, 1);
  assert.equal(lateHeaderRes.deleted[0].prefix, "builds/nvidia/0.1/");
  assert.equal(lateHeaderRes.totalDeletedBytes, 1500);

  // 5. Corrupted line with valid deletions before and after -> keeps both deletions, status aborted / invalid-result
  const middleCorruptContent = [
    JSON.stringify({ type: "header", mode: "live", status: "running" }),
    JSON.stringify({ type: "prefix-result", prefix: "builds/nvidia/0.1/", group: "nvidia", result: "deleted", bytes: 1000 }),
    "{ corrupted json syntax",
    JSON.stringify({ type: "prefix-result", prefix: "builds/nvidia/0.2/", group: "nvidia", result: "deleted", bytes: 2000 }),
  ].join("\n");
  const middleCorruptRes = parseResultJsonl(middleCorruptContent);
  assert.equal(middleCorruptRes.mode, "live");
  assert.equal(middleCorruptRes.status, "aborted");
  assert.equal(middleCorruptRes.reason, "invalid-result");
  assert.equal(middleCorruptRes.deleted.length, 2);
  assert.equal(middleCorruptRes.totalDeletedBytes, 3000);

  // 6. Non-object JSON lines (primitives, null, array) -> treated as invalid lines
  const nonObjectLines = ["12345", "null", '"just-a-string"', JSON.stringify([1, 2, 3])];
  for (const nonObj of nonObjectLines) {
    const content = [
      JSON.stringify({ type: "header", mode: "dry-run", status: "running" }),
      nonObj,
    ].join("\n");
    const res = parseResultJsonl(content);
    assert.equal(res.mode, "dry-run");
    assert.equal(res.status, "aborted");
    assert.equal(res.reason, "invalid-result");
  }

  // 7. Subsequent header lines are ignored (mode remains immutable)
  const multiHeaderContent = [
    JSON.stringify({ type: "header", mode: "dry-run", status: "running" }),
    JSON.stringify({ type: "header", mode: "live", status: "running" }),
    JSON.stringify({ type: "status", status: "completed", reason: "" }),
  ].join("\n");
  const multiHeaderRes = parseResultJsonl(multiHeaderContent);
  assert.equal(multiHeaderRes.mode, "dry-run");
  assert.equal(multiHeaderRes.status, "completed");

  // 8. renderResultMarkdown outputs correct - **Mode:** for unknown, dry-run, live
  const mdUnknown = renderResultMarkdown({ mode: "unknown", status: "aborted", reason: "invalid-result" });
  assert.match(mdUnknown, /- \*\*Mode:\*\* `unknown`/);

  const mdDry = renderResultMarkdown({ mode: "dry-run", status: "dry-run", reason: "" });
  assert.match(mdDry, /- \*\*Mode:\*\* `dry-run`/);

  const mdLive = renderResultMarkdown({ mode: "live", status: "completed", reason: "" });
  assert.match(mdLive, /- \*\*Mode:\*\* `live`/);
});

test("r2-iso-prune-helper: 끝맺음 없는 결과 파일 parseResultJsonl aborted/interrupted 판정 (Q1)", () => {
  // (a) header(running) + 접두사 하나 deleted + status 없음 -> aborted / interrupted, deleted 1개, 바이트 유지
  const contentA = [
    JSON.stringify({ type: "header", mode: "live", status: "running" }),
    JSON.stringify({ type: "prefix-result", prefix: "builds/nvidia/0.1/", group: "nvidia", result: "deleted", bytes: 5000 }),
  ].join("\n");
  const resA = parseResultJsonl(contentA);
  assert.equal(resA.status, "aborted");
  assert.equal(resA.reason, "interrupted");
  assert.equal(resA.mode, "live");
  assert.equal(resA.deleted.length, 1);
  assert.equal(resA.deleted[0].prefix, "builds/nvidia/0.1/");
  assert.equal(resA.deleted[0].bytes, 5000);
  assert.equal(resA.totalDeletedBytes, 5000);
  assert.equal(resA.unknown.length, 0);

  // (b) header(running)만 -> aborted / interrupted
  const contentB = JSON.stringify({ type: "header", mode: "live", status: "running" });
  const resB = parseResultJsonl(contentB);
  assert.equal(resB.status, "aborted");
  assert.equal(resB.reason, "interrupted");
  assert.equal(resB.mode, "live");
  assert.equal(resB.deleted.length, 0);
  assert.equal(resB.totalDeletedBytes, 0);
  assert.equal(resB.unknown.length, 0);

  // (c) header(dry-run mode, running)만 -> aborted / interrupted
  const contentC = JSON.stringify({ type: "header", mode: "dry-run", status: "running" });
  const resC = parseResultJsonl(contentC);
  assert.equal(resC.status, "aborted");
  assert.equal(resC.reason, "interrupted");
  assert.equal(resC.mode, "dry-run");
  assert.equal(resC.deleted.length, 0);
  assert.equal(resC.totalDeletedBytes, 0);
  assert.equal(resC.unknown.length, 0);

  // (d) header + prefix-start 만 -> aborted / 기존 interrupted 문구, unknown 1개
  const contentD = [
    JSON.stringify({ type: "header", mode: "live", status: "running" }),
    JSON.stringify({ type: "prefix-start", prefix: "builds/nvidia/0.1/", group: "nvidia", bytes: 2000 }),
  ].join("\n");
  const resD = parseResultJsonl(contentD);
  assert.equal(resD.status, "aborted");
  assert.equal(resD.reason, "Workflow was interrupted during prefix deletion");
  assert.equal(resD.mode, "live");
  assert.equal(resD.deleted.length, 0);
  assert.equal(resD.unknown.length, 1);
  assert.equal(resD.unknown[0].prefix, "builds/nvidia/0.1/");
  assert.equal(resD.unknown[0].bytes, 2000);
});

test("r2-iso-prune-helper: findMissingValueFlag 단위 검증 및 값 없는 플래그 차단 (Q2)", () => {
  // 1. findMissingValueFlag 단위 시험
  const flags = ["--max-delete", "--now", "--dry-run", "--mode-note"];

  // 마지막 인자 플래그 누락
  assert.equal(findMissingValueFlag(["--max-delete"], flags), "--max-delete");
  assert.equal(findMissingValueFlag(["--dry-run", "true", "--now"], flags), "--now");

  // 바로 뒤 인자가 -- 로 시작
  assert.equal(findMissingValueFlag(["--max-delete", "--dry-run", "false"], flags), "--max-delete");
  assert.equal(findMissingValueFlag(["--now", "--max-delete", "10"], flags), "--now");

  // 빈 문자열 "" 은 값이 있는 것으로 봄
  assert.equal(findMissingValueFlag(["--mode-note", ""], flags), null);
  assert.equal(findMissingValueFlag(["--mode-note", "", "--dry-run", "true"], flags), null);

  // 정상 값 인자
  assert.equal(findMissingValueFlag(["--max-delete", "10", "--dry-run", "false"], flags), null);

  // -- 없는 플래그 이름도 정규화되어 인식
  assert.equal(findMissingValueFlag(["--max-delete"], ["max-delete"]), "--max-delete");

  // 대상 외 플래그(--bucket 등)는 무시
  assert.equal(findMissingValueFlag(["--bucket"], flags), null);
  assert.equal(findMissingValueFlag(["--bucket", "--max-delete", "10"], flags), null);

  // 배열이 아닌 입력
  assert.equal(findMissingValueFlag(null, flags), null);
  assert.equal(findMissingValueFlag([], null), null);

  // 2. CLI 연동 시험
  const tmpDir = mkdtempSync(join(tmpdir(), "missing-flag-test-"));
  try {
    const emptyListingFile = join(tmpDir, "listing.json");
    writeFileSync(emptyListingFile, JSON.stringify({ Contents: [] }));

    // 마지막 인자 --max-delete -> exit 1, plan
    let exitPlanTrailingMax = null;
    runHelperCli(
      [
        "plan",
        "--listing", emptyListingFile,
        "--dry-run", "true",
        "--plan-out", join(tmpDir, "plan-trailing.json"),
        "--max-delete",
      ],
      {
        exit: (code) => { exitPlanTrailingMax = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitPlanTrailingMax, 1);

    // 마지막 인자 --max-delete -> exit 1, execute
    let exitExecTrailingMax = null;
    runHelperCli(
      [
        "execute",
        "--listing", emptyListingFile,
        "--now", "2026-10-05T12:00:00Z",
        "--dry-run", "true",
        "--result-out", join(tmpDir, "res-trailing.jsonl"),
        "--max-delete",
      ],
      {
        exit: (code) => { exitExecTrailingMax = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitExecTrailingMax, 1);

    // --max-delete --dry-run false 순서 -> exit 1 (plan)
    let exitPlanOrder = null;
    runHelperCli(
      [
        "plan",
        "--listing", emptyListingFile,
        "--max-delete",
        "--dry-run", "false",
        "--plan-out", join(tmpDir, "plan-order.json"),
      ],
      {
        exit: (code) => { exitPlanOrder = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitPlanOrder, 1);

    // --max-delete --dry-run false 순서 -> exit 1 (execute)
    let exitExecOrder = null;
    runHelperCli(
      [
        "execute",
        "--listing", emptyListingFile,
        "--max-delete",
        "--dry-run", "false",
        "--now", "2026-10-05T12:00:00Z",
        "--result-out", join(tmpDir, "res-order.jsonl"),
      ],
      {
        exit: (code) => { exitExecOrder = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitExecOrder, 1);

    // 마지막 인자 --now -> exit 1, execute
    let exitExecTrailingNow = null;
    runHelperCli(
      [
        "execute",
        "--listing", emptyListingFile,
        "--dry-run", "true",
        "--result-out", join(tmpDir, "res-now.jsonl"),
        "--now",
      ],
      {
        exit: (code) => { exitExecTrailingNow = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitExecTrailingNow, 1);

    // --mode-note "" -> 통과, plan
    let exitPlanModeNoteEmpty = null;
    runHelperCli(
      [
        "plan",
        "--listing", emptyListingFile,
        "--dry-run", "true",
        "--plan-out", join(tmpDir, "plan-note.json"),
        "--mode-note", "",
      ],
      {
        exit: (code) => { exitPlanModeNoteEmpty = code; },
        error: () => {},
        log: () => {},
      }
    );
    assert.equal(exitPlanModeNoteEmpty, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});



