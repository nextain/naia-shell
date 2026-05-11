import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { agentBrowserDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

/**
 * agent-browser skill — wraps the `agent-browser` CLI as a subprocess.
 *
 * Ported from OpenClaw container/skills/agent-browser via #274. naia already
 * carries `agent-browser` as a dependency; we resolve its CLI entry through
 * `createRequire` so the path works in both monorepo dev (file: link) and
 * Flatpak/Windows installs (bundled node_modules).
 *
 * Subprocess is non-interactive: stdin closed, stdout/stderr captured. The
 * timeout default is 30s — overrides for long flows (uploads) via `timeoutMs`.
 *
 * NOTE: invocations like `agent-browser open <url>` keep a browser process
 * alive across calls. The CLI manages its own session; we just pass through.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveCliPath(): string {
	const require = createRequire(import.meta.url);
	const pkgJsonPath = require.resolve("agent-browser/package.json");
	// agent-browser/package.json → ../bin/agent-browser.js (per package.json bin)
	return pkgJsonPath.replace(/package\.json$/, "bin/agent-browser.js");
}

function runCli(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const cliPath = resolveCliPath();
		const child = spawn(process.execPath, [cliPath, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		const out: Buffer[] = [];
		const err: Buffer[] = [];

		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			stderr += `\n[agent-browser] timeout after ${timeoutMs}ms`;
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timer);
			stdout = Buffer.concat(out).toString("utf8");
			stderr += Buffer.concat(err).toString("utf8");
			resolve({ ok: code === 0, stdout, stderr });
		});

		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, stdout: "", stderr: e.message });
		});
	});
}

export function createAgentBrowserSkill(): SkillDefinition {
	return {
		name: `skill_${agentBrowserDescriptor.name}`,
		description: agentBrowserDescriptor.description,
		parameters: agentBrowserDescriptor.inputSchema,
		tier: 1, // descriptor.tier = "T1"
		requiresGateway: false,
		source: "built-in",
		execute: async (args): Promise<SkillResult> => {
			const cmd = args.cmd as string | undefined;
			if (!cmd) {
				return { success: false, output: "", error: "cmd is required" };
			}
			const extras = (args.args as string[] | undefined) ?? [];
			const timeoutMs = (args.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS;

			try {
				const result = await runCli([cmd, ...extras], timeoutMs);
				if (!result.ok) {
					return {
						success: false,
						output: result.stdout,
						error: result.stderr.trim() || `agent-browser ${cmd} failed`,
					};
				}
				return { success: true, output: result.stdout };
			} catch (e) {
				return {
					success: false,
					output: "",
					error: e instanceof Error ? e.message : String(e),
				};
			}
		},
	};
}
