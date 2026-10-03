import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_TABLE } from "../command-table";

function collectSourceFiles(dir: string, fileList: string[] = []): string[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "__tests__") {
				continue;
			}
			collectSourceFiles(fullPath, fileList);
		} else if (
			entry.isFile() &&
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
		) {
			if (entry.name.includes(".test.") || entry.name.includes(".spec.")) {
				continue;
			}
			fileList.push(fullPath);
		}
	}
	return fileList;
}

function extractCommands(files: string[]): Set<string> {
	const pattern = /invoke(?:<[^>]+>)?\(\s*["'\`]([^"'\`]+)["'\`]/g;
	const commands = new Set<string>();

	for (const file of files) {
		const content = fs.readFileSync(file, "utf-8");
		const lines = content.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (
				trimmed.startsWith("//") ||
				trimmed.startsWith("*") ||
				trimmed.startsWith("/*")
			) {
				continue;
			}
			let match: RegExpExecArray | null = pattern.exec(line);
			while (match !== null) {
				commands.add(match[1]);
				match = pattern.exec(line);
			}
		}
	}
	return commands;
}

describe("command-table", () => {
	it("contains all invoke commands extracted from shell source in the table", () => {
		const srcDir = path.resolve(__dirname, "../../..");
		const sourceFiles = collectSourceFiles(srcDir);
		const extracted = extractCommands(sourceFiles);

		expect(extracted.size).toBeGreaterThanOrEqual(100);

		const missing: string[] = [];
		for (const cmd of extracted) {
			if (!(cmd in COMMAND_TABLE)) {
				missing.push(cmd);
			}
		}

		expect(
			missing,
			`Missing commands in command table: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("has exactly 3 keys classified as 'web'", () => {
		const webKeys = Object.entries(COMMAND_TABLE)
			.filter(([_, value]) => value === "web")
			.map(([key]) => key)
			.sort();

		expect(webKeys).toEqual([
			"plugin:event|emit",
			"plugin:event|listen",
			"plugin:event|unlisten",
		]);
	});
});
