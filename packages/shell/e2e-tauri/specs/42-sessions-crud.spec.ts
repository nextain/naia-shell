import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";

/**
 * 42 — 세션 대화록이 실제로 남는다 (재조준, #567)
 *
 * 이 스펙은 preview/patch/reset 도구의 동작을 검증하지 않는다. 현재 대화 경로에서
 * 에이전트의 `ConversationLogPort` 가 `<ADK>/conversations/<sessionId>.jsonl` 에
 * 한 줄씩 덧붙여 남기는 기록만 확인한다(`conversation-log-store.ts`, append-only
 * JSONL, 1줄 = 1메시지).
 *
 * 그래서 여기서는 도구 이름이나 다른 세션 파일의 크기를 추측하지 않고, 이번 테스트가
 * 보낸 고유 user marker가 들어간 파일을 고정한 뒤 그 파일의 append만 잰다.
 */
const adkPath = process.env.NAIA_E2E_ADK_PATH;

function transcriptFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

function readTurns(path: string): { role: string; content: string }[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as { role: string; content: string });
}

/** 이번 테스트의 고유 user marker가 들어간 대화록 경로를 찾는다. */
function transcriptForUserMarker(
	dir: string,
	marker: string,
): string | undefined {
	const files = transcriptFiles(dir);
	return files
		.map((name) => resolve(dir, name))
		.find((path) =>
			readTurns(path).some(
				(turn) => turn.role === "user" && turn.content.includes(marker),
			),
		);
}

function userTurnIndex(
	turns: { role: string; content: string }[],
	marker: string,
	from = 0,
): number {
	return turns.findIndex(
		(turn, index) =>
			index >= from && turn.role === "user" && turn.content.includes(marker),
	);
}

function hasNonEmptyAssistantAfter(
	turns: { role: string; content: string }[],
	userIndex: number,
): boolean {
	return (
		userIndex >= 0 &&
		turns
			.slice(userIndex + 1)
			.some(
				(turn) =>
					turn.role === "assistant" &&
					typeof turn.content === "string" &&
					turn.content.trim().length > 0,
			)
	);
}

describe("42 — 세션 대화록(ConversationLogPort)", () => {
	let dispose: (() => void) | undefined;
	let conversationsDir: string;
	let pinnedTranscript: string | undefined;

	before(async () => {
		if (!adkPath) throw new Error("NAIA_E2E_ADK_PATH is required");
		conversationsDir = resolve(adkPath, "conversations");
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("대화 한 턴이 세션 대화록에 남는다", async () => {
		const marker = `세션 기록 확인 ${Date.now()}`;
		await sendMessage(marker);

		await browser.waitUntil(
			async () => {
				pinnedTranscript = transcriptForUserMarker(conversationsDir, marker);
				return pinnedTranscript !== undefined;
			},
			{
				timeout: 30_000,
				timeoutMsg: `대화록에 이번 턴이 남지 않았다 (${conversationsDir})`,
			},
		);

		const path = pinnedTranscript;
		if (!path) throw new Error("이번 턴의 대화록 경로를 고정하지 못했다");
		await browser.waitUntil(
			async () => {
				const turns = readTurns(path);
				return hasNonEmptyAssistantAfter(turns, userTurnIndex(turns, marker));
			},
			{
				timeout: 30_000,
				timeoutMsg:
					"이번 user 뒤에 비어 있지 않은 assistant 응답이 남지 않았다",
			},
		);

		const turns = readTurns(path);
		const currentUserIndex = userTurnIndex(turns, marker);
		expect(currentUserIndex).toBeGreaterThanOrEqual(0);
		expect(hasNonEmptyAssistantAfter(turns, currentUserIndex)).toBe(true);
	});

	it("다음 턴이 같은 세션 파일에 이어 붙는다 — 덮어쓰지 않는다", async () => {
		const path = pinnedTranscript;
		if (!path) throw new Error("첫 턴의 대화록 경로가 고정되지 않았다");
		const beforeRaw = readFileSync(path, "utf8");
		const before = readTurns(path);
		const marker = `이어 붙는지 확인 ${Date.now()}`;

		await sendMessage(marker);

		await browser.waitUntil(
			async () => {
				const turns = readTurns(path);
				const currentUserIndex = userTurnIndex(turns, marker, before.length);
				return hasNonEmptyAssistantAfter(turns, currentUserIndex);
			},
			{
				timeout: 30_000,
				timeoutMsg:
					"다음 턴이 같은 대화록에 user 뒤 비어 있지 않은 assistant로 이어 붙지 않았다",
			},
		);

		const afterRaw = readFileSync(path, "utf8");
		const after = readTurns(path);
		// append-only 계약: 앞의 내용이 그대로 있고 뒤로만 늘어난다.
		expect(afterRaw.startsWith(beforeRaw)).toBe(true);
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.length).toBeGreaterThan(before.length);
		const currentUserIndex = userTurnIndex(after, marker, before.length);
		expect(currentUserIndex).toBeGreaterThanOrEqual(before.length);
		expect(hasNonEmptyAssistantAfter(after, currentUserIndex)).toBe(true);
	});
});
