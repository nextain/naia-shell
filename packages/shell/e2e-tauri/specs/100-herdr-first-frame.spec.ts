import { clickElement } from "../helpers/click.js";

describe("100 — Herdr first frame", () => {
	it("renders the native PTY surface without falling into the no-frame retry loop", async () => {
		// 앱바가 뜨기를 기다렸다가 누른다. 기다리지 않고 바로 찾으면 셸이
		// 아직 그리는 중일 때 "버튼이 없다" 로 죽는다 — 실제로 그 자리에서
		// 실패했고, 버튼 자체는 멀쩡히 있다.
		await clickElement('button[data-app-id="workspace"]', 20_000);

		await browser.waitUntil(
			async () =>
				browser.execute(() => {
					const terminal = document.querySelector(
						".herdr-workspace__terminal-layer .xterm",
					);
					const overlay = document.querySelector(
						".herdr-workspace__state--overlay",
					);
					return Boolean(terminal) && !overlay;
				}),
			{
				timeout: 45_000,
				timeoutMsg: "Herdr PTY never delivered its first frame to xterm",
			},
		);

		// Cross the production 8-second no-frame watchdog boundary. A transient
		// first event must not be followed by the retry overlay reappearing.
		await browser.pause(8_500);
		const state = await browser.execute(() => ({
			hasTerminal: Boolean(
				document.querySelector(".herdr-workspace__terminal-layer .xterm"),
			),
			error: document
				.querySelector(".herdr-workspace__state--overlay")
				?.textContent?.trim(),
		}));
		expect(state.hasTerminal).toBe(true);
		// `browser.execute` 는 `undefined` 를 JSON 으로 실어 오며 `null` 로 바꾼다.
		// `toBeUndefined()` 로 재면 오버레이가 **없을 때에도** 붉어져, 이 스펙은
		// 어느 실행에서도 통과할 수 없었다(실측: 격리 전후 두 실행 모두 같은 자리).
		expect(state.error ?? null).toBeNull();
	});
});
