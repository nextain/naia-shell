/**
 * Poll for permission modals and auto-approve them (click "Always").
 * Uses browser.execute for reliable DOM clicks in WebKitGTK.
 * Returns a dispose function to stop polling.
 */
export function autoApprovePermissions(): { dispose: () => void } {
	let running = true;

	const poll = async () => {
		while (running) {
			try {
				const clicked = await browser.execute(() => {
					const btn = document.querySelector(
						".permission-btn-always",
					) as HTMLElement | null;
					if (btn && btn.offsetParent !== null) {
						btn.click();
						return true;
					}
					return false;
				});
				if (clicked) {
					await browser.pause(200);
				}
				// ⚠️ browser.pause 를 try 안으로 — 이 폴은 dispose 가 안 불리면 세션 종료(teardown) 후에도
				// 돈다. 세션이 죽으면 pause 가 reject 하는데, try 밖이면 `void poll()` 의 unhandled rejection 이
				// 되어 wdio 워커가 크래시했다("FAILED in undefined", 테스트 결과 미기록 — 01/90 systemic 원인). 흡수.
				await browser.pause(500);
			} catch {
				// 세션 navigating/종료 — 예상됨. 흡수(unhandled rejection 방지로 워커 보호).
			}
		}
	};

	void poll();

	return {
		dispose() {
			running = false;
		},
	};
}
