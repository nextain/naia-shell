import {
	countCompletedAssistantMessages,
	getLastAssistantMessage,
	getLastToolName,
	sendMessage,
} from "../helpers/chat.js";
import { assertSemantic } from "../helpers/semantic.js";
import { persistConfigPatch, safeRefresh } from "../helpers/settings.js";

const BUILTIN_SKILLS = [
	"skill_time",
	"skill_system_status",
	"skill_memo",
	"skill_weather",
	"skill_notify_slack",
];

function formatKstTime(date: Date): string {
	// 자정을 넘는 구간도 판정 모델이 읽도록 날짜를 붙인다(예: 2026-09-26 23:58).
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Seoul",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

async function countSuccessfulSkillTimeActivities(): Promise<number> {
	return browser.execute(() => {
		return document.querySelectorAll(
			'.tool-activity.tool-success[data-tool-name="get_time"]',
		).length;
	});
}

async function waitForSkillTimeConfigRehydration(): Promise<void> {
	await browser.waitUntil(
		async () =>
			browser.execute(() => {
				const raw = localStorage.getItem("naia-config");
				if (!raw) return false;
				try {
					const config = JSON.parse(raw) as {
						enableTools?: unknown;
						disabledSkills?: unknown;
					};
					const disabledSkills = Array.isArray(config.disabledSkills)
						? config.disabledSkills.filter(
								(name): name is string => typeof name === "string",
							)
						: [];
					return (
						config.enableTools === true &&
						!disabledSkills.includes("skill_time")
					);
				} catch {
					return false;
				}
			}),
		{
			timeout: 15_000,
			timeoutMsg:
				"Selected ADK did not rehydrate enableTools or skill_time after refresh",
		},
	);
}

async function waitForCurrentSkillTimeSuccess(
	beforeToolCount: number,
	beforeAssistantCount: number,
): Promise<void> {
	await browser.waitUntil(
		async () => {
			const [toolCount, assistantCount] = await Promise.all([
				countSuccessfulSkillTimeActivities(),
				countCompletedAssistantMessages(),
			]);
			return (
				toolCount > beforeToolCount && assistantCount > beforeAssistantCount
			);
		},
		{
			timeout: 60_000,
			timeoutMsg:
				"A new successful skill_time activity and assistant turn did not appear",
		},
	);
}

describe("04 — skill_time", () => {
	before(async () => {
		// 하네스(wdio.conf.ts)가 늘 격리 ADK 를 만든다. 예전의 Gemini 직결 대안은
		// 그 공급자가 사라진 뒤(#602) 도달할 수 없는 분기였고, 그 키를 요구한다는
		// 이유로 이 스펙이 회귀에서 빠졌다.
		if (!process.env.NAIA_E2E_ADK_PATH?.trim()) {
			throw new Error("NAIA_E2E_ADK_PATH is not set — run through wdio.conf.ts");
		}
		// An explicit ADK is prepared by the caller. Preserve its canonical
		// provider/model/secure credentials and only persist test-safe UI flags
		// through the product's normal config writeback path.
		const patch = await browser.execute((builtinNames: string[]) => {
			const raw = localStorage.getItem("naia-config");
			const previous = raw ? JSON.parse(raw) : {};
			const disabled = Array.isArray(previous.disabledSkills)
				? previous.disabledSkills
				: [];
			const builtins = new Set(builtinNames);
			return {
				enableTools: true,
				onboardingComplete: true,
				disabledSkills: disabled.filter(
					(name: unknown) => typeof name !== "string" || !builtins.has(name),
				),
			};
		}, BUILTIN_SKILLS);
		await persistConfigPatch(patch);
		await safeRefresh();
		await waitForSkillTimeConfigRehydration();
		const chatInput = await $(".chat-input");
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should execute skill_time and return time info", async () => {
		const beforeToolCount = await countSuccessfulSkillTimeActivities();
		const beforeAssistantCount = await countCompletedAssistantMessages();
		let sendTime = new Date();
		await sendMessage(
			"지금 몇 시야? 반드시 get_time 도구를 실제 호출해서 알려줘.",
		);
		let toolOk = true;
		try {
			await waitForCurrentSkillTimeSuccess(
				beforeToolCount,
				beforeAssistantCount,
			);
		} catch {
			toolOk = false;
		}
		if (!toolOk) {
			const retryBeforeToolCount = await countSuccessfulSkillTimeActivities();
			const retryBeforeAssistantCount = await countCompletedAssistantMessages();
			sendTime = new Date();
			await sendMessage(
				"반드시 get_time 도구를 실제 호출해서 현재 시각을 HH:MM 형식으로만 답해.",
			);
			try {
				await waitForCurrentSkillTimeSuccess(
					retryBeforeToolCount,
					retryBeforeAssistantCount,
				);
			} catch {
				const last = await getLastAssistantMessage();
				throw new Error(
					`get_time not executed after retry. last="${last.slice(0, 240)}"`,
				);
			}
		}
		const replyTime = new Date();
		const text = await getLastAssistantMessage();
		expect(text).not.toMatch(
			/\[오류\]|API key not valid|Bad Request|Tool Call:|print\s*\(/i,
		);
		const finalToolCount = await countSuccessfulSkillTimeActivities();
		expect(finalToolCount).toBeGreaterThan(beforeToolCount);
		const lastTool = await getLastToolName();
		expect(lastTool).toBe("get_time");

		const windowStart = new Date(sendTime.getTime() - 2 * 60 * 1000);
		const windowEnd = new Date(replyTime.getTime() + 2 * 60 * 1000);
		const startKst = formatKstTime(windowStart);
		const endKst = formatKstTime(windowEnd);

		await assertSemantic(
			text,
			"get_time 도구를 사용해서 현재 시각을 알려달라고 했다",
			`AI가 KST(한국 표준시, Asia/Seoul) 기준 현재 시각을 올바르게 안내했는가? 허용 시간 범위는 ${startKst}부터 ${endKst}까지(전송 2분 전부터 응답 2분 후까지)이다. 범위는 24시간제이며 12시간제 답은 오전 12시=00시, 오후 12시=12시, 오후 H시=H+12시로 바꿔 비교한다. 날짜는 말하지 않아도 된다. 범위 안의 시각이면 12시간제·24시간제·자연어 어떤 형식이든 PASS. 허용 범위를 벗어난 시각, 오류, 거부, 빈 응답은 FAIL.`,
		);
	});
});
