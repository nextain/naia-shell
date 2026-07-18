import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHELL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = resolve(SHELL, "src-tauri", "platform-matrix.json");
const DEFAULT_BUNDLE_DIR = resolve(
	SHELL,
	"src-tauri",
	"target",
	"release",
	"bundle",
);

const sha256File = (path) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Verify installer outputs described by the platform matrix.
 * Paths and thresholds are arguments so negative tests exercise this exact
 * production predicate against isolated fixture directories.
 */
export function verifyArtifacts({ bundleDir, artifacts }) {
	if (!Array.isArray(artifacts) || artifacts.length === 0) {
		throw new Error("[verify-artifacts] artifacts 계약이 비어 있음");
	}

	const verified = [];
	for (const artifact of artifacts) {
		if (
			typeof artifact.minBytes !== "number" ||
			!Number.isFinite(artifact.minBytes) ||
			artifact.minBytes <= 0
		) {
			throw new Error(
				`[verify-artifacts] minBytes 미확정/무효: ${artifact.glob} = ${JSON.stringify(artifact.minBytes)}`,
			);
		}
		const matches = globSync(artifact.glob, {
			cwd: bundleDir,
			withFileTypes: false,
		}).filter((path) => statSync(resolve(bundleDir, path)).isFile());
		if (matches.length === 0) {
			throw new Error(
				`[verify-artifacts] 산출물 없음: ${artifact.glob} (bundle=${bundleDir})`,
			);
		}
		if (matches.length !== 1) {
			throw new Error(
				`[verify-artifacts] 산출물 중복: ${artifact.glob} = ${matches.length}개 (${matches.join(", ")})`,
			);
		}
		for (const match of matches) {
			const absolute = resolve(bundleDir, match);
			const bytes = statSync(absolute).size;
			if (bytes < artifact.minBytes) {
				throw new Error(
					`[verify-artifacts] 산출물 과소: ${match} ${bytes}B < ${artifact.minBytes}B`,
				);
			}
			verified.push({
				path: relative(bundleDir, absolute).replaceAll("\\", "/"),
				bytes,
				sha256: sha256File(absolute),
			});
		}
	}
	return verified;
}

export function runCli({
	platform = process.platform,
	bundleDir = DEFAULT_BUNDLE_DIR,
	matrixPath = MATRIX_PATH,
} = {}) {
	const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
	const artifacts = matrix.os?.[platform]?.artifacts;
	if (!artifacts) {
		throw new Error(
			`[verify-artifacts] 미지원 OS: ${platform} (지원: ${Object.keys(matrix.os ?? {}).join(", ")})`,
		);
	}
	const verified = verifyArtifacts({ bundleDir, artifacts });
	const lines = verified.map(
		(item) => `${item.sha256}  ${item.path}  # ${item.bytes} bytes`,
	);
	for (const line of lines) console.log(line);
	const output = resolve(bundleDir, "artifacts.sha256");
	writeFileSync(output, `${lines.join("\n")}\n`);
	console.log(`[verify-artifacts] PASS ${verified.length} files → ${output}`);
	return verified;
}

const invoked = process.argv[1]
	? pathToFileURL(resolve(process.argv[1])).href
	: "";
if (invoked === import.meta.url) {
	runCli();
}
