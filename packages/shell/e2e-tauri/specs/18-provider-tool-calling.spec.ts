import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

type SkillTimeObservation = {
	status: "running" | "success" | "error";
	output: string;
};

async function countToolActivities(): Promise<number> {
	return browser.execute(
		() => document.querySelectorAll(".tool-activity").length,
	);
}

/**
 * Require a new, successful skill_time activity and inspect its tool output.
 * The DOM count is captured before the request so an activity left by an
 * earlier test cannot satisfy this request. The assistant's answer is checked
 * separately below; this output is the tool result rendered by ToolActivity.
 */
async function waitForCurrentSkillTimeResult(
	beforeToolCount: number,
): Promise<string> {
	let expansionRequested = false;
	let observation: SkillTimeObservation | null = null;

	await browser.waitUntil(
		async () => {
			observation = await browser.execute(
				(baseCount: number): SkillTimeObservation | null => {
					const activities = Array.from(
						document.querySelectorAll<HTMLElement>(".tool-activity"),
					);
					const freshSkillTime = activities
						.slice(baseCount)
						.filter((activity) => activity.dataset.toolName === "skill_time");
					if (freshSkillTime.length === 0) return null;

					// A failed current invocation must not be hidden by a later answer or
					// by a successful activity from an earlier request.
					if (
						freshSkillTime.some((activity) =>
							activity.classList.contains("tool-error"),
						)
					) {
						return { status: "error", output: "" };
					}

					const latest = freshSkillTime[freshSkillTime.length - 1];
					if (!latest) return null;
					const status = latest.classList.contains("tool-success")
						? "success"
						: latest.classList.contains("tool-error")
							? "error"
							: "running";
					return {
						status,
						output:
							latest
								.querySelector<HTMLElement>(".tool-output")
								?.textContent?.trim() ?? "",
					};
				},
				beforeToolCount,
			);

			if (observation?.status === "error") {
				throw new Error(
					`Current skill_time activity failed (beforeToolCount=${beforeToolCount})`,
				);
			}

			if (
				observation?.status === "success" &&
				!observation.output &&
				!expansionRequested
			) {
				expansionRequested = true;
				await browser.execute((baseCount: number) => {
					const activities = Array.from(
						document.querySelectorAll<HTMLElement>(".tool-activity"),
					);
					const freshSkillTime = activities
						.slice(baseCount)
						.filter((activity) => activity.dataset.toolName === "skill_time");
					const latest = freshSkillTime[freshSkillTime.length - 1];
					latest?.querySelector<HTMLButtonElement>("button")?.click();
				}, beforeToolCount);
			}

			return observation?.status === "success" && observation.output.length > 0;
		},
		{
			timeout: 60_000,
			timeoutMsg: `A fresh successful skill_time result with output did not appear (beforeToolCount=${beforeToolCount})`,
		},
	);

	const finalObservation = observation as SkillTimeObservation | null;
	if (!finalObservation?.output) {
		throw new Error(
			"skill_time succeeded but returned no rendered tool output",
		);
	}
	return finalObservation.output;
}

/**
 * 18 — Provider tool calling
 *
 * Verifies that tool calling works with the current provider (Gemini).
 * Ensures enableTools is set and skills are visible to the LLM.
 */
describe("18 — provider tool calling", () => {
	before(async () => {
		await enableToolsForSpec(["skill_time"]);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should execute skill_time via tool calling and return time", async () => {
		const beforeToolCount = await countToolActivities();
		await sendMessage(
			"지금 몇 시야? 반드시 skill_time 도구를 사용해서 알려줘.",
		);

		const toolOutput = await waitForCurrentSkillTimeResult(beforeToolCount);
		if (!/\b\d{1,2}:\d{2}\b/.test(toolOutput)) {
			throw new Error(
				`skill_time returned a successful activity without a time value: ${toolOutput}`,
			);
		}

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_time 도구를 사용해서 현재 시각을 알려달라고 했다",
			"AI가 실제 시간 정보를 제공했는가? '도구를 찾을 수 없다/실행할 수 없다'면 FAIL. 시:분 형태의 실제 시각이 포함되어야 PASS",
		);
	});
});
