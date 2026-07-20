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

describe("Shell main/sub/memory 역할 설정", () => {
	it("legacy memory는 memory로 보존되고 sub에서만 legacy 상속한다", () => {
		const configured = readConfiguredLlmRoles(base());
		expect(configured.memory?.provider).toBe("ollama");
		expect(configured.sub).toEqual({ inherit: "memory" });
		const result = resolveEffectiveLlmRoles(base());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.roles[0].provider).toBe("codex");
		expect(result.roles[1].provenance).toBe("legacy-inherit");
		expect(result.roles[2].provider).toBe("ollama");
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
		expect(result.roles.map((role) => role.provider)).toEqual(["codex", "nextain", "ollama"]);
	});

	it("memory=sub 상속과 provider role capability를 판정한다", () => {
		let config = writeConfiguredLlmRole(base(), "sub", { provider: "ollama", model: "small" });
		config = writeConfiguredLlmRole(config, "memory", { inherit: "sub" });
		const inherited = resolveEffectiveLlmRoles(config);
		expect(inherited.ok && inherited.roles[2]).toMatchObject({
			provider: "ollama",
			provenance: "inherit",
			inheritedFromRole: "sub",
		});

		const unsupported = writeConfiguredLlmRole(config, "sub", { provider: "codex", model: "gpt-5.4" });
		expect(resolveEffectiveLlmRoles(unsupported)).toEqual({ ok: false, role: "sub", reason: "unsupported" });
	});
});
