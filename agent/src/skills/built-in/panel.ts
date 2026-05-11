import { panelDescriptor } from "@naia-adk/skills-builtin";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	SkillDefinition,
	SkillExecutionContext,
	SkillResult,
} from "../types.js";

const PANELS_DIR = join(homedir(), ".naia", "panels");

interface PanelManifest {
	id: string;
	name: string;
	description?: string;
	icon?: string;
	version?: string;
	entrypoint?: string;
}

function readManifest(panelDir: string): PanelManifest | null {
	const manifestPath = join(panelDir, "panel.json");
	try {
		return JSON.parse(readFileSync(manifestPath, "utf-8")) as PanelManifest;
	} catch {
		return null;
	}
}

function listInstalledPanels(): PanelManifest[] {
	if (!existsSync(PANELS_DIR)) return [];
	try {
		return readdirSync(PANELS_DIR, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => readManifest(join(PANELS_DIR, e.name)))
			.filter((m): m is PanelManifest => m !== null);
	} catch {
		return [];
	}
}

function deriveNameFromSource(source: string): string {
	// Strip .git and .zip suffixes, trailing slash, then take last path segment
	const stripped = source.replace(/\.(git|zip)$/i, "").replace(/\/$/, "");
	const parts = stripped.split(/[/\\]/);
	return parts[parts.length - 1] || "panel";
}

async function actionList(): Promise<SkillResult> {
	const installed = listInstalledPanels();
	const builtIns = ["avatar", "browser", "workspace", "sample-note"];
	const lines: string[] = [
		"## Built-in panels (always available)",
		...builtIns.map((id) => `- ${id}`),
		"",
		`## Installed panels (${PANELS_DIR})`,
		...(installed.length === 0
			? ["  (none)"]
			: installed.map(
					(m) =>
						`- ${m.id}: ${m.name}${m.description ? ` — ${m.description}` : ""}`,
				)),
	];
	return { success: true, output: lines.join("\n") };
}

async function actionSwitch(
	panelId: string | undefined,
	ctx: SkillExecutionContext,
): Promise<SkillResult> {
	if (!panelId) {
		return {
			success: false,
			output: "",
			error: "panelId is required for switch",
		};
	}
	ctx.writeLine?.({
		type: "panel_control",
		requestId: ctx.requestId ?? "unknown",
		action: "switch",
		panelId,
	});
	return { success: true, output: `Switched to panel: ${panelId}` };
}

export async function actionInstall(
	source: string | undefined,
	ctx: SkillExecutionContext,
): Promise<SkillResult> {
	if (!source) {
		return {
			success: false,
			output: "",
			error: "source is required for install (git URL or file path)",
		};
	}

	mkdirSync(PANELS_DIR, { recursive: true });
	const panelName = deriveNameFromSource(source);
	const destDir = join(PANELS_DIR, panelName);

	if (existsSync(destDir)) {
		return {
			success: false,
			output: "",
			error: `Panel "${panelName}" is already installed at ${destDir}. Use remove first.`,
		};
	}

	try {
		const isGit = /^https?:\/\/|^git@|^file:\/\//.test(source);
		if (isGit) {
			const result = spawnSync(
				"git",
				["clone", "--depth", "1", source, destDir],
				{ encoding: "utf-8" },
			);
			if (result.status !== 0) {
				throw new Error(result.stderr || "git clone failed");
			}
		} else {
			// File-based: unzip to destDir (path must not escape PANELS_DIR)
			const absSource = source.startsWith("/")
				? source
				: join(PANELS_DIR, source);
			mkdirSync(destDir, { recursive: true });
			const result = spawnSync("unzip", ["-o", absSource, "-d", destDir], {
				encoding: "utf-8",
			});
			if (result.status !== 0) {
				throw new Error(result.stderr || "unzip failed");
			}
			// If zip contained a single root directory (e.g. my-panel/panel.json),
			// move its contents up so panel.json sits directly in destDir.
			const entries = readdirSync(destDir, { withFileTypes: true });
			if (entries.length === 1 && entries[0].isDirectory()) {
				const innerDir = join(destDir, entries[0].name);
				const innerEntries = readdirSync(innerDir);
				for (const name of innerEntries) {
					const { renameSync } = await import("node:fs");
					renameSync(join(innerDir, name), join(destDir, name));
				}
				rmSync(innerDir, { recursive: true, force: true });
			}
		}
	} catch (err) {
		return {
			success: false,
			output: "",
			error: `Install failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// Verify panel.json exists
	const manifest = readManifest(destDir);
	if (!manifest) {
		rmSync(destDir, { recursive: true, force: true });
		return {
			success: false,
			output: "",
			error: "Installed package has no panel.json manifest — removed.",
		};
	}

	// Notify Shell to reload panels
	ctx.writeLine?.({
		type: "panel_control",
		requestId: ctx.requestId ?? "unknown",
		action: "reload",
	});

	return {
		success: true,
		output: `Installed panel "${manifest.name}" (${manifest.id}) from ${source}.\nLocation: ${destDir}`,
	};
}

async function actionRemove(
	panelId: string | undefined,
	ctx: SkillExecutionContext,
): Promise<SkillResult> {
	if (!panelId) {
		return {
			success: false,
			output: "",
			error: "panelId is required for remove",
		};
	}

	// Find panel directory by id (match panel.json id field)
	if (!existsSync(PANELS_DIR)) {
		return {
			success: false,
			output: "",
			error: `Panel "${panelId}" not found`,
		};
	}

	let found = false;
	for (const entry of readdirSync(PANELS_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(PANELS_DIR, entry.name);
		const manifest = readManifest(dir);
		if (manifest?.id === panelId) {
			rmSync(dir, { recursive: true, force: true });
			found = true;
			break;
		}
	}

	if (!found) {
		return {
			success: false,
			output: "",
			error: `Panel "${panelId}" not found in ${PANELS_DIR}`,
		};
	}

	ctx.writeLine?.({
		type: "panel_control",
		requestId: ctx.requestId ?? "unknown",
		action: "reload",
	});

	return { success: true, output: `Removed panel "${panelId}"` };
}

export function createPanelSkill(): SkillDefinition {
	return {
		name: `skill_${panelDescriptor.name}`,
		description: panelDescriptor.description,
		parameters: panelDescriptor.inputSchema,
		tier: 1, // descriptor.tier = "T1"
		requiresGateway: false,
		source: "built-in",
		execute: async (args, ctx): Promise<SkillResult> => {
			const action = args.action as string;
			switch (action) {
				case "list":
					return actionList();
				case "switch":
					return actionSwitch(args.panelId as string | undefined, ctx);
				case "install":
					return actionInstall(args.source as string | undefined, ctx);
				case "remove":
					return actionRemove(args.panelId as string | undefined, ctx);
				default:
					return {
						success: false,
						output: "",
						error: `Unknown action: ${action}`,
					};
			}
		},
	};
}
