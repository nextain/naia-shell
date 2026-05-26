import {
	getLastAssistantMessage,
	sendMessage,
	waitForToolSuccess,
} from "../helpers/chat.js";
import { assertSemantic } from "../helpers/semantic.js";
import { safeRefresh } from "../helpers/settings.js";

describe("04 — skill_time", () => {
	before(async () => {
		const apiKey =
			process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";
		const naiaKey = process.env.NAIA_API_KEY || "";
		const gatewayToken =
			process.env.CAFE_GATEWAY_TOKEN ||
			process.env.GATEWAY_MASTER_KEY ||
			"naia-dev-token";
		// Provider routing — prefer Gemini direct (cheapest LIVE) when key is
		// available, fall back to nextain (lab proxy) when only the naia key
		// is present so the spec still runs in NAIA_API_KEY-only setups.
		const useNaia = !apiKey && naiaKey;
		await browser.execute(
			(key: string, naia: string, token: string, naiaMode: boolean) => {
				const raw = localStorage.getItem("naia-config");
				const prev = raw ? JSON.parse(raw) : {};
				const disabled = Array.isArray(prev.disabledSkills)
					? prev.disabledSkills
					: [];
				const builtins = new Set([
					"skill_time",
					"skill_system_status",
					"skill_memo",
					"skill_weather",
					"skill_notify_slack",
					"skill_notify_discord",
					"skill_skill_manager",
				]);
				const config = {
					...prev,
					provider: naiaMode ? "nextain" : "gemini",
					model: prev.model || (naiaMode ? "gemini-2.5-pro" : "gemini-2.5-flash"),
					apiKey: naiaMode ? "" : key || prev.apiKey || "",
					naiaKey: naiaMode ? naia : prev.naiaKey || "",
					enableTools: true,
					gatewayUrl: prev.gatewayUrl || "ws://localhost:18789",
					gatewayToken: token || prev.gatewayToken || "naia-dev-token",
					onboardingComplete: true,
					disabledSkills: disabled.filter((n: string) => !builtins.has(n)),
				};
				localStorage.setItem("naia-config", JSON.stringify(config));
			},
			apiKey,
			naiaKey,
			gatewayToken,
			useNaia,
		);
		await safeRefresh();
		const chatInput = await $(".chat-input");
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should execute skill_time and return time info", async () => {
		await sendMessage(
			"지금 몇 시야? skill_time 도구를 반드시 사용해서 알려줘.",
		);
		let toolOk = true;
		try {
			await waitForToolSuccess();
		} catch {
			toolOk = false;
		}
		if (!toolOk) {
			await sendMessage(
				"반드시 skill_time 도구를 실제 호출해서 현재 시각을 HH:MM 형식으로만 답해.",
			);
			try {
				await waitForToolSuccess();
			} catch {
				const last = await getLastAssistantMessage();
				throw new Error(
					`skill_time not executed after retry. last="${last.slice(0, 240)}"`,
				);
			}
		}
		const text = await getLastAssistantMessage();
		expect(text).not.toMatch(
			/\[오류\]|API key not valid|Bad Request|Tool Call:|print\s*\(/i,
		);
		await assertSemantic(
			text,
			"skill_time 도구를 사용해서 현재 시각을 알려달라고 했다",
			"AI가 실제 시간 정보(시:분 형태)를 제공했는가? '도구를 찾을 수 없다/실행할 수 없다'는 FAIL. 실제 시각 데이터가 포함되어야 PASS",
		);
	});
});
