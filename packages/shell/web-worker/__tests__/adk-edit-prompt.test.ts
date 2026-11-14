import { describe, expect, it } from "vitest";
import {
	type DirLike,
	buildKioskSystemPromptFromSnapshot,
	readAdkSnapshot,
} from "../adk-snapshot-fs";

function dirOver(files: Map<string, string>, prefix: string): DirLike {
	const notFound = () => new DOMException("nf", "NotFoundError");
	return {
		async getDirectoryHandle(name: string) {
			const next = `${prefix}${name}/`;
			if (![...files.keys()].some((k) => k.startsWith(next))) throw notFound();
			return dirOver(files, next);
		},
		async getFileHandle(name: string) {
			const key = `${prefix}${name}`;
			if (!files.has(key)) throw notFound();
			return { async getFile() { return { async text() { return files.get(key) ?? ""; } }; } };
		},
	} as unknown as DirLike;
}

describe("고친 AGENTS.md 가 다음 대답에 반영된다", () => {
	it("naia-adk/AGENTS.md 를 다시 읽은 시스템 글에 고친 내용이 들어간다", async () => {
		const files = new Map([["naia-adk/AGENTS.md", "# 원본"]]);
		const read = () => readAdkSnapshot(async () => dirOver(files, ""));
		expect(buildKioskSystemPromptFromSnapshot(await read())).not.toContain("항상 존댓말.");
		files.set("naia-adk/AGENTS.md", "# 고친 규칙\n항상 존댓말.");
		expect(buildKioskSystemPromptFromSnapshot(await read())).toContain("항상 존댓말.");
	});
});
