import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import {
	readConfiguredLlmRoles,
	resolveEffectiveLlmRoles,
	writeConfiguredLlmRole,
} from "../roles";

const base = (): AppConfig => ({
	provider: "codex",
	model: "gpt-5.4",
	apiKey: "",
	memoryLlmProvider: "ollama",
	memoryLlmModel: "legacy-memory",
	memoryLlmBaseUrl: "http://localhost:11434/v1",
});

describe("Shell expert/main/sub + memory role settings", () => {
	it("legacy memory는 memory로 보존되고 sub에서만 legacy 상속한다", () => {
		const configured = readConfiguredLlmRoles(base());
		expect(configured.memory?.provider).toBe("ollama");
		expect(configured.sub).toEqual({ inherit: "memory" });
		const result = resolveEffectiveLlmRoles(base());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.roles.map((role) => [role.role, role.provider, role.provenance])).toEqual([
			["expert", "codex", "inherit"],
			["main", "codex", "explicit"],
			["sub", "ollama", "legacy-inherit"],
			["memory", "ollama", "explicit"],
		]);
	});

	it("sub와 memory를 독립 저장하고 다른 역할 필드를 덮어쓰지 않는다", () => {
		const withSub = writeConfiguredLlmRole(base(), "sub", {
			provider: "nextain",
			model: "gemini-3.1-flash-lite",
			credentialRef: "sub-ref",
		});
		const withMemory = writeConfiguredLlmRole(withSub, "memory", {
			provider: "ollama",
			model: "qwen3:4b",
			baseUrl: "http://localhost:11434/v1",
		});
		expect(withMemory.provider).toBe("codex");
		expect(withMemory.subLlmProvider).toBe("nextain");
		expect(withMemory.memoryLlmProvider).toBe("ollama");
		const result = resolveEffectiveLlmRoles(withMemory);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.roles.map((role) => role.provider)).toEqual(["codex", "codex", "nextain", "ollama"]);
	});

	it("memory=sub 상속과 provider role capability를 판정한다", () => {
		let config = writeConfiguredLlmRole(base(), "sub", { provider: "ollama", model: "small" });
		config = writeConfiguredLlmRole(config, "memory", { inherit: "sub" });
		const inherited = resolveEffectiveLlmRoles(config);
		expect(inherited.ok && inherited.roles[3]).toMatchObject({
			provider: "ollama",
			provenance: "inherit",
			inheritedFromRole: "sub",
		});

		const unsupported = writeConfiguredLlmRole(config, "memory", { provider: "codex", model: "gpt-5.4" });
		expect(resolveEffectiveLlmRoles(unsupported)).toEqual({ ok: false, role: "memory", reason: "unsupported" });
	});

	it("main-only legacy configuration defaults expert/sub from main and memory from sub", () => {
		// #602: 타사 직결 공급자는 제거됐다 — 모든 역할을 지원하는 로컬(ollama)로 검증한다.
		const config: AppConfig = { provider: "ollama", model: "qwen3:8b", apiKey: "" };
		expect(readConfiguredLlmRoles(config)).toEqual({
			expert: { inherit: "main" },
			main: { provider: "ollama", model: "qwen3:8b" },
			sub: { inherit: "main" },
			memory: { inherit: "sub" },
		});
		const resolved = resolveEffectiveLlmRoles(config);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.roles.map((role) => [role.role, role.provider, role.provenance, role.inheritedFromRole])).toEqual([
			["expert", "ollama", "inherit", "main"],
			["main", "ollama", "explicit", undefined],
			["sub", "ollama", "inherit", "main"],
			["memory", "ollama", "inherit", "sub"],
		]);
	});
});
