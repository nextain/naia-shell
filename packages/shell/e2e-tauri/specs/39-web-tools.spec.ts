import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 39 — Web Tools E2E
 *
 * Verifies web Gateway tools:
 * - browser: fetch web page content
 * - web_search: search the web
 *
 * Covers RPC: skills.invoke (browser), browser.request
 */
describe("39 — web tools", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["browser", "web_search"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should fetch a web page via browser tool", async () => {
		await sendMessage("https://example.com 웹페이지를 browser 도구로 읽어줘.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"https://example.com 웹페이지를 browser 도구로 읽어줘",
			"AI가 browser으로 웹페이지 읽기를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 웹페이지 내용을 보여주거나 접근 결과를 안내하면 PASS",
		);
	});

	it("should perform a web search via web_search tool", async () => {
		await sendMessage("'Naia' 키워드로 웹 검색해줘. web_search 도구를 사용해.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"'Naia' 키워드로 웹 검색해줘 (web_search)",
			"AI가 web_search으로 웹 검색을 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 검색 결과를 보여주거나 검색 시도에 대해 안내하면 PASS",
		);
	});
});
