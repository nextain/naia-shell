import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
/** Stage a digest-pinned standalone voxcpm2-tensorrt Windows artifact. */
import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SHELL = resolve(SCRIPT_DIR, "..");
const REPOSITORY = "https://github.com/nextain/voxcpm2-tensorrt";

// One entry per shipped runtime. Everything that differs between operating
// systems lives here rather than as literals further down: the same fact
// written twice is how a second platform silently diverges from the first.
//
// `contract` names the activation contract that describes the artifact's
// insides — which files must exist, which module must be compiled, and with
// what extension. The staging code reads those from the contract, so adding a
// platform is a matter of describing it, not of editing checks.
//
// Both entries now name a published artifact. Linux was empty until
// nextain/voxcpm2-tensorrt grew its own builder (scripts/build_runtime.sh,
// profile linux_trt_6g, commit 3dbc86c); the r1 archive was published on
// 2026-09-04 and verified from this machine (#537).
export const VOXCPM2_PROFILES = {
	win32: {
		osKey: "windows",
		profile: "windows_trt_6g",
		contract: "src-tauri/voxcpm2-activation-contract.json",
		modelPrep: "src-tauri/windows/prepare-voxcpm2-model.ps1",
		modelPrepName: "prepare-voxcpm2-model.ps1",
		// Checked-in download pin that dev and E2E builds read on this OS.
		downloadManifest: "scripts/voxcpm2-download-manifest.json",
		defaultDownloadUrl:
			"https://stnaiapub83b29893.blob.core.windows.net/releases/windows_trt_6g/releases/0.2.2/voxcpm2-runtime-win-trt6g-r2.zip",
		defaultTar: "tar.exe",
	},
	linux: {
		osKey: "linux",
		profile: "linux_trt_6g",
		contract: "src-tauri/voxcpm2-activation-contract.json",
		modelPrep: "src-tauri/linux/prepare-voxcpm2-model.sh",
		modelPrepName: "prepare-voxcpm2-model.sh",
		// Same content CI stages into the 0.2.3 Linux release. Without it a Linux
		// dev shell fell back to the Windows pin and downloaded the Windows engine.
		downloadManifest: "scripts/voxcpm2-download-manifest.linux.json",
		defaultDownloadUrl:
			"https://stnaiapub83b29893.blob.core.windows.net/releases/linux_trt_6g/releases/0.2.3/voxcpm2-runtime-linux-trt6g-r1.zip",
		// The archive is a ZIP; GNU tar cannot read it. libarchive's bsdtar can,
		// and a host without it may set NAIA_SYSTEM_TAR=unzip instead.
		defaultTar: "bsdtar",
	},
};

export function voxCpm2Profile(platform = process.platform) {
	const row = VOXCPM2_PROFILES[platform];
	if (!row)
		throw new Error(`no VoxCPM2 runtime profile for platform ${platform}`);
	return row;
}

export const DEFAULT_VOXCPM2_TRT_DOWNLOAD_URL =
	VOXCPM2_PROFILES.win32.defaultDownloadUrl;
const ACTIVATION_CONTRACT_PATH = resolve(
	DEFAULT_SHELL,
	VOXCPM2_PROFILES.win32.contract,
);

/**
 * 활성화 계약을 읽어 이 운영체제 몫을 돌려준다 (#537).
 *
 * 계약 파일은 한 벌이다. 운영체제마다 다른 것은 `platforms` 아래에 있고,
 * 참조 음성처럼 무관한 것은 `runtime` 아래에 한 번만 적힌다 — 사본을 두면
 * 한쪽만 고쳐지는 날이 온다.
 */
export function readVoxCpm2ActivationContract(
	path = ACTIVATION_CONTRACT_PATH,
	osKey = VOXCPM2_PROFILES.win32.osKey,
) {
	const raw = JSON.parse(readFileSync(path, "utf8"));
	if (raw.schemaVersion !== 2 || !raw.platforms?.[osKey])
		throw new Error("VoxCPM2 activation contract is invalid");
	const contract = {
		...raw.platforms[osKey],
		runtime: raw.runtime,
	};
	if (
		!Array.isArray(contract.artifact?.requiredFiles) ||
		!Array.isArray(contract.artifact?.requiredDirectories) ||
		!Array.isArray(contract.artifact?.compiledModules) ||
		!Array.isArray(contract.payload?.requiredFiles) ||
		!Array.isArray(contract.payload?.requiredDirectories) ||
		!Array.isArray(contract.runtime?.referenceVoices) ||
		contract.runtime.referenceVoices.length < 1 ||
		contract.runtime.referenceVoices.filter((voice) => voice.default).length !== 1 ||
		contract.runtime.referenceVoices.some(
			(voice) =>
				!/^[-\w.]+\.wav$/iu.test(voice.id) ||
				!/^https:\/\//iu.test(voice.url) ||
				!/^[a-f\d]{64}$/iu.test(voice.sha256) ||
				!Number.isSafeInteger(voice.bytes) ||
				voice.bytes <= 0,
		)
	)
		throw new Error("VoxCPM2 activation contract is invalid");
	return contract;
}

export function voxCpm2ArtifactActivationFailures(
	source,
	contract = readVoxCpm2ActivationContract(),
) {
	const failures = [];
	for (const path of contract.artifact.requiredFiles) {
		const candidate = resolve(source, path);
		if (!existsSync(candidate) || !statSync(candidate).isFile())
			failures.push(`missing file: ${path}`);
	}
	for (const path of contract.artifact.requiredDirectories) {
		const candidate = resolve(source, path);
		if (!existsSync(candidate) || !statSync(candidate).isDirectory())
			failures.push(`missing directory: ${path}`);
	}
	for (const compiled of contract.artifact.compiledModules) {
		const directory = resolve(source, compiled.directory);
		const prefix = `${compiled.module}.`;
		const suffix = `.${compiled.extension}`.toLowerCase();
		const present =
			existsSync(directory) &&
			statSync(directory).isDirectory() &&
			readdirSync(directory, { withFileTypes: true }).some(
				(entry) =>
					entry.isFile() &&
					entry.name.startsWith(prefix) &&
					entry.name.toLowerCase().endsWith(suffix),
			);
		if (!present)
			failures.push(
				`missing compiled module: ${compiled.directory}/${compiled.module}.*.${compiled.extension}`,
			);
	}
	return failures;
}

export function voxCpm2PayloadFileActivationFailures(
	root,
	contract = readVoxCpm2ActivationContract(),
) {
	return contract.payload.requiredFiles
		.filter((path) => {
			const candidate = resolve(root, path);
			return !existsSync(candidate) || !statSync(candidate).isFile();
		})
		.map((path) => `missing payload file: ${path}`);
}

export function verifyVoxCpm2ArchiveActivationContract({
	archive,
	tar = process.env.NAIA_SYSTEM_TAR || "tar.exe",
	contract = readVoxCpm2ActivationContract(),
	expectedFiles,
	expectedManifestSha256,
} = {}) {
	// Use the names-only listing. The verbose column layout is not stable across
	// the bsdtar versions shipped by Windows runners (notably windows-2025), so
	// parsing `-tvf` can silently turn a valid archive into an empty inventory.
	// File content is still covered below by the embedded manifest digest, while
	// the extracted source is verified file-by-file before this audit runs.
	//
	// The archive is a ZIP. bsdtar (Windows, macOS, libarchive on Linux) reads
	// it with tar verbs; GNU tar cannot. On a Linux host without bsdtar, point
	// NAIA_SYSTEM_TAR at `unzip` and the same audit runs through its verbs.
	const unzipTool = /^unzip(?:\.exe)?$/iu.test(basename(tar));
	const listArgs = unzipTool
		? ["-Z1", basename(archive)]
		: ["-tf", basename(archive)];
	const readArgs = (entry) =>
		unzipTool
			? ["-p", basename(archive), entry]
			: ["-xOf", basename(archive), entry];
	const inspected = spawnSync(tar, listArgs, {
		encoding: "utf8",
		windowsHide: true,
		cwd: dirname(archive),
		maxBuffer: 64 * 1024 * 1024,
	});
	if (inspected.status !== 0)
		throw new Error(
			`VoxCPM2 ZIP64 activation audit failed (${inspected.status}): ${inspected.stderr || inspected.stdout}`,
		);
	const entries = String(inspected.stdout ?? "")
		.split(/\r?\n/u)
		.map((line) => line.trim().replaceAll("\\", "/").replace(/^\.\//u, ""))
		.filter(Boolean);
	const fileEntries = entries.filter((entry) => !entry.endsWith("/"));
	const files = new Set(fileEntries);
	const directories = new Set(
		entries
			.filter((entry) => entry.endsWith("/"))
			.map((entry) => entry.slice(0, -1)),
	);
	const failures = [];
	for (const path of contract.artifact.requiredFiles)
		if (!files.has(path)) failures.push(`missing file: ${path}`);
	for (const path of contract.artifact.requiredDirectories)
		if (!directories.has(path)) failures.push(`missing directory: ${path}`);
	for (const compiled of contract.artifact.compiledModules) {
		const prefix = `${compiled.directory}/${compiled.module}.`;
		const suffix = `.${compiled.extension}`.toLowerCase();
		if (
			![...files].some(
				(path) => path.startsWith(prefix) && path.toLowerCase().endsWith(suffix),
			)
		)
			failures.push(
				`missing compiled module: ${compiled.directory}/${compiled.module}.*.${compiled.extension}`,
			);
	}
	if (expectedFiles) {
		const expected = new Set(expectedFiles);
		const extras = [...files].filter((path) => !expected.has(path));
		const missing = [...expected].filter((path) => !files.has(path));
		if (extras.length || missing.length)
			failures.push(
				`archive/source inventory mismatch: extras=${extras.length} missing=${missing.length}`,
			);
	}
	if (expectedManifestSha256) {
		let manifest = spawnSync(tar, readArgs("artifact-manifest.json"), {
			windowsHide: true,
			cwd: dirname(archive),
			maxBuffer: 16 * 1024 * 1024,
		});
		// GNU tar records files packaged from `.` with a leading `./`, while
		// bsdtar (used by the Windows release job) accepts the normalized name.
		// Try the literal archive entry as a portability fallback.
		if (manifest.status !== 0)
			manifest = spawnSync(tar, readArgs("./artifact-manifest.json"), {
				windowsHide: true,
				cwd: dirname(archive),
				maxBuffer: 16 * 1024 * 1024,
			});
		const actualManifestSha256 =
			manifest.status === 0
				? createHash("sha256").update(manifest.stdout).digest("hex")
				: "";
		if (
			actualManifestSha256.toLowerCase() !== expectedManifestSha256.toLowerCase()
		)
			failures.push("embedded artifact-manifest SHA-256 mismatch");
	}
	if (failures.length)
		throw new Error(
			`VoxCPM2 archive cannot pass runtime activation: ${failures.join("; ")}`,
		);
	return { files: files.size, directories: directories.size };
}

function sha256(path) {
	// Chunked synchronous hashing: handles multi-GB release files without
	// loading them whole (readFileSync caps out around 2 GiB) and without the
	// PowerShell child the previous large-file branch used — Windows
	// PowerShell 5.1 does not feed trailing positional arguments to a
	// -Command script's $args, so that branch always threw
	// "Could not hash large release file" on the release machine.
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(8 * 1024 * 1024);
		let read;
		while ((read = readSync(fd, buf, 0, buf.length, null)) > 0)
			hash.update(read === buf.length ? buf : buf.subarray(0, read));
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

function filesUnder(root, current = root) {
	return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(current, entry.name);
		return entry.isDirectory()
			? filesUnder(root, path)
			: [relative(root, path).split(sep).join("/")];
	});
}

export function verifyVoxCpm2RemoteDownload(
	url,
	expectedBytes,
	{ timeoutMs = 30_000 } = {},
) {
	const probe = [
		"const [url, expectedBytes, timeoutMs] = process.argv.slice(1);",
		"const controller = new AbortController();",
		"const timer = setTimeout(() => controller.abort(), Number(timeoutMs));",
		"try {",
		'  const head = await fetch(url, { method: "HEAD", redirect: "error", signal: controller.signal });',
		'  if (head.status !== 200) throw new Error("HEAD returned HTTP " + head.status);',
		'  const length = Number(head.headers.get("content-length"));',
		'  if (length !== Number(expectedBytes)) throw new Error("Content-Length " + length + " does not match " + expectedBytes);',
		'  const range = await fetch(url, { headers: { Range: "bytes=0-0" }, redirect: "error", signal: controller.signal });',
		'  if (range.status !== 206) throw new Error("range GET returned HTTP " + range.status);',
		'  const contentRange = range.headers.get("content-range") ?? "";',
		'  if (!contentRange.endsWith("/" + expectedBytes)) throw new Error("Content-Range " + contentRange + " does not match " + expectedBytes);',
		"  await range.body?.cancel();",
		"} finally {",
		"  clearTimeout(timer);",
		"}",
	].join("\n");
	const checked = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			probe,
			url,
			String(expectedBytes),
			String(timeoutMs),
		],
		{
			encoding: "utf8",
			windowsHide: true,
			timeout: timeoutMs + 5_000,
		},
	);
	if (checked.status !== 0)
		throw new Error(
			`VoxCPM2 public download verification failed: ${String(checked.stderr || checked.stdout || checked.error || `exit ${checked.status}`).trim()}`,
		);
}

/** 운영체제 키가 가리키는 프로파일 이름. 내려받은 아카이브의 신원과 대조한다. */
function profileIdForOs(osKey) {
	const row = Object.values(VOXCPM2_PROFILES).find((r) => r.osKey === osKey);
	if (!row) throw new Error(`no VoxCPM2 runtime profile for os ${osKey}`);
	return row.profile;
}

export function verifyVoxCpm2Artifact(
	source,
	expectedManifestSha256,
	osKey = VOXCPM2_PROFILES.win32.osKey,
	contract = readVoxCpm2ActivationContract(ACTIVATION_CONTRACT_PATH, osKey),
) {
	if (!/^[a-f0-9]{64}$/i.test(expectedManifestSha256 ?? ""))
		throw new Error(
			"NAIA_VOXCPM2_TRT_ARTIFACT_SHA256 must pin the artifact manifest",
		);
	const manifestPath = resolve(source, "artifact-manifest.json");
	if (!existsSync(manifestPath))
		throw new Error("VoxCPM2 artifact manifest is missing");
	if (sha256(manifestPath) !== expectedManifestSha256.toLowerCase())
		throw new Error("VoxCPM2 artifact manifest SHA-256 mismatch");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (
		manifest.schemaVersion !== 1 ||
		manifest.profile !== profileIdForOs(osKey) ||
		manifest.source?.repository !== REPOSITORY ||
		!/^[a-f0-9]{40}$/.test(manifest.source?.commit ?? "")
	)
		throw new Error("VoxCPM2 artifact provenance contract is invalid");
	const runtimeManifest = resolve(source, "runtime-manifest.json");
	if (
		!existsSync(runtimeManifest) ||
		sha256(runtimeManifest) !== manifest.runtimeManifestSha256
	)
		throw new Error("VoxCPM2 runtime manifest SHA-256 mismatch");
	const packageLock = resolve(source, "runtime-package-lock.json");
	if (
		!existsSync(packageLock) ||
		sha256(packageLock) !== manifest.packageLockSha256
	)
		throw new Error("VoxCPM2 runtime package lock SHA-256 mismatch");
	const installerPackageLock = resolve(source, "installer-package-lock.json");
	if (
		!existsSync(installerPackageLock) ||
		sha256(installerPackageLock) !== manifest.installerPackageLockSha256
	)
		throw new Error("VoxCPM2 installer package lock SHA-256 mismatch");
	if (!Array.isArray(manifest.files) || manifest.files.length === 0)
		throw new Error("VoxCPM2 artifact inventory is empty");
	const expected = new Set();
	for (const item of manifest.files) {
		const path = String(item?.path ?? "").replaceAll("\\", "/");
		if (
			!path ||
			path.startsWith("/") ||
			path.split("/").includes("..") ||
			expected.has(path)
		)
			throw new Error(`VoxCPM2 artifact inventory path is invalid: ${path}`);
		expected.add(path);
		const full = resolve(source, path);
		if (!existsSync(full) || !statSync(full).isFile())
			throw new Error(`VoxCPM2 artifact file is missing: ${path}`);
		if (statSync(full).size !== item.size || sha256(full) !== item.sha256)
			throw new Error(`VoxCPM2 artifact file digest mismatch: ${path}`);
	}
	const actual = new Set(
		filesUnder(source).filter((path) => path !== "artifact-manifest.json"),
	);
	const extras = [...actual].filter((path) => !expected.has(path));
	const missing = [...expected].filter((path) => !actual.has(path));
	if (extras.length || missing.length)
		throw new Error(
			`VoxCPM2 artifact inventory mismatch: extras=${extras.length} missing=${missing.length}`,
		);
	// The contract already states which files an artifact must contain and which
	// module must be compiled. Repeating that list here is what would let a
	// second platform pass its own contract while failing this check, or the
	// reverse — so read it rather than restate it.
	for (const required of contract.artifact.requiredFiles)
		if (required !== "artifact-manifest.json" && !expected.has(required))
			throw new Error(`VoxCPM2 artifact is incomplete: ${required}`);
	const compiled = contract.artifact.compiledModules[0];
	const compiledPrefix = `${compiled.directory}/`;
	const sitePackagesPrefix = `${compiled.directory.slice(
		0,
		compiled.directory.lastIndexOf("/") + 1,
	)}`;
	const compiledSuffix = `.${compiled.extension}`;
	const compiledModules = [...expected].filter(
		(path) => path.startsWith(compiledPrefix) && path.endsWith(compiledSuffix),
	);
	if (compiledModules.length === 0)
		throw new Error("VoxCPM2 compiled Nextain payload is missing");
	const prohibited = [...expected].filter(
		(path) =>
			(path.startsWith(compiledPrefix) && /\.(?:py|pyc|c|pdb)$/i.test(path)) ||
			(!path.startsWith(sitePackagesPrefix) &&
				/\.(?:engine|onnx|plan)$/i.test(path)) ||
			(path.startsWith("voices/") && /\.wav$/i.test(path)),
	);
	if (prohibited.length)
		throw new Error(
			`VoxCPM2 artifact contains prohibited release files: ${prohibited.join(", ")}`,
		);
	if (manifest.voice !== null)
		throw new Error("VoxCPM2 release must not bundle an unapproved voice");
	// Same operating-system contract as the checks above — the default is the
	// Windows contract, which quietly demanded python.exe of a Linux artifact.
	const activationFailures = voxCpm2ArtifactActivationFailures(source, contract);
	if (activationFailures.length)
		throw new Error(
			`VoxCPM2 artifact cannot pass runtime activation: ${activationFailures.join("; ")}`,
		);
	return manifest;
}

/**
 * The module that decides which voice id local synthesis sends.
 *
 * `resolveTtsVoiceId` owns that decision; its fallback is the default voice.
 * Locating it by export keeps the release gate pointed at the behaviour even
 * when the function moves between modules.
 */
export function voxCpm2SynthesisDefaultSource(shellDir = DEFAULT_SHELL) {
	const root = resolve(shellDir, "src");
	const stack = [root];
	while (stack.length) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = resolve(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "__tests__" && entry.name !== "node_modules")
					stack.push(path);
				continue;
			}
			if (!/\.tsx?$/.test(entry.name)) continue;
			const source = readFileSync(path, "utf8");
			if (/export\s+function\s+resolveTtsVoiceId\b/.test(source))
				return { path: relative(shellDir, path), source };
		}
	}
	throw new Error(
		"Shell no longer exports resolveTtsVoiceId; the local-voice default is unverifiable",
	);
}

export function stageVoxCpm2Runtime({
	shellDir = DEFAULT_SHELL,
	// The runtime being staged is a property of the release being built, not of
	// the machine doing the building: a Windows release is cross-staged from
	// Linux CI. Defaulting to process.platform would make the same command mean
	// different things on different runners.
	platform = process.env.NAIA_VOXCPM2_TARGET_PLATFORM || "win32",
	descriptor = voxCpm2Profile(platform),
	runtimeSource = process.env.NAIA_VOXCPM2_TRT_RUNTIME_DIR,
	expectedManifestSha256 = process.env.NAIA_VOXCPM2_TRT_ARTIFACT_SHA256,
	runtimeArchive = process.env.NAIA_VOXCPM2_TRT_ARCHIVE,
	runtimeUrl =
		process.env.NAIA_VOXCPM2_TRT_DOWNLOAD_URL ||
		descriptor.defaultDownloadUrl,
	tar = process.env.NAIA_SYSTEM_TAR || descriptor.defaultTar,
	verifyRemoteDownload = verifyVoxCpm2RemoteDownload,
	allowUnpublishedDownload =
		process.env.NAIA_UNSIGNED_UPDATER_BUILD === "1" &&
		process.env.CI !== "true",
} = {}) {
	if (!runtimeSource)
		throw new Error(
			`NAIA_VOXCPM2_TRT_RUNTIME_DIR is required for a ${descriptor.profile} release`,
		);
	const source = realpathSync(runtimeSource);
	const activationContract = readVoxCpm2ActivationContract(
		resolve(shellDir, descriptor.contract),
		descriptor.osKey,
	);
	const defaultVoice = activationContract.runtime.referenceVoices.find(
		(voice) => voice.default,
	);
	const configSource = readFileSync(resolve(shellDir, "src/lib/config.ts"), "utf8");
	if (!configSource.includes(JSON.stringify(defaultVoice.url)))
		throw new Error(
			"Shell preview default URL differs from the Naia Host activation contract",
		);
	// The synthesis default lives wherever `resolveTtsVoiceId` is defined, and
	// that has moved between modules (ChatArea → chat-voice-utils, aa49512f).
	// Follow the function instead of a filename: naming the file made a pure
	// refactor break release staging with a message about voices.
	const synthesisSource = voxCpm2SynthesisDefaultSource(shellDir);
	if (!synthesisSource.source.includes(JSON.stringify(defaultVoice.id)))
		throw new Error(
			`Shell synthesis default voice id differs from the Naia Host activation contract (${synthesisSource.path})`,
		);
	verifyVoxCpm2Artifact(
		source,
		expectedManifestSha256,
		descriptor.osKey,
		activationContract,
	);
	if (!runtimeArchive)
		throw new Error(
			`NAIA_VOXCPM2_TRT_ARCHIVE is required for a ${descriptor.profile} release`,
		);
	const archive = realpathSync(runtimeArchive);
	if (!statSync(archive).isFile())
		throw new Error("VoxCPM2 download archive is not a file");
	const inventory = filesUnder(source);
	const unpackedBytes = inventory.reduce(
		(total, path) => total + statSync(resolve(source, path)).size,
		0,
	);
	verifyVoxCpm2ArchiveActivationContract({
		archive,
		tar,
		contract: activationContract,
		expectedFiles: inventory,
		expectedManifestSha256,
	});
	let parsedUrl;
	try {
		parsedUrl = new URL(runtimeUrl);
	} catch {
		throw new Error("NAIA_VOXCPM2_TRT_DOWNLOAD_URL must be a valid HTTPS URL");
	}
	if (
		parsedUrl.protocol !== "https:" ||
		parsedUrl.username ||
		parsedUrl.password
	)
		throw new Error("VoxCPM2 download URL must use credential-free HTTPS");
	if (allowUnpublishedDownload) {
		console.warn(
			"[stage-voxcpm2-runtime] unsigned local validation: public download probe skipped",
		);
	} else {
		verifyRemoteDownload(parsedUrl.href, statSync(archive).size);
	}
	const downloadManifest = {
		schemaVersion: 1,
		profile: descriptor.profile,
		artifactManifestSha256: expectedManifestSha256.toLowerCase(),
		archive: {
			url: parsedUrl.href,
			sha256: sha256(archive),
			bytes: statSync(archive).size,
			unpackedBytes,
			files: inventory.length,
		},
	};
	const destination = resolve(shellDir, "src-tauri/voxcpm2-runtime");
	const pending = `${destination}.pending`;
	rmSync(pending, { recursive: true, force: true });
	mkdirSync(pending, { recursive: true });
	copyFileSync(
		resolve(shellDir, descriptor.modelPrep),
		resolve(pending, descriptor.modelPrepName),
	);
	copyFileSync(
		resolve(shellDir, descriptor.contract),
		resolve(pending, basename(descriptor.contract)),
	);
	const payloadFailures = voxCpm2PayloadFileActivationFailures(
		pending,
		activationContract,
	);
	if (payloadFailures.length)
		throw new Error(
			`VoxCPM2 staged payload cannot pass runtime activation: ${payloadFailures.join("; ")}`,
		);
	writeFileSync(
		resolve(pending, "download-manifest.json"),
		`${JSON.stringify(downloadManifest, null, 2)}\n`,
	);
	rmSync(destination, { recursive: true, force: true });
	renameSync(pending, destination);
	return destination;
}

const invoked = process.argv[1]
	? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
	: "";
if (invoked === import.meta.url)
	console.log(`[stage-voxcpm2-runtime] staged ${stageVoxCpm2Runtime()}`);
