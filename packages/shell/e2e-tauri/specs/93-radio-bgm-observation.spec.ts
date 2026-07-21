async function tauriInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
	return (await browser.execute(
		async (cmd: string, commandArgs: Record<string, unknown>) => {
			const w = window as unknown as {
				__TAURI_INTERNALS__?: { invoke: (name: string, input: unknown) => Promise<unknown> };
				__TAURI__?: { core?: { invoke: (name: string, input: unknown) => Promise<unknown> } };
			};
			const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
			if (!invoke) throw new Error("Tauri invoke is unavailable");
			return invoke(cmd, commandArgs);
		},
		command,
		args,
	)) as T;
}

describe("Radio BGM observation through the real Tauri Shell", () => {
	it("does not announce a requested track until the local iframe reports playing", async () => {
		await browser.waitUntil(
			() => browser.execute(() => document.querySelector(".bgm-player") !== null),
			{ timeout: 30_000, timeoutMsg: "BGM player did not render" },
		);

		await tauriInvoke("e2e_emit_bgm_play_request", {
			videoId: "e2e-radio-fixture",
			title: "E2E Radio Fixture Track",
		});

		const player = await $(".bgm-player");
		await browser.waitUntil(
			async () => (await player.getAttribute("data-bgm-playback-status")) === "loading",
			{ timeout: 30_000, timeoutMsg: "local iframe never reported initial delivery" },
		);
		expect(await player.getAttribute("data-bgm-announced-title")).toBe("");
		expect(await $(".bgm-icon").getAttribute("class")).not.toContain("bgm-icon--playing");

		const iframe = await $(".app-bg-iframe");
		await iframe.waitForExist({ timeout: 30_000 });
		expect(await iframe.getAttribute("src")).toContain("/e2e/bgm-playback-fixture.html");
		await browser.switchToFrame(iframe);
		await $("#report-playing").click();
		await browser.switchToParentFrame();

		await browser.waitUntil(
			async () =>
				(await player.getAttribute("data-bgm-playback-status")) === "playing" &&
				(await player.getAttribute("data-bgm-announced-title")) === "E2E Radio Fixture Track",
			{ timeout: 30_000, timeoutMsg: "observed iframe playing event did not unlock the BGM title" },
		);
		expect(await $(".bgm-icon").getAttribute("class")).toContain("bgm-icon--playing");
	});
});
