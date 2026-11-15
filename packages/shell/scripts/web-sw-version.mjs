import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SW_VERSION_PLACEHOLDER = "__NAIA_SW_VERSION__";

/**
 * Derive a deterministic Service Worker cache version suffix for a built web bundle.
 * Combines git revision and the SHA-256 prefix of built index.html unless NAIA_SW_VERSION overrides it.
 */
export function computeWebSwVersion({
	revision = "unknown",
	indexHtml = "",
	explicitVersion = process.env.NAIA_SW_VERSION,
} = {}) {
	const trimmedExplicit =
		typeof explicitVersion === "string" ? explicitVersion.trim() : "";
	if (trimmedExplicit) {
		return trimmedExplicit.replace(/[^A-Za-z0-9._-]/g, "-");
	}
	const safeRev =
		(typeof revision === "string" && revision.trim()
			? revision.trim()
			: "unknown"
		).replace(/[^A-Za-z0-9._-]/g, "-");
	const htmlDigest = createHash("sha256")
		.update(indexHtml)
		.digest("hex")
		.slice(0, 8);
	return `${safeRev}-${htmlDigest}`;
}

/**
 * Replace the version placeholder inside sw.js source with a computed build version.
 */
export function injectServiceWorkerVersion(swSource, version) {
	if (!swSource.includes(SW_VERSION_PLACEHOLDER)) {
		throw new Error(
			`Service worker template is missing placeholder: ${SW_VERSION_PLACEHOLDER}`,
		);
	}
	const normalizedVersion = String(version || "").trim();
	if (!normalizedVersion) {
		throw new Error("Service worker version must be non-empty");
	}
	return swSource.replaceAll(SW_VERSION_PLACEHOLDER, normalizedVersion);
}

/**
 * Stamp the built outDir/sw.js file after Vite emits index.html and copies public assets.
 */
export function stampBuiltServiceWorker({
	outDir,
	revision = "unknown",
	explicitVersion,
} = {}) {
	if (!outDir) {
		throw new Error("outDir is required to stamp sw.js");
	}
	const indexPath = path.join(outDir, "index.html");
	const swPath = path.join(outDir, "sw.js");
	if (!fs.existsSync(indexPath)) {
		throw new Error(`Built index.html not found: ${indexPath}`);
	}
	if (!fs.existsSync(swPath)) {
		throw new Error(`Built sw.js not found: ${swPath}`);
	}
	const indexHtml = fs.readFileSync(indexPath, "utf8");
	const swSource = fs.readFileSync(swPath, "utf8");
	const version = computeWebSwVersion({
		revision,
		indexHtml,
		explicitVersion,
	});
	const stamped = injectServiceWorkerVersion(swSource, version);
	fs.writeFileSync(swPath, stamped, "utf8");
	return { version, swPath };
}
