import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { memoDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition } from "../types.js";

function sanitizeKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function createMemoSkill(memoDir?: string): SkillDefinition {
	const dir = memoDir ?? path.join(os.homedir(), ".naia", "memos");

	return {
		name: `skill_${memoDescriptor.name}`,
		description: memoDescriptor.description,
		parameters: memoDescriptor.inputSchema,
		tier: 1,
		requiresGateway: false,
		source: "built-in",
		execute: async (args) => {
			const action = args.action as string;
			const rawKey = args.key as string | undefined;

			switch (action) {
				case "save": {
					if (!rawKey) {
						return {
							success: false,
							output: "",
							error: "key is required for save",
						};
					}
					const key = sanitizeKey(rawKey);
					const content = (args.content as string) ?? "";
					fs.mkdirSync(dir, { recursive: true });
					fs.writeFileSync(path.join(dir, `${key}.txt`), content, "utf-8");
					return { success: true, output: `Memo saved: ${key}` };
				}

				case "read": {
					if (!rawKey) {
						return {
							success: false,
							output: "",
							error: "key is required for read",
						};
					}
					const key = sanitizeKey(rawKey);
					const filePath = path.join(dir, `${key}.txt`);
					if (!fs.existsSync(filePath)) {
						return {
							success: false,
							output: "",
							error: `Memo not found: ${key}`,
						};
					}
					const content = fs.readFileSync(filePath, "utf-8");
					return { success: true, output: content };
				}

				case "list": {
					if (!fs.existsSync(dir)) {
						return { success: true, output: "[]" };
					}
					const files = fs.readdirSync(dir);
					const keys = files
						.filter((f) => f.endsWith(".txt"))
						.map((f) => f.replace(/\.txt$/, ""));
					return { success: true, output: JSON.stringify(keys) };
				}

				case "delete": {
					if (!rawKey) {
						return {
							success: false,
							output: "",
							error: "key is required for delete",
						};
					}
					const key = sanitizeKey(rawKey);
					const filePath = path.join(dir, `${key}.txt`);
					if (fs.existsSync(filePath)) {
						fs.unlinkSync(filePath);
					}
					return { success: true, output: `Memo deleted: ${key}` };
				}

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
