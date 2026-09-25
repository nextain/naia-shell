import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { openSettingsSection } from "../helpers/settings.js";

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

		// 나이아 키는 이제 localStorage 가 아니라 ADK 보안 저장소에 있고, 잔액 칸은
		// 그 저장소에 키가 있을 때만 그려진다. 예전처럼 naia-config 에 가짜 키를
		// 끼워 넣어도 대시보드는 모른다. 실제 로그인과 같은 길을 탄다 — 설정이
		// 떠 있는 동안 naia_auth_complete 를 받으면 설정이 키를 보안 저장소에 넣고
		// naia_auth_ready 를 알린다(SettingsTab 의 로그인 콜백).
		const naiaKey = process.env.NAIA_API_KEY ?? "";
		if (!naiaKey) throw new Error("NAIA_API_KEY is required for the Lab balance check");
		await openSettingsSection("brain");
		await browser.execute(async (key: string) => {
			(window as unknown as { __naiaE2eAuthReady?: boolean }).__naiaE2eAuthReady = false;
			window.addEventListener(
				"naia_auth_ready",
				() => {
					(window as unknown as { __naiaE2eAuthReady?: boolean }).__naiaE2eAuthReady = true;
				},
				{ once: true },
			);
			const internals = (
				window as unknown as {
					__TAURI_INTERNALS__?: {
						invoke: (cmd: string, args?: unknown) => Promise<unknown>;
					};
				}
			).__TAURI_INTERNALS__;
			if (!internals) throw new Error("Tauri invoke not available");
			await internals.invoke("plugin:event|emit", {
				event: "naia_auth_complete",
				payload: { naiaKey: key, naiaUserId: "e2e-cost-dashboard" },
			});
		}, naiaKey);
		await browser.waitUntil(
			() =>
				browser.execute(
					() =>
						(window as unknown as { __naiaE2eAuthReady?: boolean })
							.__naiaE2eAuthReady === true,
				),
			{ timeout: 30_000, timeoutMsg: "Settings did not finish the Naia login callback" },
		);

		// Back to chat and re-open the dashboard with the stored key
		await browser.execute((sel: string) => {
			(document.querySelector(sel) as HTMLElement | null)?.click();
		}, S.chatTab);
		const badge = await $(S.costBadge);
		await badge.waitForDisplayed({ timeout: 10_000 });
		await badge.click();

		const dashboard = await $(S.costDashboard);
		await dashboard.waitForDisplayed({ timeout: 10_000 });

		// Lab balance section should be visible (loading, error, or content)
		await browser.waitUntil(
			() =>
				browser.execute(
					(sel: string) => !!document.querySelector(sel),
					S.labBalanceRow,
				),
			{
				timeout: 15_000,
				timeoutMsg: "Lab balance row did not appear with a stored Naia key",
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
