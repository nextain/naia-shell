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
 * vosk 는 프로비저닝·검사 대상 아님 — 생성 주체 = tauri-plugin-stt build.rs(setup_vosk),
 * 순서 보증 = 플러그인 Cargo.toml 의 `links` 키(테스트가 실존 단언).
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
	// stamp 에 아카이브 SHA 포함 — 매트릭스의 SHA 만 교정돼도 재프로비저닝(P1-R1: 무검증 재사용 차단)
	const stamp = `${archive.version}-${archive.slug}-${archive.sha256}`;

	if (existsSync(target) && existsSync(marker)) {
		const [prevStamp, prevBinSha] = readFileSync(marker, "utf8")
			.trim()
			.split("\n");
		// 마커 2행 = 복사된 바이너리 실물 해시 — 실물 훼손/교체도 재프로비저닝으로 자기 치유
		if (
			prevStamp === stamp &&
			prevBinSha &&
			sha256Of(readFileSync(target)) === prevBinSha
		) {
			ensureExecutableImpl(target, platform);
			console.log(
				`[stage-runtime] ① node ${archive.version}-${archive.slug} 이미 프로비저닝됨(실물 해시 일치) — skip`,
			);
			return;
		}
	}

	mkdirSync(resourcesDir, { recursive: true });
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
		writeFileSync(marker, `${stamp}\n${sha256Of(readFileSync(target))}\n`);
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

/**
 * vosk 함정 경고(P1-R1 MAJOR-3): resources/ 를 지웠는데 cargo target/ 이 남으면 build script
 * 캐시 때문에 tauri-plugin-stt 의 setup_vosk 가 재실행되지 않아 vosk dll 이 영구 미재생성될
 * 수 있다. 하드 에러는 명세가 금지(clean checkout 첫 빌드를 깨뜨림) — 경고 + 처방만 낸다.
 */
function warnVoskTrap(matrix, platform) {
	const files = matrix.os[platform]?.vosk?.files ?? [];
	if (!files.length) return;
	const missing = files.filter((f) => !existsSync(resolve(RESOURCES, f)));
	if (missing.length && existsSync(resolve(SRC_TAURI, "target"))) {
		console.warn(
			`[stage-runtime] ⚠ vosk 리소스 누락 + cargo target/ 존재: ${missing.join(", ")}\n  cargo 는 build script 를 캐시하므로 재실행 없이는 이 파일들이 재생성되지 않을 수 있다.\n  빌드가 ResourcePathNotFound 로 실패하면: (cd src-tauri && cargo clean -p tauri-plugin-stt) 후 재실행.`,
		);
	}
}

async function main() {
	const platform = process.platform;
	const arch = process.arch;
	const matrix = readMatrix();

	await prepareRuntime(matrix, platform, arch);

	// ③ 스테이징 — 정책은 매트릭스 staging 필드가 소유(P1-R1: 하드코딩이면 매트릭스가 장식이 됨)
	const stagingUnits = [
		{
			key: "agent",
			script: "scripts/stage-agent.mjs",
			sibling: resolve(SHELL, "../../../naia-agent"),
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

	warnVoskTrap(matrix, platform);

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
