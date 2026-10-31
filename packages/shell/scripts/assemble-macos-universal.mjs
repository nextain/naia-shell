import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	chmodSync,
	mkdtempSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_ARCHS = ["x86_64", "arm64"];

// pnpm 설치-상태 메타데이터: 러너별 절대경로·설치 시각이 들어가 두 입력의 바이트가
// 원리적으로 달라지고, 런타임은 읽지 않는다(pnpm install 전용 상태 파일). 합본 산출물에서
// 통째로 배제한다 — 동일성 검증의 예외가 아니라 어느 쪽 사본도 신뢰본이 아니기 때문.
export const PNPM_INSTALL_STATE =
	/(^|\/)node_modules\/(\.modules\.yaml|\.pnpm-workspace-state[^/]*\.json|\.pnpm\/lock\.yaml)$/;

const signatureMetadata = (path) =>
	path.split("/").includes("_CodeSignature") || /(^|\/)Contents\/CodeResources$/.test(path);

function walk(root, current = root, files = []) {
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const path = resolve(current, entry.name);
		if (entry.isDirectory()) walk(root, path, files);
		else if (entry.isFile() || entry.isSymbolicLink())
			files.push(relative(root, path).replaceAll("\\", "/"));
	}
	return files.sort();
}

const sha256 = (path) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");

function unsignedHash(path, exec) {
	const temp = mkdtempSync(resolve(tmpdir(), "naia-unsigned-"));
	const copy = resolve(temp, "binary");
	try {
		cpSync(path, copy);
		chmodSync(copy, 0o600);
		try {
			exec("codesign", ["--remove-signature", copy], { stdio: "pipe" });
		} catch (error) {
			if (!String(error.stderr ?? "").includes("code object is not signed at all")) throw error;
		}
		return sha256(copy);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

const sameMachO = (a, b, exec) =>
	sha256(a) === sha256(b) || unsignedHash(a, exec) === unsignedHash(b, exec);

export function classifyFile(path, exec = execFileSync) {
	const description = String(exec("file", ["-b", path], { encoding: "utf8" }));
	return description.includes("Mach-O") ? "mach-o" : "data";
}

const scopedArch = (path) => {
	const normalized = path.toLowerCase();
	const nodeModulePayload =
		/^contents\/resources\/(agent|bgm-sidecar)\/node_modules\//;
	if (!nodeModulePayload.test(normalized)) return null;
	const architecturePackage =
		/\/node_modules\/(?:@[^/]+\/)?(?:[^/]+[_.-])?(darwin|macos)[_.-](x64|x86_64|arm64|aarch64)(?:\/|$)/;
	const architecturePrebuild =
		/\/(?:prebuilds|native|bin)\/(?:[^/]+\/)*(darwin|macos)[_./-]?(x64|x86_64|arm64|aarch64)(?:\/|$)/;
	const match =
		normalized.match(architecturePackage) ??
		normalized.match(architecturePrebuild);
	if (!match) return null;
	if (match[2] === "x64" || match[2] === "x86_64") return "x86_64";
	if (match[2] === "arm64" || match[2] === "aarch64") return "arm64";
	return null;
};

const archesOf = (path, exec) =>
	String(exec("lipo", ["-archs", path], { encoding: "utf8" }))
		.trim()
		.split(/\s+/)
		.sort();

export function classifyFileSets(x64App, arm64App) {
	const x64 = walk(x64App).filter((path) => !signatureMetadata(path));
	const arm64 = walk(arm64App).filter((path) => !signatureMetadata(path));
	const x64Set = new Set(x64);
	const arm64Set = new Set(arm64);
	const onlyX64 = x64.filter((path) => !arm64Set.has(path));
	const onlyArm64 = arm64.filter((path) => !x64Set.has(path));
	for (const path of onlyX64) {
		if (scopedArch(path) !== "x86_64")
			throw new Error(`[macos-universal] unscoped x86_64-only file: ${path}`);
	}
	for (const path of onlyArm64) {
		if (scopedArch(path) !== "arm64")
			throw new Error(`[macos-universal] unscoped arm64-only file: ${path}`);
	}
	return {
		common: x64.filter((path) => arm64Set.has(path)),
		onlyX64,
		onlyArm64,
	};
}

export function assertUniversalAppMachO(app, exec = execFileSync) {
	const machOFiles = walk(app).filter(
		(path) => classifyFile(resolve(app, path), exec) === "mach-o",
	);
	if (machOFiles.length === 0)
		throw new Error("[macos-universal] no Mach-O files found");
	for (const path of machOFiles) {
		const arches = archesOf(resolve(app, path), exec);
		const scope = scopedArch(path);
		if (scope !== null && arches.join(" ") !== scope)
			throw new Error("[macos-universal] scoped Mach-O must be matching thin");
		const isUniversal =
			arches.join(" ") === [...REQUIRED_ARCHS].sort().join(" ");
		const isValidScopedThin = scope !== null && arches.join(" ") === scope;
		if (!isUniversal && !isValidScopedThin) {
			throw new Error(
				`[macos-universal] unscoped or mismatched thin Mach-O: ${path} (${arches.join(", ")})`,
			);
		}
	}
	return machOFiles;
}

export function assembleUniversalApp(
	{ x64App, arm64App, outputApp },
	exec = execFileSync,
) {
	for (const [label, path] of Object.entries({ x64App, arm64App })) {
		if (!existsSync(path) || !lstatSync(path).isDirectory())
			throw new Error(`[macos-universal] ${label} missing: ${path}`);
	}
	const { common, onlyX64, onlyArm64 } = classifyFileSets(x64App, arm64App);
	rmSync(outputApp, { recursive: true, force: true });
	mkdirSync(dirname(outputApp), { recursive: true });
	cpSync(arm64App, outputApp, {
		recursive: true, preserveTimestamps: true,
		filter: (source) => !signatureMetadata(relative(arm64App, source).replaceAll("\\", "/")),
	});
	for (const path of [...common, ...onlyArm64]) {
		if (PNPM_INSTALL_STATE.test(path))
			rmSync(resolve(outputApp, path), { force: true });
	}
	for (const path of onlyX64) {
		if (PNPM_INSTALL_STATE.test(path)) continue;
		const source = resolve(x64App, path);
		const output = resolve(outputApp, path);
		mkdirSync(dirname(output), { recursive: true });
		if (lstatSync(source).isSymbolicLink())
			symlinkSync(readlinkSync(source), output);
		else cpSync(source, output, { preserveTimestamps: true });
	}
	let merged = 0;
	for (const path of common) {
		if (PNPM_INSTALL_STATE.test(path)) continue;
		const x64 = resolve(x64App, path);
		const arm64 = resolve(arm64App, path);
		const output = resolve(outputApp, path);
		if (lstatSync(x64).isSymbolicLink() || lstatSync(arm64).isSymbolicLink()) {
			if (
				!lstatSync(x64).isSymbolicLink() ||
				!lstatSync(arm64).isSymbolicLink() ||
				readlinkSync(x64) !== readlinkSync(arm64)
			) {
				throw new Error(`[macos-universal] symlink mismatch: ${path}`);
			}
			continue;
		}
		const x64Kind = classifyFile(x64, exec);
		const arm64Kind = classifyFile(arm64, exec);
		if (x64Kind !== arm64Kind)
			throw new Error(`[macos-universal] file kind mismatch: ${path}`);
		if (x64Kind === "mach-o") {
			const x64Arches = archesOf(x64, exec);
			const arm64Arches = archesOf(arm64, exec);
			const x64List = x64Arches.join(" ");
			const arm64List = arm64Arches.join(" ");
			const universalList = [...REQUIRED_ARCHS].sort().join(" ");
			const scope = scopedArch(path);
			if (
				scope !== null &&
				(x64List !== scope ||
					arm64List !== scope ||
					!sameMachO(x64, arm64, exec))
			)
				throw new Error(`[macos-universal] scoped Mach-O mismatch: ${path}`);
			if (
				scope === null &&
				!(
					(x64List === "x86_64" && arm64List === "arm64") ||
					(x64List === universalList && arm64List === universalList)
				)
			)
				throw new Error(
					`[macos-universal] input Mach-O architecture mismatch: ${path}`,
				);
			if (x64List === arm64List && !sameMachO(x64, arm64, exec))
				throw new Error(`[macos-universal] common Mach-O differs: ${path}`);
			if (x64Arches.join(" ") === arm64Arches.join(" ")) {
				const scope = scopedArch(path);
				const alreadyUniversal =
					x64Arches.join(" ") === [...REQUIRED_ARCHS].sort().join(" ");
				if (
					!alreadyUniversal &&
					(scope === null || x64Arches.join(" ") !== scope)
				)
					throw new Error(
						`[macos-universal] common Mach-O cannot be merged safely: ${path}`,
					);
			} else {
				exec("lipo", ["-create", "-output", output, x64, arm64]);
				merged += 1;
			}
		} else if (sha256(x64) !== sha256(arm64)) {
			throw new Error(
				`[macos-universal] architecture-neutral file differs: ${path}`,
			);
		}
	}
	const verified = assertUniversalAppMachO(outputApp, exec);
	console.log(
		`[macos-universal] PASS merged=${merged} verified=${verified.length} output=${outputApp}`,
	);
	return { merged, verified };
}

function parseArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index]?.replace(/^--/, "");
		const value = argv[index + 1];
		if (!key || value === undefined)
			throw new Error(
				"usage: assemble-macos-universal.mjs --x64-app <path> --arm64-app <path> --output-app <path>",
			);
		values[key] = value;
	}
	return values;
}

const invoked = process.argv[1]
	? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
	: "";
if (invoked === import.meta.url) {
	const args = parseArgs(process.argv.slice(2));
	assembleUniversalApp({
		x64App: resolve(args["x64-app"]),
		arm64App: resolve(args["arm64-app"]),
		outputApp: resolve(args["output-app"]),
	});
}
