import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";

describe("11 — Cost Dashboard", () => {
	before(async () => {
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should show cost badge after a message exchange", async () => {
		// Send a message to generate cost data
		await sendMessage("비용 테스트 메시지");
		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"사용자가 '비용 테스트 메시지'라고 보냈다",
			"AI가 적절히 응답했는가? 에러 메시지나 빈 응답은 FAIL",
		);

		// Cost badge should appear (shows session cost)
		await browser.waitUntil(
			async () => {
				return browser.execute(
					(sel: string) => !!document.querySelector(sel),
					S.costBadge,
				);
			},
			{
				timeout: 10_000,
				timeoutMsg: "Cost badge did not appear after message exchange",
			},
		);
	});

	it("should toggle cost dashboard on badge click", async () => {
		// Click cost badge to open dashboard
		const costBadge = await $(S.costBadge);
		await costBadge.click();

		// Cost dashboard should appear
		const dashboard = await $(S.costDashboard);
		await dashboard.waitForDisplayed({ timeout: 10_000 });

		// Cost table should be present
		const hasTable = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.costTable,
		);
		expect(hasTable).toBe(true);
	});

	it("should display cost data in table", async () => {
		// Table should have rows (thead + at least 1 tbody row + tfoot)
		const rowCount = await browser.execute(() => {
			const table = document.querySelector(".cost-table");
			if (!table) return 0;
			return table.querySelectorAll("tr").length;
		});
		// At least: 1 header + 1 data + 1 footer = 3 rows
		expect(rowCount).toBeGreaterThanOrEqual(3);
	});

	it("should show Lab balance section when naiaKey is set", async () => {
		// Dashboard is currently open from previous test — close it first
		const costBadge = await $(S.costBadge);
		await costBadge.click();
		await browser.waitUntil(
			async () => {
				return browser.execute(
					(sel: string) => !document.querySelector(sel),
					S.costDashboard,
				);
			},
			{ timeout: 5_000 },
		);

		// Re-open dashboard
		await costBadge.click();

		const dashboard = await $(S.costDashboard);
		await dashboard.waitForDisplayed({ timeout: 10_000 });

		// 나이아 키는 이제 localStorage 가 아니라 보안 저장소에 있어, 예전처럼
		// naia-config 에 키를 끼워 넣어도 대시보드는 모른다. 대시보드는 열릴 때
		// 보안 저장소를 한 번 묻고, 로그인이 끝나면 오는 `naia_auth_ready` 신호로
		// 잔액 칸을 연다. 첫 조회가 끝난 뒤 그 신호를 보내 로그인 직후를 흉내 낸다.
		await browser.pause(1_000);
		await browser.execute(() => {
			window.dispatchEvent(new Event("naia_auth_ready"));
		});

		// Lab balance section should be visible (loading, error, or content)
		await browser.waitUntil(
			() =>
				browser.execute(
					(sel: string) => !!document.querySelector(sel),
					S.labBalanceRow,
				),
			{
				timeout: 5_000,
				timeoutMsg: "Lab balance row did not appear after naia_auth_ready",
			},
		);
	});

	it("should close cost dashboard on second badge click", async () => {
		const costBadge = await $(S.costBadge);
		await costBadge.click();

		// Dashboard should disappear
		await browser.waitUntil(
			async () => {
				return browser.execute(
					(sel: string) => !document.querySelector(sel),
					S.costDashboard,
				);
			},
			{ timeout: 5_000, timeoutMsg: "Cost dashboard did not close" },
		);
	});
});
