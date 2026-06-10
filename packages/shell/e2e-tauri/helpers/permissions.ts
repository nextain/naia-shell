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
			} catch {
				// Browser not ready or navigating — expected during page transitions
			}
			await browser.pause(500);
		}
	};

	void poll();

	return {
		dispose() {
			running = false;
		},
	};
}
