/**
 * Stage a pinned Herdr standalone release into `src-tauri/resources/herdr/` so
 * the Windows installer bundles it and a fresh install needs no separately
 * installed Herdr (the embedded Workspace resolves it via resource_dir first,
 * PATH fallback — see herdr/config.rs `init_herdr_bin`).
 *
 * The Windows release is a directory (`herdr.exe` + `conpty/` ConPTY runtime +
 * THIRD-PARTY-NOTICES), so the whole directory is copied — herdr.exe finds its
 * sibling `conpty/` next to it under the resource dir.
 *
 * Source = Herdr's own package-manager standalone release layout
 * (`~/.herdr/packages/standalone/releases/<version>-<triple>/`), or the
 * `HERDR_RELEASE_DIR` override. Output is gitignored (like the Node runtime);
 * the version is pinned here to control update drift (nextain#445). Windows
 * only for now — Linux packages layer Herdr at the naia-os level.
 */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, "..");
const RESOURCES = resolve(SHELL, "src-tauri", "resources");
const DEST = resolve(RESOURCES, "herdr");

/** Bundled herdr for packaged Windows installs (protocol 19). Dev PATH may be
    0.9.1 (protocol 22). Snapshot pin is `src-tauri/src/herdr/api.rs` 19..=22. */
export const HERDR_VERSION = "0.8.2";
/** SHA256 of the pinned herdr.exe — a supply-chain gate so a tampered or
    wrong-version local Herdr install cannot be silently bundled. Bump with the
    version. */
const HERDR_EXE_SHA256 =
	"467682cdb5fa482c54897c6b9c96a5300a3516a72ef70ec3d009e16fadb131b3";
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";
export const HERDR_MSVC_DLLS = [
	"msvcp140.dll",
	"vcruntime140.dll",
	"vcruntime140_1.dll",
];

/** Absolute path to the pinned Herdr release directory to bundle. */
export function herdrReleaseDir() {
	if (process.env.HERDR_RELEASE_DIR) {
		return resolve(process.env.HERDR_RELEASE_DIR);
	}
	return resolve(
		homedir(),
		".herdr",
		"packages",
		"standalone",
		"releases",
		`${HERDR_VERSION}-${TARGET_TRIPLE}`,
	);
}

/** True when the pinned release (with herdr.exe) is available to stage. */
export function herdrReleasePresent() {
	return existsSync(resolve(herdrReleaseDir(), "herdr.exe"));
}

/** Copy the MSVC runtime into the same directory as herdr.exe. */
export function stageMsvcRuntimeBesideHerdr({
	platform = process.platform,
	resourcesDir = RESOURCES,
	destinationDir = DEST,
	systemRoot = process.env.SystemRoot || "C:/Windows",
} = {}) {
	if (platform !== "win32") return [];
	const system32 = resolve(systemRoot, "System32");
	return HERDR_MSVC_DLLS.map((dll) => {
		const fromResources = resolve(resourcesDir, dll);
		const fromSystem = resolve(system32, dll);
		const source = existsSync(fromResources)
			? fromResources
			: existsSync(fromSystem)
				? fromSystem
				: null;
		if (!source) {
			throw new Error(
				`[stage-herdr] required MSVC runtime ${dll} not found in resources/ or System32 — herdr will fail on clean machines.`,
			);
		}
		const destination = resolve(destinationDir, dll);
		copyFileSync(source, destination);
		return destination;
	});
}

function main() {
	const src = herdrReleaseDir();
	const srcExe = resolve(src, "herdr.exe");
	if (!existsSync(srcExe)) {
		console.error(
			`[stage-herdr] pinned Herdr ${HERDR_VERSION} not found at ${src}\n` +
				"  Install that exact Herdr version on the build machine, or set " +
				"HERDR_RELEASE_DIR to a directory containing herdr.exe + conpty/.",
		);
		process.exit(1);
	}
	const actualSha = createHash("sha256").update(readFileSync(srcExe)).digest("hex");
	if (actualSha !== HERDR_EXE_SHA256) {
		console.error(
			`[stage-herdr] herdr.exe SHA256 mismatch — refusing to bundle.\n` +
				`  expected ${HERDR_EXE_SHA256}\n  got      ${actualSha}\n` +
				`  (${srcExe}) — wrong version or tampered binary. Update the pin if intentional.`,
		);
		process.exit(1);
	}
	mkdirSync(RESOURCES, { recursive: true });
	rmSync(DEST, { recursive: true, force: true });
	cpSync(src, DEST, { recursive: true });
	if (!existsSync(resolve(DEST, "herdr.exe"))) {
		console.error(
			`[stage-herdr] copy failed — ${resolve(DEST, "herdr.exe")} missing`,
		);
		process.exit(1);
	}
	// herdr.exe is dynamically linked to the MSVC runtime (VCRUNTIME140 + UCRT).
	// The redist DLLs are staged into resources/ (top level), but Windows resolves
	// a spawned exe's imports from the exe's OWN directory first — herdr.exe lives
	// in resources/herdr/, so on a clean machine without a system VC++ redist it
	// can't find them and every `herdr --version` fails ("Herdr version check
	// failed"). Copy the runtime beside herdr.exe. Prefer the already-staged
	// resources/ copies (version-matched to the STT plugin); fall back to
	// System32 on the build machine. (#447 clean-install)
	if (process.platform === "win32") {
		try {
			stageMsvcRuntimeBesideHerdr();
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
		console.log(
			`[stage-herdr] MSVC runtime (${HERDR_MSVC_DLLS.length}) → ${DEST}`,
		);
	}
	console.log(`[stage-herdr] bundled Herdr ${HERDR_VERSION} → ${DEST}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
