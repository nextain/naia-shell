/**
 * stage-runtime — 크로스플랫폼 설치 빌드의 유일 진입점 (#377 FR-INSTALL.2).
 *
 * OS 분기 = `process.platform`/`process.arch` 로 매트릭스(src-tauri/platform-matrix.json) 행을
 * 선택하는 것뿐 — bash/ps1 분리 금지. 단계:
 *   ① node 런타임 프로비저닝: 다운로드 + SHA256 검증 + OS 기본 `tar` 로 추출(Windows 10 1803+
 *      의 bsdtar 는 zip 도 판독 — Expand-Archive 등 대체 도구 금지) → src-tauri/resources/
 *   ② (win) MSVC 재배포 3종 복사: env VCToolsRedistDir 우선 → vswhere 규약 탐색.
 *      미발견 = 탐색 경로 나열 후 중단(조용한 생략 금지)
 *   ③ 스테이징: stage-agent.mjs(필수) + cascade-loader 는 sibling 실존 확인 후에만
 *      stage-cascade-loader.mjs(부재 = skip + 명시 로그 — optional 판단은 여기 소유)
 *   ④ tauri.conf.generated.json 생성(gitignored, `build` 키 자체 부재 — conf 생성은 순수 함수
 *      generateConf 로 분리, vitest golden 이 네트워크 없이 검증)
 *   ⑤ clean checkout 에서 workspace core 를 먼저 빌드해 셸의 workspace 의존성을 준비
 *   ⑥ `tauri build --config` 직접 spawn(--config 경로를 package.json 커맨드 문자열에 넣지
 *      않는다 — check-build-contract 가 경로 실존을 강제하는데 생성물은 gitignore 라 dangling)
 *
 * Vosk 생성 주체는 tauri-plugin-stt build.rs(setup_vosk)다. 설치 진입점은 기존 생성 파일을
 * 제거하고 플러그인만 cargo clean하여 build.rs의 아카이브 SHA 검증·재추출을 매번 강제한다.
 *
 * cwd 무관(자기 위치 기준). 진입 = `pnpm run tauri:build:bundle` = `node scripts/stage-runtime.mjs`.
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const SHELL = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // packages/shell
const REPO_ROOT = resolve(SHELL, "../..");
const SRC_TAURI = resolve(SHELL, "src-tauri");
const MATRIX_PATH = resolve(SRC_TAURI, "platform-matrix.json");
const RESOURCES = resolve(SRC_TAURI, "resources");
const GENERATED_CONF = resolve(SRC_TAURI, "tauri.conf.generated.json");
// stage-agent.mjs 와 동일 가정: naia-shell 과 형제로 clone
const CASCADE_LOADER_SIBLING = resolve(
	SHELL,
	"../../../naia-omni-windows-manager/loader",
);
const REQUIRED_AGENT_COMMIT = "8bd49f02a725914ae7eefd74dc1a18d033db1f83";
const REQUIRED_PROTO_SHA256 = "b77761930c0991ee825b6d2827adad264fc352a9f220404912a284fc166b691b";
const STATIC_AGENT_CANDIDATES = [
	resolve(REPO_ROOT, "..", "naia-agent"),
	resolve(REPO_ROOT, "..", "..", "naia-agent"),
	resolve(REPO_ROOT, "..", "..", "..", ".agents", "work", "naia-agent-issue-388-proto"),
	resolve(REPO_ROOT, "..", "..", ".agents", "work", "naia-agent-issue-388-proto"),
];
const AGENT_WORKTREE_ROOTS = [
	resolve(REPO_ROOT, "..", "naia-agent-worktrees"),
	resolve(REPO_ROOT, "..", "..", "naia-agent-worktrees"),
];

function gitOutput(dir, args) {
	try {
		return execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function isCleanProto(dir) {
	return gitOutput(dir, ["status", "--porcelain", "--", "src/main/adapters/grpc/naia_agent.proto"]) === "";
}

function isCleanAgentEntrypoint(dir) {
	return gitOutput(dir, ["status", "--porcelain", "--", "scripts/builds/agent-stdio-entry.mjs"]) === "";
}

function isCleanCheckout(dir) {
	return gitOutput(dir, ["status", "--porcelain"]) === "";
}

function sha256File(path) {
	return createHash("sha256")
		.update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
		.digest("hex");
}

function isPairedAgentCheckout(dir) {
	return (
		existsSync(resolve(dir, "scripts/builds/agent-stdio-entry.mjs")) &&
		existsSync(resolve(dir, "src/main/adapters/grpc/naia_agent.proto")) &&
		gitOutput(dir, ["rev-parse", "HEAD"]) === REQUIRED_AGENT_COMMIT &&
		isCleanProto(dir) &&
		isCleanAgentEntrypoint(dir) &&
		isCleanCheckout(dir) &&
		sha256File(resolve(dir, "src/main/adapters/grpc/naia_agent.proto")) ===
			REQUIRED_PROTO_SHA256
	);
}

function agentCandidates() {
	const candidates = [...STATIC_AGENT_CANDIDATES];
	for (const root of AGENT_WORKTREE_ROOTS) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory()) candidates.push(resolve(root, entry.name));
		}
	}
	return [...new Set(candidates)];
}

function firstPairedAgentCheckout() {
	for (const dir of agentCandidates()) {
		if (isPairedAgentCheckout(dir)) return dir;
	}
	return null;
}

function gitRootForPath(path, isFile) {
	const dir = isFile ? dirname(resolve(path)) : resolve(path);
	const root = gitOutput(dir, ["rev-parse", "--show-toplevel"]);
	if (!root) throw new Error(`[stage-runtime] path is not inside a git checkout: ${path}`);
	return root.replaceAll("\\", "/");
}

function validateAgentEnvPair(agentScript, protoDir) {
	if (!existsSync(agentScript)) throw new Error(`[stage-runtime] NAIA_AGENT_SCRIPT not found: ${agentScript}`);
	if (!existsSync(resolve(protoDir, "naia_agent.proto"))) {
		throw new Error(`[stage-runtime] NAIA_AGENT_PROTO_DIR missing naia_agent.proto: ${protoDir}`);
	}
	const scriptRoot = gitRootForPath(agentScript, true);
	const protoRoot = gitRootForPath(protoDir, false);
	if (scriptRoot !== protoRoot) {
		throw new Error(`[stage-runtime] NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must come from the same checkout: ${scriptRoot} !== ${protoRoot}`);
	}
	if (resolve(agentScript).replaceAll("\\", "/") !== resolve(scriptRoot, "scripts/builds/agent-stdio-entry.mjs").replaceAll("\\", "/")) {
		throw new Error(`[stage-runtime] NAIA_AGENT_SCRIPT must be scripts/builds/agent-stdio-entry.mjs from the paired checkout: ${agentScript}`);
	}
	if (resolve(protoDir).replaceAll("\\", "/") !== resolve(scriptRoot, "src/main/adapters/grpc").replaceAll("\\", "/")) {
		throw new Error(`[stage-runtime] NAIA_AGENT_PROTO_DIR must be src/main/adapters/grpc from the paired checkout: ${protoDir}`);
	}
	if (gitOutput(scriptRoot, ["rev-parse", "HEAD"]) !== REQUIRED_AGENT_COMMIT) {
		throw new Error(`[stage-runtime] paired naia-agent checkout must be exactly ${REQUIRED_AGENT_COMMIT}: ${scriptRoot}`);
	}
	if (!isCleanProto(scriptRoot)) {
		throw new Error(`[stage-runtime] paired naia-agent proto must be clean: ${scriptRoot}`);
	}
	if (!isCleanAgentEntrypoint(scriptRoot)) {
		throw new Error(`[stage-runtime] paired naia-agent entrypoint must be clean: ${scriptRoot}`);
	}
	if (!isCleanCheckout(scriptRoot)) {
		throw new Error(`[stage-runtime] paired naia-agent checkout must be clean: ${scriptRoot}`);
	}
	if (sha256File(resolve(protoDir, "naia_agent.proto")) !== REQUIRED_PROTO_SHA256) {
		throw new Error(`[stage-runtime] paired naia-agent proto SHA256 must be ${REQUIRED_PROTO_SHA256}: ${protoDir}`);
	}
}

function applyPairedAgentEnv(env) {
	const explicitScript = env.NAIA_AGENT_SCRIPT;
	const explicitProtoDir = env.NAIA_AGENT_PROTO_DIR;
	if (explicitScript || explicitProtoDir) {
		if (!explicitScript || !explicitProtoDir) {
			throw new Error(
				"[stage-runtime] NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must be provided together",
			);
		}
		validateAgentEnvPair(explicitScript, explicitProtoDir);
		return gitRootForPath(explicitScript, true);
	}

	const pairedAgent = firstPairedAgentCheckout();
	if (!pairedAgent) {
		throw new Error(
			`[stage-runtime] no paired naia-agent checkout contains ${REQUIRED_AGENT_COMMIT} with agent-stdio-entry.mjs and naia_agent.proto`,
		);
	}
	env.NAIA_AGENT_SCRIPT =
		env.NAIA_AGENT_SCRIPT ?? resolve(pairedAgent, "scripts/builds/agent-stdio-entry.mjs");
	env.NAIA_AGENT_PROTO_DIR =
		env.NAIA_AGENT_PROTO_DIR ?? resolve(pairedAgent, "src/main/adapters/grpc");
	validateAgentEnvPair(env.NAIA_AGENT_SCRIPT, env.NAIA_AGENT_PROTO_DIR);
	return pairedAgent;
}

/* ───────────────────────── 순수 함수 (vitest 대상 — 부작용 0) ───────────────────────── */

/** 매트릭스에서 현재 OS/arch 의 node 아카이브 항목을 해석. 미지원 = 지원 목록을 나열한 명확한 에러. */
export function selectNodeArchive(matrix, platform, arch) {
	const osMap = matrix.node.archives[platform];
	if (!osMap) {
		throw new Error(
			`[stage-runtime] 미지원 OS: ${platform} (지원: ${Object.keys(matrix.node.archives).join(", ")})`,
		);
	}
	const entry = osMap[arch];
	if (!entry) {
		throw new Error(
			`[stage-runtime] 미지원 아키텍처: ${platform}/${arch} (지원: ${Object.keys(osMap).join(", ")})`,
		);
	}
	const osSlug = { win32: "win", linux: "linux", darwin: "darwin" }[platform];
	const slug = `${osSlug}-${arch}`;
	const version = matrix.node.version;
	const file = matrix.node.fileTemplate
		.replaceAll("{version}", version)
		.replaceAll("{slug}", slug)
		.replaceAll("{ext}", entry.ext);
	const url = matrix.node.urlTemplate
		.replaceAll("{version}", version)
		.replaceAll("{file}", file);
	return {
		version,
		slug,
		ext: entry.ext,
		file,
		url,
		sha256: entry.sha256,
	};
}

/** 전체 번들 지원 arch 계약. Node 아카이브가 있어도 네이티브 의존성이 미지원이면 다운로드 전에 중단. */
export function assertBundleArchSupported(matrix, platform, arch) {
	const row = matrix.os[platform];
	if (!row) {
		throw new Error(
			`[stage-runtime] 매트릭스에 없는 OS: ${platform} (지원: ${Object.keys(matrix.os).join(", ")})`,
		);
	}
	const supported = row.bundleArchs;
	if (!Array.isArray(supported) || supported.length === 0) {
		throw new Error(
			`[stage-runtime] 매트릭스 bundleArchs 계약 누락: ${platform}`,
		);
	}
	if (!supported.includes(arch)) {
		throw new Error(
			`[stage-runtime] 미지원 번들 아키텍처: ${platform}/${arch} (지원: ${supported.join(", ")}) — Node 아카이브와 전체 네이티브 번들 지원은 별개`,
		);
	}
}

/** Unix 캐시 복원에서도 실행권한을 복구한다. 의존 주입은 부정 테스트용. */
export function ensureNodeExecutable(target, platform, chmod = chmodSync) {
	if (platform !== "win32") chmod(target, 0o755);
}

/** 경로를 shell 문자열로 보간하지 않고 tar 인자 배열로 전달한다. 의존 주입은 부정 테스트용. */
export function extractArchive(
	tarBin,
	archivePath,
	tmp,
	execFile = execFileSync,
) {
	execFile(tarBin, ["-xf", archivePath, "-C", tmp], {
		cwd: tmp,
		stdio: "inherit",
		shell: false,
	});
}

/**
 * 매트릭스 행 → tauri.conf.generated.json 오버레이 생성 (base 위 JSON Merge Patch 계열 딥머지 전제:
 * 객체=병합, 배열 포함 비객체=통째 대체. ⚠ 순정 RFC 7386 과 달리 tauri CLI 의 머지는 null-보존
 * 변형(merge_patches)이라 null 로 base 키를 지울 수 없다 — 오버레이에서 "null 로 삭제" 금지.
 * tauri-build 쪽 재머지는 순정 json_patch::merge 라 두 소비자의 null 시맨틱이 다르다 — P1-R1 실소스).
 * `build` 키 부재 = check-build-contract 스캔 비대상의 성립 조건 — 절대 추가 금지.
 * darwin icon 은 최종 배열 전체(머지가 배열을 통째 대체하므로 부분 델타 불가).
 */
export function generateConf(
	matrix,
	platform,
	{ cascadeLoaderPresent = false } = {},
) {
	const row = matrix.os[platform];
	if (!row) {
		throw new Error(
			`[stage-runtime] 매트릭스에 없는 OS: ${platform} (지원: ${Object.keys(matrix.os).join(", ")})`,
		);
	}
	const resources = { ...matrix.common.resources };
	resources[`resources/${row.nodeBinary}`] = row.nodeBinary;
	for (const f of row.vosk?.files ?? []) resources[`resources/${f}`] = f;
	for (const f of row.msvcRedist?.files ?? []) resources[`resources/${f}`] = f;
	if (cascadeLoaderPresent)
		Object.assign(resources, matrix.common.cascadeLoaderResources);

	const { $comment: _omit, ...installer } = row.installer ?? {};
	const bundle = {
		createUpdaterArtifacts: matrix.common.createUpdaterArtifacts,
		targets: [...row.targets],
		resources,
		...installer,
	};
	if (row.icon) bundle.icon = [...row.icon];
	return { bundle };
}

/* ───────────────────────── 부작용 단계 ───────────────────────── */

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

function sha256Of(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

/**
 * linuxdeploy는 AppDir/usr/lib 아래의 모든 ELF를 공유 라이브러리 후보로 재귀 스캔한다.
 * Claude Agent SDK의 정적 Bun 실행 파일은 정상 실행 가능하지만 `ldd`가 1을 반환해 AppImage
 * 조립을 중단시킨다. 매트릭스가 지정한 파일만 gzip payload로 바꾸고, 번들 Node를 사용하는
 * POSIX 래퍼가 최초 호출 시 사용자 캐시에 원자적으로 복원한다.
 */
export function wrapStaticExecutableForBundle(
	srcTauriDir,
	relativePath,
	dependencies = {},
) {
	const read = dependencies.read ?? readFileSync;
	const write = dependencies.write ?? writeFileSync;
	const chmod = dependencies.chmod ?? chmodSync;
	const target = resolve(srcTauriDir, relativePath);
	if (!existsSync(target)) {
		throw new Error(
			`[stage-runtime] 정적 실행 파일 래핑 대상 누락: ${relativePath}`,
		);
	}
	const original = read(target);
	const digest = sha256Of(original);
	const payload = `${target}.payload.gz`;
	write(payload, gzipSync(original), { mode: 0o644 });
	chmod(payload, 0o644);
	const wrapper = `#!/bin/sh
set -eu
umask 077
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NODE="$SCRIPT_DIR/../../../../node"
PAYLOAD="$0.payload.gz"
CACHE_BASE="\${XDG_CACHE_HOME:-\${HOME:?HOME is required}/.cache}"
CACHE_DIR="$CACHE_BASE/naia/embedded-cli"
TARGET="$CACHE_DIR/claude-${digest}"
ACTUAL=""
if [ -x "$TARGET" ]; then
  ACTUAL="$("$NODE" -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$TARGET" 2>/dev/null || true)"
fi
if [ "$ACTUAL" != "${digest}" ]; then
  mkdir -p "$CACHE_DIR"
  TMP="$TARGET.$$"
  trap 'rm -f "$TMP"' EXIT HUP INT TERM
  "$NODE" -e 'const fs=require("node:fs"),z=require("node:zlib");fs.writeFileSync(process.argv[2],z.gunzipSync(fs.readFileSync(process.argv[1])),{mode:0o700})' "$PAYLOAD" "$TMP"
  TEMP_ACTUAL="$("$NODE" -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$TMP")"
  if [ "$TEMP_ACTUAL" != "${digest}" ]; then
    echo "naia: embedded Claude payload checksum mismatch" >&2
    exit 1
  fi
  mv -f "$TMP" "$TARGET"
  trap - EXIT HUP INT TERM
fi
exec "$TARGET" "$@"
`;
	write(target, wrapper, { mode: 0o755 });
	chmod(target, 0o755);
	return { target, payload, digest };
}

/** node 런타임 다운로드 + SHA256 검증 + OS 기본 tar 추출 → resources/<nodeBinary>. (export = 실측 프로브·부정 테스트용) */
export async function provisionNode(matrix, platform, arch, dependencies = {}) {
	const resourcesDir = dependencies.resourcesDir ?? RESOURCES;
	const fetchImpl = dependencies.fetchImpl ?? fetch;
	const ensureExecutableImpl =
		dependencies.ensureExecutableImpl ?? ensureNodeExecutable;
	const extractArchiveImpl = dependencies.extractArchiveImpl ?? extractArchive;
	const archive = selectNodeArchive(matrix, platform, arch);
	const row = matrix.os[platform];
	const target = resolve(resourcesDir, row.nodeBinary);
	const marker = resolve(resourcesDir, ".node-runtime");

	mkdirSync(resourcesDir, { recursive: true });
	// 캐시 옆 마커는 독립된 신뢰 근거가 아니므로 재사용하지 않는다. 설치자 빌드마다
	// 매트릭스에 고정된 아카이브 SHA를 다시 검증하고 그 아카이브에서 재추출한다.
	rmSync(marker, { force: true });
	const tmp = resolve(resourcesDir, ".tmp-node");
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	try {
		console.log(`[stage-runtime] ① node 다운로드: ${archive.url}`);
		const res = await fetchImpl(archive.url);
		if (!res.ok) {
			throw new Error(
				`[stage-runtime] node 다운로드 실패: HTTP ${res.status} — ${archive.url}`,
			);
		}
		const buf = Buffer.from(await res.arrayBuffer());
		const actual = sha256Of(buf);
		if (actual !== archive.sha256) {
			throw new Error(
				`[stage-runtime] SHA256 불일치: ${archive.file}\n  기대 ${archive.sha256}\n  실제 ${actual}`,
			);
		}
		const archivePath = resolve(tmp, archive.file);
		writeFileSync(archivePath, buf);

		// 3 OS 모두 OS 기본 tar 로 추출(win bsdtar 는 zip 판독). 대체 도구 금지.
		// win 은 System32 절대경로 필수 — PATH 의 tar 는 Git for Windows GNU tar 일 수 있고
		// (GitHub 러너 포함), GNU tar 는 `C:` 드라이브 문자를 원격 호스트로 오인해 실패(실측).
		const tarBin =
			platform === "win32"
				? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
				: "tar";
		extractArchiveImpl(tarBin, archivePath, tmp);

		const extracted = resolve(tmp, `node-v${archive.version}-${archive.slug}`);
		const binInArchive =
			platform === "win32"
				? resolve(extracted, "node.exe")
				: resolve(extracted, "bin", "node");
		if (!existsSync(binInArchive)) {
			throw new Error(
				`[stage-runtime] 추출 결과에 node 바이너리 없음: ${binInArchive}`,
			);
		}
		copyFileSync(binInArchive, target);
		ensureExecutableImpl(target, platform);
		console.log(
			`[stage-runtime] ① node ${archive.version}-${archive.slug} → ${target}`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Architecture gate plus the first provisioning side effects used by main.
 * Dependencies are injectable so tests prove unsupported targets stop before
 * any download or MSVC lookup begins.
 */
export async function prepareRuntime(
	matrix,
	platform,
	arch,
	{
		provisionNodeImpl = provisionNode,
		provisionMsvcImpl = provisionMsvcRedist,
	} = {},
) {
	assertBundleArchSupported(matrix, platform, arch);
	await provisionNodeImpl(matrix, platform, arch);
	provisionMsvcImpl(matrix, platform, arch);
}

/** MSVC 재배포 dll 원본 디렉토리 탐색(win 전용). 반환 = 발견 디렉토리, 실패 = 탐색 경로 나열 에러. (export = 실측 프로브용) */
export function findMsvcRedistDir(files, arch) {
	const archDir = arch === "arm64" ? "arm64" : "x64";
	const searched = [];
	const candidates = [];

	// 1순위: env VCToolsRedistDir (VS 개발자 프롬프트가 설정 — 사용 중 툴셋과 짝이 맞는 디렉토리)
	const envDir = process.env.VCToolsRedistDir;
	if (envDir) candidates.push(join(envDir, archDir));

	// 2순위: vswhere → <VS>/VC/Redist/MSVC/<ver>/<arch>. 컴포넌트는 arch 에 맞춰 질의(P1-R1).
	const vswhere = join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio",
		"Installer",
		"vswhere.exe",
	);
	const vcComponent =
		arch === "arm64"
			? "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
			: "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";
	if (existsSync(vswhere)) {
		try {
			const vsRoot = execSync(
				`"${vswhere}" -latest -products * -requires ${vcComponent} -property installationPath`,
				{ encoding: "utf8" },
			).trim();
			if (vsRoot) {
				const redistRoot = join(vsRoot, "VC", "Redist", "MSVC");
				if (existsSync(redistRoot)) {
					// 버전 내림차순 = 최신 우선(P1-R1 실증: 사전순 첫 채택이 구버전 14.38 을 골라
					// 최신 툴셋(14.44) 링크 산출물과 어긋남 — redist 는 빌드 툴셋 이상 버전이어야 함).
					const versions = readdirSync(redistRoot)
						.filter((v) => /^\d+\./.test(v))
						.sort((a, b) => {
							const pa = a.split(".").map(Number);
							const pb = b.split(".").map(Number);
							for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
								const d = (pb[i] ?? 0) - (pa[i] ?? 0);
								if (d !== 0) return d;
							}
							return 0;
						});
					for (const ver of versions)
						candidates.push(join(redistRoot, ver, archDir));
				} else {
					searched.push(redistRoot);
				}
			}
		} catch {
			searched.push(`${vswhere} (실행 실패)`);
		}
	} else {
		searched.push(vswhere);
	}

	// 각 후보 아래 Microsoft.VC*.CRT 에 3종 전부 있는 디렉토리 채택
	for (const cand of candidates) {
		searched.push(cand);
		if (!existsSync(cand)) continue;
		for (const crt of readdirSync(cand)) {
			if (!/^Microsoft\.VC\d+\.CRT$/i.test(crt)) continue;
			const dir = join(cand, crt);
			searched.push(dir);
			if (files.every((f) => existsSync(join(dir, f)))) return dir;
		}
	}
	const searchedList = searched.map((s) => `  - ${s}`).join("\n");
	throw new Error(
		`[stage-runtime] MSVC 재배포(${files.join(", ")}) 미발견 — 탐색한 경로:\n${searchedList}\n  → VS C++ 빌드 도구 설치 또는 env VCToolsRedistDir 설정 필요`,
	);
}

/** (win) MSVC 재배포 3종 → resources/ 복사. 미발견 = 중단(조용한 생략 금지). (export = 실측 프로브용) */
export function provisionMsvcRedist(matrix, platform, arch) {
	const spec = matrix.os[platform]?.msvcRedist;
	if (!spec) return;
	const dir = findMsvcRedistDir(spec.files, arch);
	mkdirSync(RESOURCES, { recursive: true });
	for (const f of spec.files) copyFileSync(join(dir, f), resolve(RESOURCES, f));
	console.log(`[stage-runtime] ② MSVC 재배포 ${spec.files.length}종 ← ${dir}`);
}

function readMatrix() {
	try {
		return JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
	} catch (e) {
		throw new Error(
			`[stage-runtime] 매트릭스 읽기 실패: ${MATRIX_PATH} — ${e.message}`,
		);
	}
}

/** 증분 빌드에서도 기존 추출물을 신뢰하지 않도록 Vosk build script 재실행을 강제한다. */
export function invalidateVoskBuildCache(
	matrix,
	platform,
	{
		resourcesDir = RESOURCES,
		shellDir = SHELL,
		runImpl = run,
	} = {},
) {
	const files = matrix.os[platform]?.vosk?.files ?? [];
	if (!files.length) return;
	for (const file of files) {
		rmSync(resolve(resourcesDir, file), { force: true });
	}
	console.log(
		`[stage-runtime] ③ Vosk ${files.length}개 생성 파일 제거 + 플러그인 build script 강제 재실행`,
	);
	runImpl(
		"cargo clean --manifest-path src-tauri/Cargo.toml -p tauri-plugin-stt",
		shellDir,
	);
	runImpl(
		"cargo build --manifest-path src-tauri/Cargo.toml -p tauri-plugin-stt --release",
		shellDir,
	);
	let missing = files.filter((file) => !existsSync(resolve(resourcesDir, file)));
	if (missing.length) {
		const releaseDir = resolve(shellDir, "src-tauri", "target", "release");
		for (const file of missing) {
			const source = resolve(releaseDir, file);
			if (existsSync(source)) copyFileSync(source, resolve(resourcesDir, file));
		}
		missing = files.filter((file) => !existsSync(resolve(resourcesDir, file)));
	}
	if (missing.length) {
		throw new Error(
			`[stage-runtime] Vosk runtime resources missing after tauri-plugin-stt rebuild: ${missing.join(", ")}`,
		);
	}
}

async function main() {
	const platform = process.platform;
	const arch = process.arch;
	const matrix = readMatrix();
	const pairedAgentRoot = applyPairedAgentEnv(process.env);

	await prepareRuntime(matrix, platform, arch);

	// ③ 스테이징 — 정책은 매트릭스 staging 필드가 소유(P1-R1: 하드코딩이면 매트릭스가 장식이 됨)
	const stagingUnits = [
		{
			key: "agent",
			script: "scripts/stage-agent.mjs",
			sibling: pairedAgentRoot,
		},
		{
			key: "bgmSidecar",
			script: "scripts/stage-bgm-sidecar.mjs",
			sibling: resolve(SHELL, "../bgm-sidecar"),
		},
		{
			key: "cascadeLoader",
			script: "scripts/stage-cascade-loader.mjs",
			sibling: CASCADE_LOADER_SIBLING,
		},
	];
	let cascadeLoaderPresent = false;
	for (const unit of stagingUnits) {
		const policy = matrix.common.staging?.[unit.key];
		if (policy !== "required" && policy !== "optional") {
			throw new Error(
				`[stage-runtime] 매트릭스 staging.${unit.key} 정책 불명: ${JSON.stringify(policy)} (required|optional 만 허용)`,
			);
		}
		if (policy === "optional" && !existsSync(unit.sibling)) {
			console.log(
				`[stage-runtime] ③ ${unit.key} skip — sibling 없음: ${unit.sibling} (optional — 해당 리소스는 생성 conf 에서 생략)`,
			);
			continue;
		}
		console.log(`[stage-runtime] ③ ${unit.key} 스테이징 (${policy})`);
		run(`node ${unit.script}`, SHELL); // required + sibling 부재 = 스크립트 자신의 명확한 에러로 중단
		if (unit.key === "cascadeLoader") cascadeLoaderPresent = true;
	}

	for (const relativePath of matrix.os[platform].wrappedStaticExecutables) {
		console.log(`[stage-runtime] ③ 정적 실행 파일 래핑: ${relativePath}`);
		wrapStaticExecutableForBundle(SRC_TAURI, relativePath);
	}

	invalidateVoskBuildCache(matrix, platform);

	const conf = generateConf(matrix, platform, { cascadeLoaderPresent });
	writeFileSync(GENERATED_CONF, `${JSON.stringify(conf, null, "\t")}\n`);
	console.log(`[stage-runtime] ④ conf 생성 → ${GENERATED_CONF}`);

	console.log("[stage-runtime] ⑤ core build");
	run("pnpm build", REPO_ROOT);

	console.log("[stage-runtime] ⑥ tauri build");
	// AppImage의 linuxdeploy가 번들 안의 Node 및 다중 아키텍처 네이티브 모듈까지
	// strip하려 들면 제3자 런타임이 변형되거나 외부 아키텍처 ELF에서 실패한다.
	// 설치 계약은 검증된 런타임 원본을 동봉하는 것이므로 모든 플랫폼에서 보존한다
	// (NO_STRIP을 소비하는 도구는 linuxdeploy뿐이다).
	process.env.NO_STRIP = "1";
	// 이전 로컬 빌드의 stale 포맷이 같은 glob으로 업로드되는 것을 구조적으로 차단한다.
	rmSync(resolve(SHELL, "src-tauri", "target", "release", "bundle"), {
		recursive: true,
		force: true,
	});
	run(
		"pnpm exec tauri build --verbose --config src-tauri/tauri.conf.generated.json",
		SHELL,
	);
}

// vitest 가 순수 함수만 import 할 수 있도록 main 은 직접 실행 시에만.
// realpath 로 심링크 경유 호출도 일치(불일치 시 main 미실행 + exit 0 = 조용한 성공 위장 — P1-R1).
function safeRealpath(p) {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}
const invoked = process.argv[1]
	? pathToFileURL(safeRealpath(resolve(process.argv[1]))).href
	: "";
if (invoked === import.meta.url) {
	main().catch((e) => {
		console.error(e?.message ?? e);
		if (e?.cause) console.error("  cause:", e.cause); // fetch 등 래핑 에러의 실원인 보존(P1-R1)
		process.exit(1);
	});
}
