#!/usr/bin/env node
/**
 * ego-lite 벤더 트리 동기화·검사 도구 (#582 S1).
 *
 *   node scripts/sync-ego-lite.mjs --check
 *     네트워크 없이 vendor/ego-lite 가 UPSTREAM.md 의 고정 커밋과 바이트 단위로
 *     같은지 MANIFEST.sha256 으로 대조한다. 판정은 종료 코드다(0=같음).
 *
 *   node scripts/sync-ego-lite.mjs --ref <commit>
 *     업스트림을 얕게 받아 허용 목록만 vendor 로 복사하고, MANIFEST.sha256 과
 *     UPSTREAM.md 의 커밋·날짜를 갱신한 뒤 git diff --stat 을 출력한다.
 *     파생 스킬(skill/SKILL.md)이 있으면 이전판·신판·파생본 3자 diff 를 출력한다.
 *
 * 벤더 파일은 어떤 경우에도 이 스크립트 밖에서 편집하지 않는다.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SCRIPT_DIR, "..");
const VENDOR_DIR = join(PKG_ROOT, "vendor", "ego-lite");
const MANIFEST_PATH = join(VENDOR_DIR, "MANIFEST.sha256");
const UPSTREAM_DOC = join(VENDOR_DIR, "UPSTREAM.md");
const DERIVED_SKILL = join(PKG_ROOT, "skill", "SKILL.md");

export const UPSTREAM_URL = "https://github.com/citrolabs/ego-lite";

/** 업스트림 저장소 루트 기준 복사 허용 목록. 이 밖의 경로는 벤더에 존재하면 실패다. */
export const ALLOWLIST = [
  "package/ego-browser",
  "skills/ego-browser",
  "spec/agent-skills-spec.md",
  "LICENSE",
  "AGENTS.md",
  // 벤더 런타임의 단위 테스트 test/skill-publish-workflow.test.js:6-12 가 이 파일의
  // 존재와 내용을 검사한다. 없으면 벤더 npm test 가 299 중 1 건 실패한다.
  // 계획 문서 6절의 허용 목록에 빠져 있던 항목이다(#582 S1 에서 정정).
  ".github/workflows/publish-ego-browser-skill.yml",
];

/** 업스트림이 무시하는 빌드 산출물. 벤더 안에 생겨도 추적하지 않는다. */
export const IGNORED_VENDOR_PATHS = [
  "package/ego-browser/dist",
  "package/ego-browser/node_modules",
  "package/ego-browser/artifacts",
  "package/ego-browser/.build.lock",
  "package/ego-browser/bin",
  "package/ego-browser/ego-browser.js",
];

/** 벤더 안에 있지만 업스트림 산출물이 아닌 우리 파일. MANIFEST 대상이 아니다. */
const OUR_VENDOR_FILES = new Set(["MANIFEST.sha256", "UPSTREAM.md"]);

const UPSTREAM_SKILL_REL = "skills/ego-browser/SKILL.md";

function toPosix(p) {
  return p.split(sep).join("/");
}

function isIgnored(relPath) {
  return IGNORED_VENDOR_PATHS.some(
    (prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`),
  );
}

function isAllowed(relPath) {
  return ALLOWLIST.some(
    (prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`),
  );
}

/** 벤더 트리에서 추적 대상 파일 경로(POSIX, vendor 기준 상대)를 정렬해 돌려준다. */
export function listVendorFiles(root = VENDOR_DIR) {
  const out = [];
  const walk = (absDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const abs = join(absDir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (isIgnored(rel)) continue;
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        if (OUR_VENDOR_FILES.has(rel)) continue;
        out.push(rel);
      }
    }
  };
  if (!existsSync(root)) return out;
  walk(root);
  return out.sort();
}

export function sha256File(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/** UPSTREAM.md 에서 고정 커밋·커밋 날짜를 읽는다. */
export function readPinnedCommit(docPath = UPSTREAM_DOC) {
  if (!existsSync(docPath)) {
    throw new Error(`UPSTREAM.md 가 없다: ${docPath}`);
  }
  const text = readFileSync(docPath, "utf8");
  const commit = /^-\s*고정 커밋:\s*`([0-9a-f]{40})`\s*$/m.exec(text);
  if (!commit) {
    throw new Error("UPSTREAM.md 에서 `- 고정 커밋: \\`<40자리 해시>\\`` 줄을 찾지 못했다");
  }
  const date = /^-\s*커밋 날짜:\s*`([0-9]{4}-[0-9]{2}-[0-9]{2})`\s*$/m.exec(text);
  return { commit: commit[1], commitDate: date ? date[1] : null };
}

/** MANIFEST.sha256 을 파싱한다. `# ego-lite <commit> <date>` 헤더 + `<sha>  <path>` 줄. */
export function readManifest(manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) {
    throw new Error(`MANIFEST.sha256 이 없다: ${manifestPath}`);
  }
  const lines = readFileSync(manifestPath, "utf8").split("\n");
  const entries = new Map();
  let commit = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("#")) {
      const header = /^#\s*ego-lite\s+([0-9a-f]{40})\b/.exec(line);
      if (header) commit = header[1];
      continue;
    }
    const match = /^([0-9a-f]{64})\s\s(.+)$/.exec(line);
    if (!match) {
      throw new Error(`MANIFEST.sha256 형식 오류: ${JSON.stringify(line)}`);
    }
    entries.set(match[2], match[1]);
  }
  return { commit, entries };
}

function renderManifest(commit, commitDate, files, root) {
  const header = [
    `# ego-lite ${commit} ${commitDate ?? "unknown"}`,
    `# ${UPSTREAM_URL}`,
    "# packages/ego-host/scripts/sync-ego-lite.mjs 가 생성한다. 손으로 고치지 않는다.",
  ];
  const rows = files.map((rel) => `${sha256File(join(root, rel))}  ${rel}`);
  return `${[...header, ...rows].join("\n")}\n`;
}

// ---------------------------------------------------------------- --check

export function runCheck({ log = console.log, err = console.error } = {}) {
  let pinned;
  let manifest;
  try {
    pinned = readPinnedCommit();
    manifest = readManifest();
  } catch (error) {
    err(`[sync-ego-lite] ${error.message}`);
    return 1;
  }

  const problems = [];
  if (manifest.commit && manifest.commit !== pinned.commit) {
    problems.push(
      `MANIFEST 헤더 커밋(${manifest.commit}) 과 UPSTREAM.md 고정 커밋(${pinned.commit}) 이 다르다`,
    );
  }

  const present = listVendorFiles();
  const presentSet = new Set(present);

  for (const rel of present) {
    if (!isAllowed(rel)) {
      problems.push(`허용 목록 밖 파일이 벤더에 있다: ${rel}`);
      continue;
    }
    const expected = manifest.entries.get(rel);
    if (expected === undefined) {
      problems.push(`MANIFEST 에 없는 파일이 벤더에 있다: ${rel}`);
      continue;
    }
    const actual = sha256File(join(VENDOR_DIR, rel));
    if (actual !== expected) {
      problems.push(`내용이 다르다(벤더 파일 수정 금지): ${rel}`);
    }
  }
  for (const rel of manifest.entries.keys()) {
    if (!presentSet.has(rel)) {
      problems.push(`MANIFEST 에 있으나 벤더에 없는 파일: ${rel}`);
    }
  }

  if (problems.length > 0) {
    err(`[sync-ego-lite] --check 실패 (${problems.length}건), 고정 커밋 ${pinned.commit}`);
    for (const problem of problems) err(`  - ${problem}`);
    err("  복구: node scripts/sync-ego-lite.mjs --ref <commit> 로 다시 받는다");
    return 1;
  }
  log(
    `[sync-ego-lite] --check 통과: ${present.length}개 파일이 ${pinned.commit} 와 바이트 단위로 같다`,
  );
  return 0;
}

// ------------------------------------------------------------------ --ref

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function gitOrThrow(args, options = {}) {
  const result = git(args, options);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} 실패 (exit ${result.status})\n${result.stderr || ""}`,
    );
  }
  return result.stdout;
}

function fetchUpstream(ref, destDir, source, { blobs = false } = {}) {
  mkdirSync(destDir, { recursive: true });
  const origin = source || UPSTREAM_URL;
  gitOrThrow(["init", "-q", destDir]);
  gitOrThrow(["-C", destDir, "remote", "add", "origin", origin]);
  gitOrThrow([
    "-C",
    destDir,
    "fetch",
    "--depth",
    "1",
    // 출처 게이트는 바이트를 직접 비교하므로 blob 을 실제로 받아야 한다.
    ...(blobs ? [] : ["--filter=blob:none"]),
    "origin",
    ref,
  ]);
  const commit = gitOrThrow(["-C", destDir, "rev-parse", "FETCH_HEAD"]).trim();
  const commitDate = gitOrThrow([
    "-C",
    destDir,
    "show",
    "-s",
    "--format=%cs",
    "FETCH_HEAD",
  ]).trim();
  return { commit, commitDate };
}

function extractAllowlist(repoDir, commit, targetDir) {
  const tarPath = join(repoDir, "allowlist.tar");
  const archive = spawnSync(
    "git",
    ["-C", repoDir, "archive", "--format=tar", "-o", tarPath, commit, "--", ...ALLOWLIST],
    { encoding: "utf8" },
  );
  if (archive.status !== 0) {
    throw new Error(`git archive 실패: ${archive.stderr || archive.status}`);
  }
  mkdirSync(targetDir, { recursive: true });
  const untar = spawnSync("tar", ["-xf", tarPath, "-C", targetDir], {
    encoding: "utf8",
  });
  if (untar.status !== 0) {
    throw new Error(`tar -x 실패: ${untar.stderr || untar.status}`);
  }
}

function updateUpstreamDoc(commit, commitDate, syncDate, fileCount) {
  // `\s*$` 를 쓰면 \s 가 줄바꿈을 삼켜 뒤따르는 빈 줄이 사라진다. 반드시 [ \t]*$ 다.
  let text = readFileSync(UPSTREAM_DOC, "utf8");
  text = text.replace(
    /^-[ \t]*고정 커밋:[ \t]*`[0-9a-f]{40}`[ \t]*$/m,
    `- 고정 커밋: \`${commit}\``,
  );
  text = text.replace(
    /^-[ \t]*커밋 날짜:[ \t]*`[0-9-]{10}`[ \t]*$/m,
    `- 커밋 날짜: \`${commitDate}\``,
  );
  text = text.replace(
    /^-[ \t]*마지막 동기화:[ \t]*`[0-9-]{10}`.*$/m,
    `- 마지막 동기화: \`${syncDate}\` — 실행자 Opus (이슈 #582 S1)`,
  );
  text = text.replace(
    /^-[ \t]*벤더 파일 수:[ \t]*`\d+`[ \t]*$/m,
    `- 벤더 파일 수: \`${fileCount}\``,
  );
  writeFileSync(UPSTREAM_DOC, text);
}

/**
 * 파생 스킬이 있으면 3자 diff 를 출력한다.
 *  (1) 업스트림 이전판 -> 신판   (2) 업스트림 신판 -> 파생본
 * 파생본이 없으면 그 사실을 출력하고 건너뛴다.
 */
function printSkillThreeWayDiff(previousSkillText, nextSkillPath, log) {
  if (!existsSync(DERIVED_SKILL)) {
    log(
      "[sync-ego-lite] 파생 스킬 skill/SKILL.md 가 없어 3자 diff 를 건너뛴다 (S4 에서 생성한다)",
    );
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), "ego-skill-diff-"));
  try {
    const prevPath = join(scratch, "upstream-previous.md");
    writeFileSync(prevPath, previousSkillText ?? "");
    log("");
    log("[sync-ego-lite] 스킬 3자 diff (1/2) 업스트림 이전판 -> 신판:");
    log(
      git(["diff", "--no-index", "--", prevPath, nextSkillPath]).stdout ||
        "  (차이 없음)",
    );
    log("[sync-ego-lite] 스킬 3자 diff (2/2) 업스트림 신판 -> 우리 파생본:");
    log(
      git(["diff", "--no-index", "--", nextSkillPath, DERIVED_SKILL]).stdout ||
        "  (차이 없음)",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function runSync(ref, { log = console.log, source = null } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "ego-lite-sync-"));
  const repoDir = join(scratch, "repo");
  const stageDir = join(scratch, "stage");
  const previousSkillPath = join(VENDOR_DIR, UPSTREAM_SKILL_REL);
  const previousSkillText = existsSync(previousSkillPath)
    ? readFileSync(previousSkillPath, "utf8")
    : null;
  try {
    log(`[sync-ego-lite] ${source || UPSTREAM_URL} 에서 ${ref} 를 얕게 받는다`);
    const { commit, commitDate } = fetchUpstream(ref, repoDir, source);
    log(`[sync-ego-lite] 커밋 ${commit} (${commitDate})`);
    extractAllowlist(repoDir, commit, stageDir);

    const staged = listVendorFiles(stageDir);
    const outside = staged.filter((rel) => !isAllowed(rel));
    if (outside.length > 0) {
      throw new Error(
        `업스트림 아카이브에 허용 목록 밖 경로가 있다: ${outside.join(", ")}`,
      );
    }
    if (staged.length === 0) {
      throw new Error("허용 목록에서 복사할 파일이 하나도 없다");
    }

    // 허용 목록 경로만 통째로 교체한다. UPSTREAM.md·MANIFEST.sha256 은 남긴다.
    for (const prefix of ALLOWLIST) {
      rmSync(join(VENDOR_DIR, prefix), { recursive: true, force: true });
    }
    mkdirSync(VENDOR_DIR, { recursive: true });
    for (const prefix of ALLOWLIST) {
      const from = join(stageDir, prefix);
      if (!existsSync(from)) continue;
      const to = join(VENDOR_DIR, prefix);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, {
        recursive: statSync(from).isDirectory(),
      });
    }

    const files = listVendorFiles();
    const stray = files.filter((rel) => !isAllowed(rel));
    if (stray.length > 0) {
      throw new Error(
        `동기화 뒤 허용 목록 밖 파일이 벤더에 남아 있다: ${stray.join(", ")}`,
      );
    }
    writeFileSync(MANIFEST_PATH, renderManifest(commit, commitDate, files, VENDOR_DIR));
    const syncDate = new Date().toISOString().slice(0, 10);
    updateUpstreamDoc(commit, commitDate, syncDate, files.length);
    log(`[sync-ego-lite] 벤더 파일 ${files.length}개, MANIFEST.sha256 갱신`);

    printSkillThreeWayDiff(
      previousSkillText,
      join(stageDir, UPSTREAM_SKILL_REL),
      log,
    );

    log("");
    log("[sync-ego-lite] git diff --stat:");
    const stat = git(["-C", PKG_ROOT, "diff", "--stat", "--", "."]);
    log(stat.stdout.trim() || "  (추적 중인 파일에 변경 없음)");
    const untracked = git([
      "-C",
      PKG_ROOT,
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "vendor",
    ]).stdout.trim();
    if (untracked) {
      log(
        `  (아직 git 에 추가되지 않은 벤더 파일 ${untracked.split("\n").length}개는 diff 에 안 잡힌다)`,
      );
    }
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}


// ----------------------------------------------------------- --provenance

/**
 * 트리 항목 열거. `--check` 의 `listVendorFiles` 와 달리 **심링크와 모드까지** 본다.
 * 매니페스트는 sha256 만 보므로 심링크가 같은 내용의 실파일로 바뀌어도 통과한다 —
 * 출처 게이트는 그 자리를 메운다.
 */
export function listTreeEntries(root) {
  const out = [];
  const walk = (absDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const abs = join(absDir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (isIgnored(rel)) continue;
      if (OUR_VENDOR_FILES.has(rel)) continue;
      if (entry.isSymbolicLink()) {
        out.push({ rel, type: "symlink", target: toPosix(readlinkSync(abs)) });
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile()) {
        const stat = lstatSync(abs);
        out.push({
          rel,
          type: "file",
          executable: (stat.mode & 0o111) !== 0,
          size: stat.size,
        });
      }
    }
  };
  if (!existsSync(root)) return out;
  walk(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/** 두 트리를 형식·모드·심링크·바이트·누락·추가까지 비교한다. */
export function compareTrees(vendorRoot, upstreamRoot) {
  const vendor = new Map(listTreeEntries(vendorRoot).map((e) => [e.rel, e]));
  const upstream = new Map(listTreeEntries(upstreamRoot).map((e) => [e.rel, e]));
  const problems = [];

  for (const [rel, want] of upstream) {
    const got = vendor.get(rel);
    if (!got) {
      problems.push(`업스트림에 있으나 벤더에 없다: ${rel}`);
      continue;
    }
    if (got.type !== want.type) {
      problems.push(`형식이 다르다(${want.type} -> ${got.type}): ${rel}`);
      continue;
    }
    if (want.type === "symlink") {
      if (got.target !== want.target) {
        problems.push(`심링크 대상이 다르다(${want.target} -> ${got.target}): ${rel}`);
      }
      continue;
    }
    if (got.executable !== want.executable) {
      problems.push(
        `실행 비트가 다르다(${want.executable ? "x" : "-"} -> ${got.executable ? "x" : "-"}): ${rel}`,
      );
    }
    if (got.size !== want.size) {
      problems.push(`크기가 다르다(${want.size} -> ${got.size}바이트): ${rel}`);
      continue;
    }
    if (!readFileSync(join(vendorRoot, rel)).equals(readFileSync(join(upstreamRoot, rel)))) {
      problems.push(`바이트가 다르다: ${rel}`);
    }
  }
  for (const rel of vendor.keys()) {
    if (!upstream.has(rel)) problems.push(`업스트림에 없는 파일이 벤더에 있다: ${rel}`);
  }
  return problems;
}

/**
 * 출처 게이트. `--check` 는 매니페스트와 대조할 뿐이라 매니페스트·벤더·UPSTREAM.md 를 함께
 * 바꾸면 속는다. 여기서는 UPSTREAM.md 의 **고정 커밋 트리를 실체화해** 직접 비교한다.
 *
 * 네트워크가 없으면 `--source <로컬 클론 경로>` 로 실체화한다. 판정은 종료 코드다.
 */
export function runProvenance({ source = null, log = console.log, err = console.error } = {}) {
  let pinned;
  try {
    pinned = readPinnedCommit();
  } catch (error) {
    err(`[sync-ego-lite] ${error.message}`);
    return 1;
  }
  const scratch = mkdtempSync(join(tmpdir(), "ego-lite-prov-"));
  const repoDir = join(scratch, "repo");
  const treeDir = join(scratch, "tree");
  try {
    log(
      `[sync-ego-lite] --provenance: ${source || UPSTREAM_URL} 에서 고정 커밋 ${pinned.commit} 를 실체화한다`,
    );
    const { commit } = fetchUpstream(pinned.commit, repoDir, source, { blobs: true });
    if (commit !== pinned.commit) {
      err(
        `[sync-ego-lite] --provenance 실패: 받은 커밋(${commit})이 UPSTREAM.md 고정 커밋(${pinned.commit})과 다르다`,
      );
      return 1;
    }
    extractAllowlist(repoDir, commit, treeDir);
    const problems = compareTrees(VENDOR_DIR, treeDir);
    if (problems.length > 0) {
      err(`[sync-ego-lite] --provenance 실패 (${problems.length}건), 고정 커밋 ${pinned.commit}`);
      for (const problem of problems) err(`  - ${problem}`);
      err("  이 게이트는 매니페스트를 보지 않는다 — 벤더 트리가 고정 커밋 그 자체여야 한다");
      return 1;
    }
    const count = listTreeEntries(VENDOR_DIR).length;
    log(
      `[sync-ego-lite] --provenance 통과: ${count}개 항목이 ${pinned.commit} 와 형식·모드·심링크·바이트까지 같다`,
    );
    return 0;
  } catch (error) {
    err(`[sync-ego-lite] --provenance 실패: ${error.message}`);
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- CLI

function sourceArg(argv) {
  const at = argv.indexOf("--source");
  return at >= 0 ? argv[at + 1] ?? null : null;
}

export function main(argv) {
  if (argv.includes("--check")) {
    return runCheck();
  }
  if (argv.includes("--provenance")) {
    return runProvenance({ source: sourceArg(argv) });
  }
  const refIndex = argv.indexOf("--ref");
  if (refIndex >= 0) {
    const ref = argv[refIndex + 1];
    if (!ref) {
      console.error("[sync-ego-lite] --ref 뒤에 커밋을 적는다");
      return 2;
    }
    const source = sourceArg(argv);
    try {
      return runSync(ref, { source });
    } catch (error) {
      console.error(`[sync-ego-lite] 동기화 실패: ${error.message}`);
      return 1;
    }
  }
  console.error(
    "사용법:\n" +
      "  node scripts/sync-ego-lite.mjs --check\n" +
      "  node scripts/sync-ego-lite.mjs --provenance [--source <git-url-or-path>]\n" +
      "  node scripts/sync-ego-lite.mjs --ref <commit> [--source <git-url-or-path>]",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
