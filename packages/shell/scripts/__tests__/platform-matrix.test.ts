import { createHash } from "node:crypto";
/**
 * platform-matrix 스키마 + conf 생성 golden (#377 FR-INSTALL.1·2).
 *
 * 경로 근거: src-tauri/** 는 vite.config test.exclude 로 영구 미수집(실측) — 테스트는
 * scripts/__tests__/ 에 둔다. conf 생성은 stage-runtime.mjs 의 순수 함수를 import(재구현 금지).
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// .mjs(JS) 모듈 — 타입 선언 없음. tsconfig include=["src"] 라 tsc 스코프 밖(vitest 만 수집).
import {
	assertBundleArchSupported,
	ensureNodeExecutable,
	extractArchive,
	generateConf,
	prepareRuntime,
	provisionNode,
	selectNodeArchive,
} from "../stage-runtime.mjs";

const SHELL = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (p: string) =>
	JSON.parse(readFileSync(resolve(SHELL, p), "utf8"));

const matrix = readJson("src-tauri/platform-matrix.json");
const baseConf = readJson("src-tauri/tauri.conf.json");

const OSES = ["win32", "linux", "darwin"] as const;
const WIN_VOSK_DLLS = [
	"libvosk.dll",
	"libgcc_s_seh-1.dll",
	"libstdc++-6.dll",
	"libwinpthread-1.dll",
];
const MSVC_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
const AGENT_RESOURCES = [
	"agent/dist",
	"agent/scripts",
	"agent/package.json",
	"agent/node_modules",
];
const BGM_RESOURCES = [
	"bgm-sidecar/dist",
	"bgm-sidecar/package.json",
	"bgm-sidecar/node_modules",
];
// base 에 있으면 dev/cargo check 가 즉사하는 스테이징 산출 경로 접두(R4 — copy_resources 무조건 실행)
const STAGING_PREFIXES = [
	"agent/",
	"bgm-sidecar/",
	"resources/",
	"cascade-loader/",
];

describe("platform-matrix 스키마 (FR-INSTALL.1)", () => {
	it("os 행 = 3 OS 전수, 필수 필드 실존", () => {
		expect(Object.keys(matrix.os).sort()).toEqual([...OSES].sort());
		for (const os of OSES) {
			const row = matrix.os[os];
			expect(Array.isArray(row.targets) && row.targets.length > 0).toBe(true);
			expect(typeof row.nodeBinary).toBe("string");
			expect(row).toHaveProperty("vosk");
			expect(row).toHaveProperty("msvcRedist");
			expect(row).toHaveProperty("installer");
			expect(row).toHaveProperty("artifacts");
			expect(Array.isArray(row.bundleArchs) && row.bundleArchs.length > 0).toBe(
				true,
			);
		}
	});

	it("node: 버전 핀 + 3 OS × x64/arm64 아카이브 맵 + SHA256 형식", () => {
		expect(matrix.node.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(Object.keys(matrix.node.archives).sort()).toEqual([...OSES].sort());
		for (const os of OSES) {
			const archMap = matrix.node.archives[os];
			expect(Object.keys(archMap).sort()).toEqual(["arm64", "x64"]);
			for (const arch of ["x64", "arm64"]) {
				const e = archMap[arch];
				expect(e.ext).toBeTruthy();
				expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
			}
		}
	});

	it("SHA256 6종은 상호 상이 (arch 간 복붙 잠복 차단 — P1-R1)", () => {
		const shas: string[] = [];
		for (const os of OSES) {
			for (const arch of ["x64", "arm64"]) {
				shas.push(matrix.node.archives[os][arch].sha256);
			}
		}
		expect(new Set(shas).size).toBe(shas.length);
	});

	it("staging 정책 = 매트릭스 소유 (agent 필수 · cascade-loader optional — stage-runtime 이 소비)", () => {
		expect(matrix.common.staging).toEqual({
			agent: "required",
			bgmSidecar: "required",
			cascadeLoader: "optional",
		});
	});
	it("전체 번들 지원 arch = win/linux x64, darwin x64+arm64 (Vosk 네이티브 제약을 명시)", () => {
		expect(matrix.os.win32.bundleArchs).toEqual(["x64"]);
		expect(matrix.os.linux.bundleArchs).toEqual(["x64"]);
		expect(matrix.os.darwin.bundleArchs).toEqual(["x64", "arm64"]);
		for (const os of OSES) {
			for (const arch of matrix.os[os].bundleArchs) {
				expect(matrix.node.archives[os]).toHaveProperty(arch);
			}
		}
	});

	it("vosk: win = dll 4종 전부, linux = so 1종, darwin = null", () => {
		expect(matrix.os.win32.vosk.files).toEqual(WIN_VOSK_DLLS);
		expect(matrix.os.linux.vosk.files).toEqual(["libvosk.so"]);
		expect(matrix.os.darwin.vosk).toBeNull();
	});

	it("win 설치자 설정 실존 (삭제된 conf 스냅샷 이주분)", () => {
		const inst = matrix.os.win32.installer;
		expect(inst.publisher).toBe("Nextain Inc.");
		expect(inst.windows.digestAlgorithm).toBe("sha256");
		expect(inst.windows.webviewInstallMode).toEqual({
			type: "offlineInstaller",
		});
		expect(inst.windows.nsis.installMode).toBe("currentUser");
		expect(inst.windows.nsis.languages).toEqual(["Korean", "English"]);
	});

	it("createUpdaterArtifacts=false — 매트릭스 공통이 유일 소유", () => {
		expect(matrix.common.createUpdaterArtifacts).toBe(false);
	});

	it("darwin icon = 전체 배열 (base 5원소 + icns — 부분 델타 금지, RFC 7386 배열 대체)", () => {
		expect(matrix.os.darwin.icon).toEqual([
			...baseConf.bundle.icon,
			"icons/icon.icns",
		]);
		// win/linux 행은 icon 키를 싣지 않아 base 배열이 산다
		expect(matrix.os.win32.icon).toBeUndefined();
		expect(matrix.os.linux.icon).toBeUndefined();
	});

	it("3 OS 행마다 artifacts 실존 + glob 형식 + minBytes = 양수 또는 null", () => {
		for (const os of OSES) {
			const arts = matrix.os[os].artifacts;
			expect(Array.isArray(arts) && arts.length > 0).toBe(true);
			for (const a of arts) {
				expect(typeof a.glob).toBe("string");
				expect(a.glob).toContain("/");
				expect(a.glob).toContain("*"); // 리터럴 파일명 금지 — 버전은 Cargo.toml 유래(글롭 필수)
				expect(
					a.minBytes === null ||
						(typeof a.minBytes === "number" && a.minBytes > 0),
				).toBe(true);
			}
		}
	});

	it("darwin artifacts 는 .app 번들 디렉토리가 아니라 내부 실행 파일을 가리킨다 (R7)", () => {
		const globs = matrix.os.darwin.artifacts.map(
			(a: { glob: string }) => a.glob,
		);
		expect(globs.some((g: string) => g.endsWith(".app"))).toBe(false);
		expect(globs).toContain("macos/*.app/Contents/MacOS/*");
	});
});

describe("전체 번들 arch 명확 차단 + 부작용 의존 주입 (P1-R2)", () => {
	it("win/linux arm64 는 실제 preflight 에서 다운로드 전에 명확 에러, darwin arm64 는 허용", async () => {
		let downloads = 0;
		const fakeProvision = async () => {
			downloads += 1;
		};
		await expect(
			prepareRuntime(matrix, "win32", "arm64", {
				provisionNodeImpl: fakeProvision,
				provisionMsvcImpl: () => {},
			}),
		).rejects.toThrow(/미지원 번들 아키텍처.*win32\/arm64.*x64/);
		await expect(
			prepareRuntime(matrix, "linux", "arm64", {
				provisionNodeImpl: fakeProvision,
				provisionMsvcImpl: () => {},
			}),
		).rejects.toThrow(/미지원 번들 아키텍처.*linux\/arm64.*x64/);
		expect(downloads).toBe(0);
		await prepareRuntime(matrix, "darwin", "arm64", {
			provisionNodeImpl: fakeProvision,
			provisionMsvcImpl: () => {},
		});
		expect(downloads).toBe(1);
	});

	it("provisionNode 는 다운로드 실물 SHA256 불일치를 추출 전에 중단", async () => {
		const resourcesDir = mkdtempSync(resolve(tmpdir(), "naia-node-sha-"));
		let fetches = 0;
		try {
			await expect(
				provisionNode(matrix, "win32", "x64", {
					resourcesDir,
					fetchImpl: async () => {
						fetches += 1;
						return {
							ok: true,
							arrayBuffer: async () =>
								Uint8Array.from([0xde, 0xad, 0xbe, 0xef]).buffer,
						};
					},
				}),
			).rejects.toThrow(/SHA256 불일치.*기대.*실제/s);
			expect(fetches).toBe(1);
		} finally {
			rmSync(resourcesDir, { recursive: true, force: true });
		}
	});

	it("provisionNode cache hit 경로가 Unix 실행권한 복구 helper를 실제 호출", async () => {
		const resourcesDir = mkdtempSync(resolve(tmpdir(), "naia-node-cache-"));
		const archive = selectNodeArchive(matrix, "linux", "x64");
		const node = Buffer.from("cached-node");
		const binarySha = createHash("sha256").update(node).digest("hex");
		const calls: unknown[][] = [];
		try {
			writeFileSync(resolve(resourcesDir, "node"), node);
			writeFileSync(
				resolve(resourcesDir, ".node-runtime"),
				`${archive.version}-${archive.slug}-${archive.sha256}\n${binarySha}\n`,
			);
			await provisionNode(matrix, "linux", "x64", {
				resourcesDir,
				fetchImpl: async () => {
					throw new Error("cache hit must not download");
				},
				ensureExecutableImpl: (...args: unknown[]) => calls.push(args),
			});
			expect(calls).toEqual([[resolve(resourcesDir, "node"), "linux"]]);
		} finally {
			rmSync(resourcesDir, { recursive: true, force: true });
		}
	});

	it.each([
		["stale archive stamp", "stale-stamp", false],
		["cached binary corruption", "current", true],
	])(
		"%s이면 cache를 거부하고 다시 다운로드",
		async (_name, stampKind, corrupt) => {
			const resourcesDir = mkdtempSync(resolve(tmpdir(), "naia-node-stale-"));
			const archive = selectNodeArchive(matrix, "linux", "x64");
			const original = Buffer.from("original-node");
			const cachedSha = createHash("sha256").update(original).digest("hex");
			const currentStamp = `${archive.version}-${archive.slug}-${archive.sha256}`;
			let fetches = 0;
			try {
				writeFileSync(
					resolve(resourcesDir, "node"),
					corrupt ? "corrupted-node" : original,
				);
				writeFileSync(
					resolve(resourcesDir, ".node-runtime"),
					`${stampKind === "current" ? currentStamp : stampKind}\n${cachedSha}\n`,
				);
				await expect(
					provisionNode(matrix, "linux", "x64", {
						resourcesDir,
						fetchImpl: async () => {
							fetches += 1;
							return {
								ok: true,
								arrayBuffer: async () =>
									Uint8Array.from([0xde, 0xad, 0xbe, 0xef]).buffer,
							};
						},
					}),
				).rejects.toThrow(/SHA256 불일치/);
				expect(fetches).toBe(1);
			} finally {
				rmSync(resourcesDir, { recursive: true, force: true });
			}
		},
	);

	it("provisionNode 다운로드 경로가 shell:false 추출 helper를 실제 호출", async () => {
		const resourcesDir = mkdtempSync(resolve(tmpdir(), "naia-node-extract-"));
		const bytes = Buffer.from("archive-fixture");
		const fixtureMatrix = structuredClone(matrix);
		fixtureMatrix.node.archives.win32.x64.sha256 = createHash("sha256")
			.update(bytes)
			.digest("hex");
		const calls: unknown[][] = [];
		try {
			await provisionNode(fixtureMatrix, "win32", "x64", {
				resourcesDir,
				fetchImpl: async () => ({
					ok: true,
					arrayBuffer: async () => bytes,
				}),
				extractArchiveImpl: (
					tarBin: string,
					archivePath: string,
					tmp: string,
				) => {
					calls.push([tarBin, archivePath, tmp]);
					const extracted = resolve(
						tmp,
						`node-v${fixtureMatrix.node.version}-win-x64`,
					);
					mkdirSync(extracted, { recursive: true });
					writeFileSync(resolve(extracted, "node.exe"), "node-binary");
				},
				ensureExecutableImpl: () => {},
			});
			expect(calls).toHaveLength(1);
			expect(calls[0][0]).toMatch(/[\\/]System32[\\/]tar\.exe$/i);
			expect(calls[0][1]).toMatch(/node-v.*-win-x64\.zip$/);
		} finally {
			rmSync(resourcesDir, { recursive: true, force: true });
		}
	});

	it("Unix 캐시 hit 도 0o755 실행권한 복구, Windows 는 chmod 생략", () => {
		const calls: unknown[][] = [];
		const fakeChmod = (...args: unknown[]) => calls.push(args);
		ensureNodeExecutable("/cache/node", "linux", fakeChmod);
		ensureNodeExecutable("C:\\cache\\node.exe", "win32", fakeChmod);
		expect(calls).toEqual([["/cache/node", 0o755]]);
	});

	it("tar 경로는 shell 문자열이 아니라 리터럴 인자 배열로 전달", () => {
		const calls: unknown[][] = [];
		const fakeExec = (...args: unknown[]) => calls.push(args);
		const archive = "C:\\repo\\$(echo pwn)\\node-%PATH%.zip";
		const tmp = "C:\\tmp\\`literal`";
		extractArchive("C:\\Windows\\System32\\tar.exe", archive, tmp, fakeExec);
		expect(calls).toEqual([
			[
				"C:\\Windows\\System32\\tar.exe",
				["-xf", archive, "-C", tmp],
				{ cwd: tmp, stdio: "inherit", shell: false },
			],
		]);
	});
});

describe("selectNodeArchive (FR-INSTALL.1 — arch 오선택 구조 차단)", () => {
	it("win32/x64 해석: 파일명·URL 에 버전 1곳 유래", () => {
		const a = selectNodeArchive(matrix, "win32", "x64");
		expect(a.file).toBe(`node-v${matrix.node.version}-win-x64.zip`);
		expect(a.url).toBe(
			`https://nodejs.org/dist/v${matrix.node.version}/${a.file}`,
		);
		expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("6개 archive slug는 OS/arch 키에서 파생되어 객체 교환으로 오선택할 수 없다", () => {
		const osSlugs = { win32: "win", linux: "linux", darwin: "darwin" };
		for (const os of OSES) {
			for (const arch of ["x64", "arm64"]) {
				const selected = selectNodeArchive(matrix, os, arch);
				expect(selected.slug).toBe(`${osSlugs[os]}-${arch}`);
				expect(selected.file).toContain(`-${osSlugs[os]}-${arch}.`);
			}
		}
	});

	it("미지원 OS/arch = 지원 목록을 나열한 명확한 에러", () => {
		expect(() => selectNodeArchive(matrix, "freebsd", "x64")).toThrow(
			/미지원 OS.*win32/,
		);
		expect(() => selectNodeArchive(matrix, "win32", "ia32")).toThrow(
			/미지원 아키텍처.*x64/,
		);
	});
});

describe("conf 생성 golden (FR-INSTALL.2)", () => {
	it("win32: targets/resources/설치자 설정 기대 형상", () => {
		const conf = generateConf(matrix, "win32", { cascadeLoaderPresent: false });
		expect(conf.bundle.targets).toEqual(["nsis", "msi"]);
		expect(conf.bundle.createUpdaterArtifacts).toBe(false);
		expect(conf.bundle.publisher).toBe("Nextain Inc.");
		expect(conf.bundle.windows.nsis.installMode).toBe("currentUser");
		for (const r of AGENT_RESOURCES) expect(conf.bundle.resources[r]).toBe(r);
		for (const r of BGM_RESOURCES) expect(conf.bundle.resources[r]).toBe(r);
		expect(conf.bundle.resources["resources/node.exe"]).toBe("node.exe");
		for (const f of WIN_VOSK_DLLS)
			expect(conf.bundle.resources[`resources/${f}`]).toBe(f);
		for (const f of MSVC_DLLS)
			expect(conf.bundle.resources[`resources/${f}`]).toBe(f);
		expect(conf.bundle.icon).toBeUndefined();
	});

	it("linux: targets/resources/depends 기대 형상 (base 쪽 depends 채택 — pipewire-alsa 포함)", () => {
		const conf = generateConf(matrix, "linux", { cascadeLoaderPresent: false });
		expect(conf.bundle.targets).toEqual(["deb", "rpm", "appimage"]);
		expect(conf.bundle.createUpdaterArtifacts).toBe(false); // 3 OS 대칭 — win 만 단언하면 변이 잠복(P1-R1)
		expect(conf.bundle.resources["resources/node"]).toBe("node");
		expect(conf.bundle.resources["resources/libvosk.so"]).toBe("libvosk.so");
		expect(conf.bundle.linux.deb.depends).toContain("pipewire-alsa");
		expect(conf.bundle.linux.deb.depends).toContain("libasound2");
		expect(conf.bundle.linux.rpm.depends).toContain("pipewire-alsa");
		expect(conf.bundle.linux.rpm.depends).toContain("alsa-lib");
		expect(conf.bundle.icon).toBeUndefined();
	});

	it("darwin: targets app/dmg + icon = 전체 배열 (배열 대체 시맨틱스 고정) + vosk/msvc 0", () => {
		const conf = generateConf(matrix, "darwin", {
			cascadeLoaderPresent: false,
		});
		expect(conf.bundle.targets).toEqual(["app", "dmg"]);
		expect(conf.bundle.createUpdaterArtifacts).toBe(false);
		expect(conf.bundle.icon).toEqual([
			...baseConf.bundle.icon,
			"icons/icon.icns",
		]);
		expect(conf.bundle.resources["resources/node"]).toBe("node");
		const keys = Object.keys(conf.bundle.resources);
		expect(keys.some((k) => k.includes("vosk"))).toBe(false);
		expect(keys.some((k) => k.includes("vcruntime"))).toBe(false);
	});

	it("cascade-loader 유/무 분기: 있으면 리소스 등재, 없으면 항목 자체 생략", () => {
		for (const os of OSES) {
			const withIt = generateConf(matrix, os, { cascadeLoaderPresent: true });
			const without = generateConf(matrix, os, { cascadeLoaderPresent: false });
			expect(withIt.bundle.resources["cascade-loader/loader"]).toBe(
				"cascade-loader/loader",
			);
			expect(without.bundle.resources["cascade-loader/loader"]).toBeUndefined();
		}
	});

	it("생성물에 build 키 부재 (check-build-contract 스캔 비대상 성립 조건)", () => {
		for (const os of OSES) {
			const conf = generateConf(matrix, os, { cascadeLoaderPresent: true });
			expect(conf).not.toHaveProperty("build");
		}
	});
});

describe("base conf 중립성 (FR-INSTALL.2 ③)", () => {
	it("base 에 createUpdaterArtifacts 부재 (매트릭스가 유일 소유)", () => {
		expect(baseConf.bundle.createUpdaterArtifacts).toBeUndefined();
	});

	it("base 에 targets·linux 블록 부재 (OS 델타 = 매트릭스 소유)", () => {
		expect(baseConf.bundle.targets).toBeUndefined();
		expect(baseConf.bundle.linux).toBeUndefined();
	});

	it("base resources 에 스테이징 산출 경로 0 (R4 — dev/cargo check 즉사 방지)", () => {
		const res = baseConf.bundle.resources ?? {};
		for (const key of Object.keys(res)) {
			expect(STAGING_PREFIXES.some((p) => key.startsWith(p))).toBe(false);
		}
	});

	it("base beforeBuildCommand = pnpm build (스테이징은 stage-runtime 선행 — 이중 실행 방지)", () => {
		expect(baseConf.build.beforeBuildCommand).toBe("pnpm build");
	});
});

describe("vosk 빌드 순서 불변식 (FR-INSTALL.2 — links 키 게이트)", () => {
	it("tauri-plugin-stt Cargo.toml 에 links 키 실존", () => {
		const cargo = readFileSync(
			resolve(SHELL, "src-tauri/plugins/tauri-plugin-stt/Cargo.toml"),
			"utf8",
		);
		expect(cargo).toMatch(/^links\s*=\s*"tauri-plugin-stt"/m);
	});
});
