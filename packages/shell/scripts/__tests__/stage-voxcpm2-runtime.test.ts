import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	packageVoxCpm2Runtime,
} from "../package-voxcpm2-runtime.mjs";
import {
	DEFAULT_VOXCPM2_TRT_DOWNLOAD_URL,
	readVoxCpm2ActivationContract,
	stageVoxCpm2Runtime,
	voxCpm2Profile,
	verifyVoxCpm2ArchiveActivationContract,
	voxCpm2ArtifactActivationFailures,
	voxCpm2PayloadFileActivationFailures,
} from "../stage-voxcpm2-runtime.mjs";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function hash(path: string) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture() {
	const root = mkdtempSync(resolve(tmpdir(), "naia-voxcpm2-stage-"));
	roots.push(root);
	const shellDir = resolve(root, "shell");
	const runtimeSource = resolve(root, "runtime");
	for (const path of [
		resolve(shellDir, "src-tauri"),
		resolve(shellDir, "src-tauri/windows"),
		resolve(shellDir, "src/lib"),
		resolve(shellDir, "src/components"),
		resolve(runtimeSource, "python/Lib/site-packages/voxcpm2_tensorrt"),
		resolve(runtimeSource, "python/Lib/site-packages/onnx/backend/test/data"),
		resolve(runtimeSource, "python/Lib/site-packages/scipy/io/tests/data"),
		resolve(runtimeSource, "voices"),
		resolve(runtimeSource, "licenses"),
	])
		mkdirSync(path, { recursive: true });
	writeFileSync(
		resolve(shellDir, "src-tauri/windows/prepare-voxcpm2-model.ps1"),
		"shell orchestration",
	);
	writeFileSync(
		resolve(shellDir, "src-tauri/voxcpm2-activation-contract.json"),
		readFileSync(
			resolve(process.cwd(), "src-tauri/voxcpm2-activation-contract.json"),
		),
	);
	writeFileSync(
		resolve(shellDir, "src/lib/config.ts"),
		'export const DEFAULT_VOICE_REF_URL = "https://stnaiapub83b29893.blob.core.windows.net/ref-audio/cc0/cc0-ko-female-01.wav";',
	);
	// The synthesis default is checked wherever `resolveTtsVoiceId` is defined,
	// not in a named file — the function has already moved once (ChatArea →
	// chat-voice-utils) and a pure refactor must not fail release staging.
	writeFileSync(
		resolve(shellDir, "src/components/chat-voice-utils.ts"),
		'export function resolveTtsVoiceId() { return "cc0-ko-female-01.wav"; }',
	);
	writeFileSync(
		resolve(shellDir, "src/components/ChatArea.tsx"),
		'import { resolveTtsVoiceId } from "./chat-voice-utils";',
	);
	const runtimeManifest = resolve(runtimeSource, "runtime-manifest.json");
	writeFileSync(
		runtimeManifest,
		JSON.stringify({ schemaVersion: 3, profile: "windows_trt_6g" }),
	);
	const packageLock = resolve(runtimeSource, "runtime-package-lock.json");
	writeFileSync(
		packageLock,
		JSON.stringify({ schemaVersion: 1, python: "3.10.20", packages: {} }),
	);
	const installerPackageLock = resolve(
		runtimeSource,
		"installer-package-lock.json",
	);
	writeFileSync(
		installerPackageLock,
		JSON.stringify({
			schemaVersion: 1,
			python: "3.10.20",
			packages: { "tensorrt-cu12": "10.3.0" },
			policy: "automatic-installer-only",
		}),
	);
	writeFileSync(resolve(runtimeSource, "python/python.exe"), "python");
	writeFileSync(
		resolve(
			runtimeSource,
			"python/Lib/site-packages/onnx/backend/test/data/model.onnx",
		),
		"third-party conformance fixture",
	);
	writeFileSync(
		resolve(
			runtimeSource,
			"python/Lib/site-packages/scipy/io/tests/data/test.wav",
		),
		"third-party audio fixture",
	);
	writeFileSync(
		resolve(
			runtimeSource,
			"python/Lib/site-packages/voxcpm2_tensorrt/http_server.cp310-win_amd64.pyd",
		),
		"compiled runtime",
	);
	writeFileSync(
		resolve(runtimeSource, "sbom.spdx.json"),
		'{"spdxVersion":"SPDX-2.3"}',
	);
	writeFileSync(resolve(runtimeSource, "THIRD_PARTY_NOTICES.md"), "notices");
	writeFileSync(
		resolve(runtimeSource, "licenses/Apache-2.0.txt"),
		"Apache-2.0",
	);
	const paths = [
		"runtime-manifest.json",
		"runtime-package-lock.json",
		"installer-package-lock.json",
		"sbom.spdx.json",
		"THIRD_PARTY_NOTICES.md",
		"licenses/Apache-2.0.txt",
		"python/python.exe",
		"python/Lib/site-packages/onnx/backend/test/data/model.onnx",
		"python/Lib/site-packages/scipy/io/tests/data/test.wav",
		"python/Lib/site-packages/voxcpm2_tensorrt/http_server.cp310-win_amd64.pyd",
	];
	const manifest = {
		schemaVersion: 1,
		profile: "windows_trt_6g",
		runtimeManifestSha256: hash(runtimeManifest),
		packageLockSha256: hash(packageLock),
		installerPackageLockSha256: hash(installerPackageLock),
		source: {
			repository: "https://github.com/nextain/voxcpm2-tensorrt",
			commit: "a".repeat(40),
		},
		files: paths.map((path) => ({
			path,
			size: readFileSync(resolve(runtimeSource, path)).length,
			sha256: hash(resolve(runtimeSource, path)),
		})),
		voice: null,
	};
	const manifestPath = resolve(runtimeSource, "artifact-manifest.json");
	writeFileSync(manifestPath, JSON.stringify(manifest));
	const runtimeArchive = resolve(root, "voxcpm2-runtime.zip");
	const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
	packageVoxCpm2Runtime({
		runtimeSource,
		expectedManifestSha256: hash(manifestPath),
		output: runtimeArchive,
		tar,
	});
	return {
		shellDir,
		runtimeSource,
		expectedManifestSha256: hash(manifestPath),
		runtimeArchive,
		runtimeUrl: "https://downloads.nextain.io/voxcpm2/windows_trt_6g/test.zip",
		tar,
		verifyRemoteDownload: () => {},
	};
}

describe("stageVoxCpm2Runtime", () => {
	it("pins the production download URL and verifies its remote byte contract", () => {
		expect(DEFAULT_VOXCPM2_TRT_DOWNLOAD_URL).toBe(
			"https://stnaiapub83b29893.blob.core.windows.net/releases/windows_trt_6g/releases/0.2.2/voxcpm2-runtime-win-trt6g-r2.zip",
		);
		const source = fixture();
		const calls: Array<[string, number]> = [];
		stageVoxCpm2Runtime({
			...source,
			verifyRemoteDownload: (url: string, bytes: number) =>
				calls.push([url, bytes]),
		});
		expect(calls).toEqual([
			[source.runtimeUrl, readFileSync(source.runtimeArchive).length],
		]);
	});

	it("fails release staging when the public download probe fails", () => {
		expect(() =>
			stageVoxCpm2Runtime({
				...fixture(),
				verifyRemoteDownload: () => {
					throw new Error("HEAD returned HTTP 401");
				},
			}),
		).toThrow(/HTTP 401/);
	});

	it("allows an unpublished download only for an explicit local unsigned build", () => {
		const source = fixture();
		let probes = 0;
		stageVoxCpm2Runtime({
			...source,
			allowUnpublishedDownload: true,
			verifyRemoteDownload: () => {
				probes += 1;
			},
		});
		expect(probes).toBe(0);
	});
	it("pins, verifies, and atomically installs every approved Shell reference voice", () => {
		const installer = readFileSync(
			resolve(process.cwd(), "src-tauri/windows/prepare-voxcpm2-model.ps1"),
			"utf8",
		);
		expect(installer).toContain("Test-ReferenceVoice");
		expect(installer).toContain("Invoke-WebRequest");
		expect(installer).toContain("Get-FileHash");
		expect(installer).toContain("$ReferenceVoices");
		expect(installer).toContain("foreach ($Voice in $ReferenceVoices)");
		expect(installer).toContain("$VoicePending");
		expect(installer).toContain("referenceVoices = @(");
		const devLauncher = readFileSync(
			resolve(process.cwd(), "scripts/tauri-with-mode.mjs"),
			"utf8",
		);
		expect(devLauncher).toContain(
			'resolve(SHELL, "src-tauri/voxcpm2-activation-contract.json")',
		);
		expect(devLauncher).toContain(
			'resolve(devVoxCpm2Bundle, "voxcpm2-activation-contract.json")',
		);
		expect(devLauncher).toContain(
			"env.NAIA_VOXCPM2_DOWNLOAD_MANIFEST ?? devVoxCpm2DownloadManifest",
		);
		expect(devLauncher).toContain("NAIA_VOXCPM2_DOWNLOAD_MANIFEST");
		const devManifest = JSON.parse(
			readFileSync(
				resolve(process.cwd(), "scripts/voxcpm2-download-manifest.json"),
				"utf8",
			),
		);
		expect(devManifest.profile).toBe("windows_trt_6g");
		expect(devManifest.archive.url).toContain("/releases/0.2.2/");
	});

	it("stages the dev/e2e installer resources into the cargo debug resource_dir (#508)", () => {
		const devLauncher = readFileSync(
			resolve(process.cwd(), "scripts/tauri-with-mode.mjs"),
			"utf8",
		);
		expect(devLauncher).toContain("devTargetDebugVoxCpm2Bundle");
		// 스테이징이 일어나는지를 보되 스크립트 이름은 등록부에 맡긴다 — 이름을
		// 여기 적어 두었더니 리눅스가 PowerShell 스크립트를 받았다 (#537).
		expect(devLauncher).toContain(
			"resolve(devTargetDebugVoxCpm2Bundle, hostVoxCpm2Profile.modelPrepName)",
		);
		expect(devLauncher).toContain(
			'resolve(devTargetDebugVoxCpm2Bundle, "voxcpm2-activation-contract.json")',
		);
		expect(devLauncher).toContain(
			'resolve(devTargetDebugVoxCpm2Bundle, "download-manifest.json")',
		);
		const e2eBuilder = readFileSync(
			resolve(process.cwd(), "scripts/build-e2e-tauri.mjs"),
			"utf8",
		);
		// The staged installer follows the host operating system, the same axis
		// voice_runtime::layout uses. Naming one script here staged PowerShell
		// beside a Linux binary and made install report "not packaged" (#537).
		expect(e2eBuilder).toContain("voxCpm2Profile()");
		expect(e2eBuilder).toContain(
			"resolve(e2eVoxCpm2Bundle, e2eInstaller.modelPrepName)",
		);
		expect(e2eBuilder).toContain(
			'resolve(e2eVoxCpm2Bundle, "voxcpm2-activation-contract.json")',
		);
		expect(e2eBuilder).toContain(
			'resolve(e2eVoxCpm2Bundle, "download-manifest.json")',
		);
	});

	it("audits every runtime activation prerequisite before release staging", () => {
		const source = fixture();
		expect(voxCpm2ArtifactActivationFailures(source.runtimeSource)).toEqual([]);

		rmSync(
			resolve(
				source.runtimeSource,
				"python/Lib/site-packages/voxcpm2_tensorrt/http_server.cp310-win_amd64.pyd",
			),
			{ force: true },
		);
		writeFileSync(
			resolve(
				source.runtimeSource,
				"python/Lib/site-packages/voxcpm2_tensorrt/unrelated.cp310-win_amd64.pyd",
			),
			"compiled but not the server entry point",
		);
		expect(voxCpm2ArtifactActivationFailures(source.runtimeSource)).toEqual([
			"missing compiled module: python/Lib/site-packages/voxcpm2_tensorrt/http_server.*.pyd",
		]);
		expect(readVoxCpm2ActivationContract().payload.requiredDirectories).toEqual([
			"artifact/voices",
		]);
		const referenceVoices =
			readVoxCpm2ActivationContract().runtime.referenceVoices;
		expect(referenceVoices.map((voice) => voice.id)).toEqual([
			"cc0-ko-female-01.wav",
			"cc0-ko-female-02.wav",
			"cc0-ko-female-03.wav",
			"cc0-ko-male-01.wav",
			"cc0-ko-male-02.wav",
			"cc0-ko-male-03.wav",
			"cc0-ko-male-04.wav",
			"cc0-ko-male-05.wav",
		]);
		expect(referenceVoices.filter((voice) => voice.default)).toEqual([
			expect.objectContaining({
				id: "cc0-ko-female-01.wav",
				sha256:
					"b90fd1a86ff8fb74c2e165894c6728d07f16cb69c501f00302d8e25c53805c09",
				bytes: 193550,
			}),
		]);
	});

	it("audits the completed ZIP64 archive before it can become a release input", () => {
		const source = fixture();
		const output = resolve(source.runtimeSource, "..", "release-runtime.zip");
		const tar =
			process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
		const packaged = packageVoxCpm2Runtime({
			runtimeSource: source.runtimeSource,
			expectedManifestSha256: source.expectedManifestSha256,
			output,
			tar,
		});
		expect(packaged.path).toBe(output);
		expect(
			verifyVoxCpm2ArchiveActivationContract({ archive: output, tar }),
		).toMatchObject({ files: 11 });
	});

	it("rejects a selected ZIP produced from a different artifact manifest", () => {
		const selected = fixture();
		const stale = fixture();
		const staleManifestPath = resolve(
			stale.runtimeSource,
			"artifact-manifest.json",
		);
		const staleManifest = JSON.parse(readFileSync(staleManifestPath, "utf8"));
		staleManifest.source.commit = "b".repeat(40);
		writeFileSync(staleManifestPath, JSON.stringify(staleManifest));
		stale.expectedManifestSha256 = hash(staleManifestPath);
		packageVoxCpm2Runtime({
			runtimeSource: stale.runtimeSource,
			expectedManifestSha256: stale.expectedManifestSha256,
			output: stale.runtimeArchive,
			tar:
				process.platform === "win32"
					? "C:\\Windows\\System32\\tar.exe"
					: "tar",
		});

		expect(() =>
			stageVoxCpm2Runtime({
				...selected,
				runtimeArchive: stale.runtimeArchive,
			}),
		).toThrow(/embedded artifact-manifest SHA-256 mismatch/);
	});

	it("checks every tracked payload file and keeps installer builds on stage-runtime", () => {
		const source = fixture();
		const contract = readVoxCpm2ActivationContract();
		contract.payload.requiredFiles.push("future-installer-helper.ps1");
		expect(
			voxCpm2PayloadFileActivationFailures(
				resolve(source.shellDir, "src-tauri/windows"),
				contract,
			),
		).toEqual([
			"missing payload file: voxcpm2-activation-contract.json",
			"missing payload file: future-installer-helper.ps1",
		]);
		const packageJson = JSON.parse(
			readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
		);
		expect(packageJson.scripts["tauri:installer"]).toContain(
			"scripts/stage-runtime.mjs",
		);
		expect(packageJson.scripts["tauri:installer"]).not.toContain(
			"tauri-with-mode.mjs build",
		);
		const stageRuntime = readFileSync(
			resolve(process.cwd(), "scripts/stage-runtime.mjs"),
			"utf8",
		);
		expect(stageRuntime).toContain(
			"voxcpm2_upgrade_rejects_default_only_payload_control_files",
		);
	});

	it("stages the verified download, installer, and default voice contracts", () => {
		const source = fixture();
		const destination = stageVoxCpm2Runtime(source);
		expect(existsSync(resolve(destination, "artifact"))).toBe(false);
		const download = JSON.parse(
			readFileSync(resolve(destination, "download-manifest.json"), "utf8"),
		);
		expect(download).toMatchObject({
			schemaVersion: 1,
			profile: "windows_trt_6g",
			artifactManifestSha256: source.expectedManifestSha256,
			archive: {
				url: source.runtimeUrl,
				sha256: hash(source.runtimeArchive),
				bytes: readFileSync(source.runtimeArchive).length,
			},
		});
		expect(download.archive.files).toBeGreaterThan(0);
		expect(download.archive.unpackedBytes).toBeGreaterThan(0);
		expect(
			readFileSync(resolve(destination, "prepare-voxcpm2-model.ps1"), "utf8"),
		).toBe("shell orchestration");
		expect(
			JSON.parse(
				readFileSync(
					resolve(destination, "voxcpm2-activation-contract.json"),
					"utf8",
				),
			).runtime.referenceVoices[0],
		).toMatchObject({
			id: "cc0-ko-female-01.wav",
			default: true,
		});
		expect(existsSync(resolve(destination, "service"))).toBe(false);
		expect(existsSync(resolve(destination, "repos"))).toBe(false);
	});

	it("rejects a non-HTTPS release URL", () => {
		expect(() =>
			stageVoxCpm2Runtime({
				...fixture(),
				runtimeUrl: "http://downloads.nextain.io/runtime.zip",
			}),
		).toThrow(/credential-free HTTPS/);
	});

	it("rejects drift between preview, synthesis, and installer voice defaults", () => {
		const previewDrift = fixture();
		writeFileSync(
			resolve(previewDrift.shellDir, "src/lib/config.ts"),
			'export const DEFAULT_VOICE_REF_URL = "https://example.invalid/other.wav";',
		);
		expect(() => stageVoxCpm2Runtime(previewDrift)).toThrow(
			/preview default URL differs/,
		);

		const synthesisDrift = fixture();
		writeFileSync(
			resolve(synthesisDrift.shellDir, "src/components/chat-voice-utils.ts"),
			'export function resolveTtsVoiceId() { return "other.wav"; }',
		);
		expect(() => stageVoxCpm2Runtime(synthesisDrift)).toThrow(
			/synthesis default voice id differs/,
		);
	});

	it("rejects Nextain source and bundled voices", () => {
		const source = fixture();
		writeFileSync(
			resolve(
				source.runtimeSource,
				"python/Lib/site-packages/voxcpm2_tensorrt/http_server.py",
			),
			"source",
		);
		expect(() => stageVoxCpm2Runtime(source)).toThrow(/inventory mismatch/);

		const voice = fixture();
		writeFileSync(resolve(voice.runtimeSource, "voices/default.wav"), "RIFF");
		expect(() => stageVoxCpm2Runtime(voice)).toThrow(/inventory mismatch/);
	});

	it("fails closed on an external manifest digest mismatch", () => {
		expect(() =>
			stageVoxCpm2Runtime({
				...fixture(),
				expectedManifestSha256: "0".repeat(64),
			}),
		).toThrow(/SHA-256 mismatch/);
	});

	it("fails closed on tampering and unlisted files", () => {
		const tampered = fixture();
		writeFileSync(
			resolve(tampered.runtimeSource, "python/python.exe"),
			"changed",
		);
		expect(() => stageVoxCpm2Runtime(tampered)).toThrow(/digest mismatch/);
		const extra = fixture();
		writeFileSync(resolve(extra.runtimeSource, "extra.py"), "unexpected");
		expect(() => stageVoxCpm2Runtime(extra)).toThrow(/inventory mismatch/);
	});

	it("fails closed when the complete distribution lock drifts", () => {
		const drifted = fixture();
		writeFileSync(
			resolve(drifted.runtimeSource, "runtime-package-lock.json"),
			"{}",
		);
		expect(() => stageVoxCpm2Runtime(drifted)).toThrow(
			/package lock SHA-256 mismatch/,
		);
	});
});


/**
 * 설치 스크립트 이름은 운영체제 사실이고, 그 사실이 사는 곳은 VOXCPM2_PROFILES
 * 한 곳뿐이다 (#537).
 *
 * 같은 사실을 두 번 적었더니 두 번째 플랫폼이 조용히 어긋났다. dev 스테이징
 * (tauri-with-mode.mjs)이 PowerShell 스크립트 이름을 직접 적어 두는 바람에,
 * 리눅스에서 셸을 띄우면 resource_dir 에 .ps1 만 놓였다. Rust 쪽
 * voxcpm2_installer_script_path 는 호스트에 맞는 스크립트와 활성화 계약이
 * 같은 자리에 둘 다 있어야 경로를 내주므로, 설치는 아카이브를 받아 풀고도
 * 승격 직전에 죽었고 셸은 그 결과를 브라우저 음성으로 조용히 되돌렸다(#507).
 *
 * 그래서 이 테스트는 값이 아니라 출처를 지킨다 — 스테이징 스크립트가 스크립트
 * 이름을 직접 적으면 실패한다.
 */
describe("설치 스크립트 이름의 단일 출처 (#537)", () => {
	const stagingScripts = [
		"scripts/tauri-with-mode.mjs",
		"scripts/build-e2e-tauri.mjs",
	];

	it("등록부가 운영체제마다 제 설치 스크립트를 준다", () => {
		expect(voxCpm2Profile("win32").modelPrepName).toBe(
			"prepare-voxcpm2-model.ps1",
		);
		expect(voxCpm2Profile("linux").modelPrepName).toBe(
			"prepare-voxcpm2-model.sh",
		);
		expect(voxCpm2Profile("win32").modelPrep).toContain("src-tauri/windows/");
		expect(voxCpm2Profile("linux").modelPrep).toContain("src-tauri/linux/");
	});

	it("스테이징 스크립트는 설치 스크립트 이름을 직접 적지 않는다", () => {
		const shellDir = resolve(import.meta.dirname, "..", "..");
		for (const relativePath of stagingScripts) {
			const source = readFileSync(resolve(shellDir, relativePath), "utf8");
			expect(
				source,
				`${relativePath} 가 설치 스크립트 이름을 직접 적었다 — VOXCPM2_PROFILES 를 통하게 하라`,
			).not.toMatch(/prepare-voxcpm2-model\.(ps1|sh)/);
		}
	});
});
