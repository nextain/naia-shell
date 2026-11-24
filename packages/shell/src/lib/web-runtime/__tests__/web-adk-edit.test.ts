import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIOSK_AGENTS_MD } from "../../kiosk-demo/knowledge";
import { revertKioskAdkFile, writeKioskAdkFile } from "../web-adk-edit";
import {
	WEB_ADK_EDIT_MAX_BYTES,
	isKioskEditableWebAdkPath,
	isKioskVisibleEntry,
	splitWebAdkPath,
} from "../web-adk-policy";
import type { WebFs } from "../web-fs";

function memoryFs(): WebFs & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		async readText(p) {
			return files.get(p) ?? null;
		},
		async writeBytes(p, d) {
			files.set(p, typeof d === "string" ? d : new TextDecoder().decode(d));
		},
		async exists(p) {
			return files.has(p);
		},
		async ensureDir() {},
	};
}

describe("kiosk ADK 열람·편집 정책", () => {
	beforeEach(() => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("허용 목록 경로만 고칠 수 있고 비공개·이탈 경로는 막는다", () => {
		for (const ok of ["AGENTS.md", "rules/response-rules.md", "knowledge/naia.md", ".agents/context/agents-rules.json", ".users/commands-list.md"])
			expect(isKioskEditableWebAdkPath(`opfs://naia-adk/${ok}`)).toBe(true);
		for (const bad of [
			"naia-settings/config.json",
			"conversations/a.json",
			".bundle/x.json",
			"../x.md",
			"knowledge/../naia-settings/config.json",
			".agents/skills/manage-discord-sessions/SKILL.md",
			"AGENTS.md/x",
		])
			expect(isKioskEditableWebAdkPath(`opfs://naia-adk/${bad}`)).toBe(false);
		expect(splitWebAdkPath("opfs://naia-adk/a\\b")).toBeNull();
		expect(isKioskVisibleEntry("naia-settings", "opfs://naia-adk")).toBe(false);
		expect(isKioskVisibleEntry("AGENTS.md", "opfs://naia-adk")).toBe(true);
	});

	it("크기 상한을 넘기거나 허용 밖이면 쓰지 않는다", async () => {
		const fs = memoryFs();
		await expect(
			writeKioskAdkFile("opfs://naia-adk/AGENTS.md", "x".repeat(WEB_ADK_EDIT_MAX_BYTES + 1), fs),
		).rejects.toThrow("web_workspace_file_too_large");
		await expect(
			writeKioskAdkFile("opfs://naia-adk/naia-settings/config.json", "{}", fs),
		).rejects.toThrow("web_workspace_write_not_allowed");
		expect(fs.files.size).toBe(0);
	});

	it("고친 AGENTS.md 는 지나가 읽는 OPFS 자리(naia-adk/AGENTS.md)에 저장되고, 되돌리면 원본이 된다", async () => {
		const fs = memoryFs();
		await writeKioskAdkFile("opfs://naia-adk/AGENTS.md", "# 고친 규칙\n항상 존댓말.", fs);
		expect(fs.files.get("naia-adk/AGENTS.md")).toContain("항상 존댓말.");
		const restored = await revertKioskAdkFile("opfs://naia-adk/AGENTS.md", fs);
		expect(restored).toBe(KIOSK_AGENTS_MD);
		expect(fs.files.get("naia-adk/AGENTS.md")).toBe(KIOSK_AGENTS_MD);
	});
});
