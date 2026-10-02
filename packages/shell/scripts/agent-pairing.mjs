import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProjectPnpm } from "./package-manager.mjs";
import { validateMemoryCheckout } from "./validate-memory-checkout.mjs";

const shellDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(shellDir, "agent-pairing.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (!/^[0-9a-f]{40}$/.test(manifest.agentCommit)) {
	throw new Error(`Invalid paired Agent commit in ${manifestPath}`);
}
if (!/^[0-9a-f]{64}$/.test(manifest.protoSha256)) {
	throw new Error(`Invalid paired Agent proto SHA256 in ${manifestPath}`);
}
if (!/^[0-9a-f]{40}$/.test(manifest.memoryCommit)) {
	throw new Error(`Invalid paired Memory commit in ${manifestPath}`);
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.memoryVersion)) {
	throw new Error(`Invalid paired Memory version in ${manifestPath}`);
}

export const REQUIRED_AGENT_COMMIT = manifest.agentCommit;
export const REQUIRED_PROTO_SHA256 = manifest.protoSha256;
export const REQUIRED_MEMORY_COMMIT = manifest.memoryCommit;
export const REQUIRED_MEMORY_VERSION = manifest.memoryVersion;
export const PREPARE_PAIRED_AGENT_COMMAND = "pnpm -C packages/shell run agent:prepare";

/** Parse the paths emitted by `git worktree list --porcelain`. */
export function parseGitWorktreePaths(porcelain) {
	if (!porcelain) return [];
	return porcelain
		.split(/\r?\n/)
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim())
		.filter(Boolean);
}

function gitOutput(directory, args) {
	const result = spawnSync("git", ["-C", directory, ...args], {
		encoding: "utf8",
		shell: false,
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

function runGitCommand(directory, args) {
	const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", shell: false });
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * 핀된 커밋을 담은 깨끗한 naia-agent 체크아웃을 찾는다 (#539).
 *
 * 빌드와 실행이 각자 계산하던 것을 한곳으로 모은다. 예전에는 두 규칙이 달라
 * 빌드가 어느 워크트리를 골라 바이너리에 박아 두면 실행은 다른 것을 넘겨,
 * 앱이 자기 짝이 아니라며 거절했다. 같은 답을 써야 그 어긋남이 생기지 않는다.
 *
 * 찾는 곳: `NAIA_E2E_AGENT_ROOT` → 워크트리 모음 디렉터리 → 주 저장소의 git
 * 워크트리 목록. 모음 디렉터리는 저장소 배치마다 다르므로 여러 후보를 본다.
 */
/** 임시 디렉터리로 보이는 경로. 이런 자리의 워크트리는 짝이 아니다. */
const TEMPORARY_PATH = /^(?:\/tmp\/|\/var\/tmp\/|\/private\/var\/folders\/)|[\\/]Temp[\\/]/i;

export function resolvePairedAgent(options = {}) {
	// Callers that already scrubbed their launch environment must pass it here.
	// Reading process.env directly would let a native E2E checkout override an
	// interactive launch after launch-env.mjs removed that variable.
	const sourceEnv = options.env ?? process.env;
	const explicit = options.explicit ?? sourceEnv.NAIA_E2E_AGENT_ROOT;
	const worktreeRoots = options.worktreeRoots ?? [
		sourceEnv.NAIA_AGENT_WORKTREES_DIR,
		resolve(shellDir, "..", "..", "naia-agent-worktrees"),
		resolve(shellDir, "..", "..", "..", "naia-agent-worktrees"),
		resolve(shellDir, "..", "..", "..", "..", "naia-agent-worktrees"),
	].filter(Boolean);
	const primaryRoots = options.primaryRoots ?? [
		resolve(shellDir, "..", "..", "..", "naia-agent"),
		resolve(shellDir, "..", "..", "..", "..", "naia-agent"),
	];

	const candidates = [];
	if (explicit) {
		candidates.push(resolve(explicit));
	} else if (options.candidates !== undefined) {
		// Tests can supply several registered checkout paths while still running
		// the complete resolver validation below. Production callers use the
		// filesystem and git discovery branches that follow.
		candidates.push(...options.candidates.map((candidate) => resolve(candidate)));
	} else {
		for (const root of worktreeRoots) {
			if (!existsSync(root)) continue;
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (entry.isDirectory()) candidates.push(resolve(root, entry.name));
			}
		}
		for (const primary of primaryRoots) {
			if (!existsSync(primary)) continue;
			candidates.push(
				...parseGitWorktreePaths(
					gitOutput(primary, ["worktree", "list", "--porcelain"]),
				),
			);
		}
	}
	const readGitOutput = options.gitOutput ?? gitOutput;
	const hashProto =
		options.hashProto ??
		((path) =>
			createHash("sha256")
				.update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
				.digest("hex"));

	// 임시 디렉터리에 만든 워크트리는 짝이 아니다.
	//
	// 실측에서 드러났다. 진단하려고 `/tmp/.../scratchpad/` 에 만든 워크트리
	// 둘이 에이전트 저장소에 등록돼 있었고, 이 목록이 그것을 골랐다. 빌드에
	// 박힌 경로와 달라 앱이 에이전트를 띄우지 못했고, "뇌가 없어야" 성립하는
	// e2e 단정이 그 덕분에 통과했다 — 사람이 만든 임시 사본 하나가 회귀
	// 전체의 전제를 조용히 바꾼 것이다. 그 통과를 근거로 다른 기계에
	// 잘못된 원인을 짚어 주기까지 했다.
	//
	// 명시적으로 지정한 것(`NAIA_E2E_AGENT_ROOT`)은 사람이 뜻을 밝힌 것이므로
	// 그대로 둔다. 목록에서 우연히 딸려 오는 것만 막는다.
	if (!explicit) {
		const temporary = candidates.filter((path) => TEMPORARY_PATH.test(path));
		if (temporary.length > 0) {
			console.error(
				`[agent-pairing] 임시 경로의 워크트리 ${temporary.length}개를 짝 후보에서 뺀다 — 이런 사본이 골라지면 회귀 전체의 전제가 바뀐다:`,
			);
			for (const path of temporary) console.error(`  ${path}`);
			console.error(
				"  더 이상 쓰지 않는다면 git -C <naia-agent> worktree remove 로 지워라.",
			);
		}
		candidates.splice(
			0,
			candidates.length,
			...candidates.filter((path) => !TEMPORARY_PATH.test(path)),
		);
	}

	// 후보가 여럿이면 어느 것을 골라도 계약상 같지만, **같은 것을 골라야**
	// 한다. 빌드가 고른 것이 바이너리에 박히고 실행이 그것과 대조하기 때문이다.
	// 경로 순으로 정렬해 두 쪽이 같은 답을 얻게 한다.
	for (const pairedAgent of [...new Set(candidates)].sort()) {
		const agentScript = resolve(
			pairedAgent,
			"scripts/builds/agent-stdio-entry.mjs",
		);
		const agentProtoDir = resolve(pairedAgent, "src/main/adapters/grpc");
		const proto = resolve(agentProtoDir, "naia_agent.proto");
		if (!existsSync(agentScript) || !existsSync(proto)) continue;
		if (
			readGitOutput(pairedAgent, ["rev-parse", "HEAD"]) !==
			REQUIRED_AGENT_COMMIT
		)
			continue;
		// 크래시 복구 lease 는 순수 런타임 산출물이라 더러움으로 세지 않는다.
		const porcelain = readGitOutput(pairedAgent, ["status", "--porcelain"]);
		const dirty =
			porcelain == null ||
			porcelain
				.split("\n")
				.filter((line) => line.trim() !== "")
				.some(
					(line) =>
						!/\.agents[\\/]session-contracts[\\/]\.recovery[\\/]/.test(line),
				);
		if (dirty) continue;
		if (hashProto(proto) !== REQUIRED_PROTO_SHA256) continue;
		return { pairedAgent, agentScript, agentProtoDir };
	}
	const where = explicit ? ` under ${explicit}` : ` under ${worktreeRoots.join(", ")}`;
	throw new Error(
		`No clean paired naia-agent checkout contains ${REQUIRED_AGENT_COMMIT}${where}\n  Prepare it with: ${PREPARE_PAIRED_AGENT_COMMAND}`,
	);
}

export function alignPairedMemoryCheckout(memoryDir, options = {}) {
	const readGit = options.gitOutput ?? gitOutput;
	const runGit = options.runGit ?? runGitCommand;
	if (!existsSync(resolve(memoryDir, "package.json"))) {
		throw new Error(`Paired naia-memory checkout missing: ${memoryDir}`);
	}
	const head = readGit(memoryDir, ["rev-parse", "HEAD"]);
	if (head === null) {
		throw new Error(`Paired naia-memory is not a git checkout: ${memoryDir}`);
	}
	if (head === REQUIRED_MEMORY_COMMIT) return { moved: false };
	const porcelain = readGit(memoryDir, ["status", "--porcelain"]);
	if (porcelain !== "") {
		throw new Error(
			`Paired naia-memory checkout has local changes; refusing to move it to ${REQUIRED_MEMORY_COMMIT}: ${memoryDir}\n` +
				`  Commit or stash them, then run: git -C "${memoryDir}" checkout --detach ${REQUIRED_MEMORY_COMMIT}`,
		);
	}
	const branch = readGit(memoryDir, ["symbolic-ref", "-q", "HEAD"]);
	if (typeof branch === "string" && branch.trim() !== "") {
		throw new Error(
			`Paired naia-memory checkout is on branch ${branch}; only a detached checkout is moved automatically: ${memoryDir}\n` +
				`  Run: git -C "${memoryDir}" checkout --detach ${REQUIRED_MEMORY_COMMIT}`,
		);
	}
	if (readGit(memoryDir, ["cat-file", "-e", `${REQUIRED_MEMORY_COMMIT}^{commit}`]) === null) {
		const fetchResult = runGit(memoryDir, ["fetch", "origin", REQUIRED_MEMORY_COMMIT]);
		if (fetchResult.status !== 0) {
			throw new Error(`Cannot fetch naia-memory ${REQUIRED_MEMORY_COMMIT}: ${fetchResult.stderr || fetchResult.stdout}`);
		}
	}
	console.log(`[agent-pairing] naia-memory ${String(head).slice(0, 8)} → ${REQUIRED_MEMORY_COMMIT.slice(0, 8)}: ${memoryDir}`);
	const checkoutResult = runGit(memoryDir, ["checkout", "--detach", REQUIRED_MEMORY_COMMIT]);
	if (checkoutResult.status !== 0) {
		throw new Error(`Failed to move naia-memory to ${REQUIRED_MEMORY_COMMIT}: ${checkoutResult.stderr || checkoutResult.stdout}`);
	}
	return { moved: true };
}

export function memoryDistDigest(packageRoot) {
	const distDir = resolve(packageRoot, "dist", "memory");
	if (!existsSync(distDir) || !statSync(distDir).isDirectory()) return null;

	const entries = [];
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else {
				const relPath = relative(distDir, fullPath).replaceAll("\\", "/");
				entries.push({ relPath, fullPath });
			}
		}
	}
	walk(distDir);

	entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
	const hash = createHash("sha256");
	for (const { relPath, fullPath } of entries) {
		hash.update(relPath);
		hash.update("\0");
		hash.update(readFileSync(fullPath));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function assertNoTrackedChanges(directory, stage, options = {}) {
	const readGit = options.gitOutput ?? gitOutput;
	const porcelain = readGit(directory, ["status", "--porcelain", "--untracked-files=no"]);
	if (porcelain == null) {
		throw new Error(`Cannot read git status of ${directory} (${stage})`);
	}
	const lines = porcelain
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "")
		.filter(
			(line) =>
				!/\.agents[\\/]session-contracts[\\/]\.recovery[\\/]/.test(line),
		);
	if (lines.length > 0) {
		const formatted = lines.map((line) => `  ${line}`).join("\n");
		throw new Error(
			`${stage} modified tracked files in ${directory}; installs must use the committed lockfile:\n${formatted}\n  Changes to pnpm-lock.yaml are typically caused by a different pnpm version.\n  Restore with: git -C "${directory}" checkout -- <file>`,
		);
	}
}

/**
 * 페어링된 naia-agent 체크아웃과 naia-memory 형제를 준비한다 (#685).
 * dev, prod, build가 공유하는 단일 준비 경로다.
 *
 * 불변식:
 * 1. 명시적 루트(NAIA_E2E_AGENT_ROOT, explicit)는 자동 준비하지 않고 strict 검증에 맡긴다.
 * 2. 형제 naia-memory는 깨끗하고 분리된(detached) HEAD일 때만 핀 커밋으로 이동한다.
 * 3. 모든 의존성 설치는 --frozen-lockfile만 쓰며 비-frozen 대체가 없다.
 * 4. 에이전트에 설치된 naia-memory 복사본이 형제 빌드 산출물과 일치하는지 검증한다.
 * 5. 설치/빌드 후 에이전트 및 메모리 체크아웃에 변경된 추적 파일이 없어야 한다.
 * 6. 준비 완료 후 항상 resolvePairedAgent의 엄격한 계약 검증을 거친다.
 */
export function ensurePairedAgentCheckout(options = {}) {
	const sourceEnv = options.env ?? process.env;
	const explicit = options.explicit ?? sourceEnv.NAIA_E2E_AGENT_ROOT;
	if (explicit) {
		return resolvePairedAgent(options);
	}

	let agentRoot = null;
	try {
		agentRoot = resolvePairedAgent(options).pairedAgent;
	} catch {
		/* prepare below */
	}

	if (agentRoot === null) {
		const primaryRoots = options.primaryRoots ?? [
			resolve(shellDir, "..", "..", "..", "naia-agent"),
			resolve(shellDir, "..", "..", "..", "..", "naia-agent"),
		];

		const primary = primaryRoots.find((p) => existsSync(p) && existsSync(resolve(p, ".git")));
		if (!primary) {
			throw new Error(
				`Cannot auto-prepare paired naia-agent: primary repository not found in ${primaryRoots.join(", ")}`,
			);
		}

		const worktreeRoots = options.worktreeRoots ?? [
			sourceEnv.NAIA_AGENT_WORKTREES_DIR,
			resolve(shellDir, "..", "..", "..", "naia-agent-worktrees"),
			resolve(shellDir, "..", "..", "naia-agent-worktrees"),
			resolve(shellDir, "..", "..", "..", "..", "naia-agent-worktrees"),
		].filter(Boolean);

		const worktreeRoot = worktreeRoots.find((r) => existsSync(r)) ?? resolve(primary, "..", "naia-agent-worktrees");
		if (!existsSync(worktreeRoot)) {
			mkdirSync(worktreeRoot, { recursive: true });
		}

		// 인접 의존성(naia-memory, naia-kb-compiler) 링크/정션 확보
		const parentProjectsDir = resolve(primary, "..");
		for (const depName of ["naia-memory", "naia-kb-compiler"]) {
			const targetDep = resolve(parentProjectsDir, depName);
			const linkPath = resolve(worktreeRoot, depName);
			if (existsSync(targetDep) && !existsSync(linkPath)) {
				try {
					symlinkSync(targetDep, linkPath, process.platform === "win32" ? "junction" : "dir");
				} catch {
					// 이미 존재하거나 권한 예외 시 무시
				}
			}
		}

		const shortSha = REQUIRED_AGENT_COMMIT.slice(0, 8);
		const targetWorktree = resolve(worktreeRoot, `paired-${shortSha}`);

		// 2. targetWorktree가 아직 없으면 git worktree add
		if (!existsSync(targetWorktree)) {
			// primary에서 해당 커밋이 있는지 검사하고 없으면 fetch
			const hasCommit = spawnSync("git", ["-C", primary, "rev-parse", "--verify", `${REQUIRED_AGENT_COMMIT}^{commit}`], {
				encoding: "utf8",
				shell: false,
			}).status === 0;

			if (!hasCommit) {
				const fetchResult = spawnSync("git", ["-C", primary, "fetch", "origin", REQUIRED_AGENT_COMMIT], {
					encoding: "utf8",
					shell: false,
				});
				if (fetchResult.status !== 0) {
					spawnSync("git", ["-C", primary, "fetch", "origin"], { encoding: "utf8", shell: false });
				}
			}

			console.log(`[agent-pairing] 전용 페어링 워크트리 자동 생성: ${targetWorktree} (${shortSha})`);
			const addResult = spawnSync(
				"git",
				["-C", primary, "worktree", "add", targetWorktree, REQUIRED_AGENT_COMMIT, "--detach"],
				{ encoding: "utf8", shell: false },
			);
			if (addResult.status !== 0) {
				throw new Error(`Failed to create paired worktree at ${targetWorktree}: ${addResult.stderr || addResult.stdout}`);
			}
		}

		agentRoot = targetWorktree;
	}

	const runPnpm = options.runProjectPnpm ?? runProjectPnpm;

	const memoryLink = resolve(agentRoot, "..", "naia-memory");
	const memoryDir = existsSync(memoryLink) ? realpathSync(memoryLink) : memoryLink;
	const { moved } = alignPairedMemoryCheckout(memoryDir, options);
	const assertMemory = (stage) => {
		const problem = validateMemoryCheckout(memoryDir, REQUIRED_MEMORY_COMMIT, REQUIRED_MEMORY_VERSION, { gitOutput: options.gitOutput });
		if (problem) throw new Error(`Paired naia-memory ${problem} (${stage}): ${memoryDir}`);
	};
	assertMemory("before build");
	if (moved || !existsSync(resolve(memoryDir, "node_modules"))) {
		runPnpm(["--ignore-workspace", "install", "--frozen-lockfile"], memoryDir, sourceEnv);
	}
	// dist is untracked build output; HEAD alone cannot prove it matches, so rebuild each time like the agent build.
	runPnpm(["--ignore-workspace", "run", "build"], memoryDir, sourceEnv);
	assertMemory("after install/build");

	if (!existsSync(resolve(agentRoot, "node_modules"))) {
		runPnpm(["--ignore-workspace", "install", "--frozen-lockfile"], agentRoot, sourceEnv);
	}

	const digest = options.memoryDigest ?? memoryDistDigest;
	const installedMemory = resolve(agentRoot, "node_modules", "@nextain", "naia-memory");
	const installedMatches = () => {
		const expected = digest(memoryDir);
		return expected !== null && digest(installedMemory) === expected;
	};
	if (!installedMatches()) {
		console.log(`[agent-pairing] installed naia-memory differs from ${REQUIRED_MEMORY_COMMIT.slice(0, 8)}; reinstalling: ${agentRoot}`);
		runPnpm(["--ignore-workspace", "install", "--frozen-lockfile", "--force"], agentRoot, sourceEnv);
		if (!installedMatches()) {
			throw new Error(`Installed naia-memory does not match ${memoryDir} (${REQUIRED_MEMORY_COMMIT}) after reinstall: ${installedMemory}`);
		}
	}

	const compositionFile = resolve(agentRoot, "dist/main/composition/index.js");
	if (!existsSync(compositionFile)) {
		console.log(`[agent-pairing] 워크트리 빌드: ${agentRoot}`);
		runPnpm(["run", "build"], agentRoot, sourceEnv);
	}

	assertNoTrackedChanges(agentRoot, "paired naia-agent install", options);
	assertNoTrackedChanges(memoryDir, "paired naia-memory install", options);

	return resolvePairedAgent(options);
}


/**
 * e2e 전용 빌드 산출 자리.
 *
 * 왜 여기에 두는가: 이 계산이 빌드 스크립트 안에만 있어서, 회귀 러너의 전제
 * 검사는 리눅스 자리(`target-e2e`)를 하드코딩하고 있었다. 그래서 Windows 는
 * 빌드에 성공하고도 러너가 "바이너리 없음" 으로 실행을 거부했다 — 그 기계가
 * 회귀 기록을 한 번도 남기지 못한 진짜 원인이다. 자리를 계산하는 곳이 둘이면
 * 반드시 갈라진다.
 *
 * MSVC 의 FileTracker 와 CMake 스크래치는 보통 워크트리 깊이에서도 실패한다.
 * 그래서 Windows 에서만 짧은 자리를 쓰고, 부르는 쪽은 환경 변수로 바꿀 수 있다.
 */
export function e2eTargetDir(shellDir) {
	if (process.env.NAIA_E2E_TARGET_DIR) return resolve(process.env.NAIA_E2E_TARGET_DIR);
	return process.platform === "win32"
		? resolve(`C:/tmp/naia-shell-e2e-${REQUIRED_AGENT_COMMIT.slice(0, 7)}`)
		: resolve(shellDir, "src-tauri", "target-e2e");
}

/** 그 자리의 실행 파일. 확장자는 플랫폼이 정한다. */
export function e2eBinaryPath(shellDir) {
	return resolve(
		e2eTargetDir(shellDir),
		"debug",
		process.platform === "win32" ? "naia-shell.exe" : "naia-shell",
	);
}
