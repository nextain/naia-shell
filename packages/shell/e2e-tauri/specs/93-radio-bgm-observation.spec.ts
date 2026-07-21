async function tauriInvoke<T>(
	command: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	return (await browser.execute(
		async (cmd: string, commandArgs: Record<string, unknown>) => {
			const w = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (name: string, input: unknown) => Promise<unknown>;
				};
				__TAURI__?: {
					core?: { invoke: (name: string, input: unknown) => Promise<unknown> };
				};
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
	it("starts the shell-owned BGM sidecar before the player uses it", async () => {
		// Query from the WDIO Node runner so this check observes the real local
		// process without coupling sidecar readiness to the test Vite origin's
		// browser CORS policy.
		const response = await fetch("http://127.0.0.1:18791/health");
		const body: unknown = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ ok: true });
	});

	it("does not announce a requested track until the local iframe reports playing", async () => {
		await browser.waitUntil(
			() =>
				browser.execute(() => document.querySelector(".bgm-player") !== null),
			{ timeout: 30_000, timeoutMsg: "BGM player did not render" },
		);

		await tauriInvoke("e2e_emit_bgm_play_request", {
			videoId: "e2e-radio-fixture",
			title: "E2E Radio Fixture Track",
		});

		const player = await $(".bgm-player");
		await browser.waitUntil(
			async () =>
				(await player.getAttribute("data-bgm-playback-status")) === "loading",
			{
				timeout: 30_000,
				timeoutMsg: "local iframe never reported initial delivery",
			},
		);
		expect(await player.getAttribute("data-bgm-announced-title")).toBe("");
		expect(await $(".bgm-icon").getAttribute("class")).not.toContain(
			"bgm-icon--playing",
		);

		const iframe = await $(".app-bg-iframe");
		await iframe.waitForExist({ timeout: 30_000 });
		expect(await iframe.getAttribute("src")).toContain(
			"/e2e/bgm-playback-fixture.html",
		);
		await browser.switchToFrame(iframe);
		await $("#report-playing").click();
		await browser.switchToParentFrame();

		await browser.waitUntil(
			async () =>
				(await player.getAttribute("data-bgm-playback-status")) === "playing" &&
				(await player.getAttribute("data-bgm-announced-title")) ===
					"E2E Radio Fixture Track",
			{
				timeout: 30_000,
				timeoutMsg:
					"observed iframe playing event did not unlock the BGM title",
			},
		);
		expect(await $(".bgm-icon").getAttribute("class")).toContain(
			"bgm-icon--playing",
		);
	});

	it("keeps track B pending when the detached track A iframe reports a late error", async () => {
		await tauriInvoke("e2e_emit_bgm_play_request", {
			videoId: "e2e-radio-track-a",
			title: "E2E Radio Track A",
		});
		await browser.waitUntil(
			async () =>
				(await $(".app-bg-iframe").getAttribute("src"))?.includes(
					"videoId=e2e-radio-track-a",
				) ?? false,
			{ timeout: 30_000, timeoutMsg: "track A iframe did not mount" },
		);
		await browser.execute(() => {
			const iframe = document.querySelector(
				".app-bg-iframe",
			) as HTMLIFrameElement | null;
			if (!iframe?.contentWindow)
				throw new Error("track A iframe window unavailable");
			(
				window as typeof window & { __naiaE2eOldBgmFrame?: Window }
			).__naiaE2eOldBgmFrame = iframe.contentWindow;
		});

		await tauriInvoke("e2e_emit_bgm_play_request", {
			videoId: "e2e-radio-track-b",
			title: "E2E Radio Track B",
		});
		await browser.waitUntil(
			async () =>
				(await $(".app-bg-iframe").getAttribute("src"))?.includes(
					"videoId=e2e-radio-track-b",
				) ?? false,
			{ timeout: 30_000, timeoutMsg: "track B iframe did not replace track A" },
		);
		const player = await $(".bgm-player");
		await browser.waitUntil(
			async () =>
				(await player.getAttribute("data-bgm-playback-status")) === "loading",
			{ timeout: 30_000, timeoutMsg: "track B did not enter observed loading" },
		);

		await browser.execute(() => {
			const oldFrame = (
				window as typeof window & { __naiaE2eOldBgmFrame?: Window }
			).__naiaE2eOldBgmFrame;
			if (!oldFrame)
				throw new Error("stored track A iframe window unavailable");
			oldFrame.postMessage("e2e-report-error", window.location.origin);
		});
		await browser.pause(250);

		expect(await player.getAttribute("data-bgm-playback-status")).toBe(
			"loading",
		);
		expect(await player.getAttribute("data-bgm-announced-title")).toBe("");
		await browser.execute(() => {
			(
				window as typeof window & { __naiaE2eOldBgmFrame?: Window }
			).__naiaE2eOldBgmFrame = undefined;
		});
	});

	it("changes playing state only after the active iframe confirms pause or resume", async () => {
		await tauriInvoke("e2e_emit_bgm_play_request", {
			videoId: "e2e-radio-observed-controls",
			title: "E2E Radio Observed Controls",
		});
		const iframe = await $(".app-bg-iframe");
		await iframe.waitForExist({ timeout: 30_000 });
		await browser.waitUntil(
			async () =>
				(await iframe.getAttribute("src"))?.includes(
					"videoId=e2e-radio-observed-controls",
				) ?? false,
			{ timeout: 30_000, timeoutMsg: "control test iframe did not mount" },
		);
		await browser.switchToFrame(iframe);
		await $("#report-playing").click();
		await browser.switchToParentFrame();

		const player = await $(".bgm-player");
		await browser.waitUntil(
			async () =>
				(await player.getAttribute("data-bgm-playback-status")) === "playing",
			{
				timeout: 30_000,
				timeoutMsg: "fixture playing confirmation was not observed",
			},
		);
		const control = await $(".bgm-btn--play");
		await control.click();
		await browser.pause(250);
		expect(await $(".bgm-icon").getAttribute("class")).toContain(
			"bgm-icon--playing",
		);
		expect(await player.getAttribute("data-bgm-playback-status")).toBe(
			"playing",
		);

		await browser.switchToFrame(iframe);
		await $("#report-paused").click();
		await browser.switchToParentFrame();
		await browser.waitUntil(
			async () =>
				(await player.getAttribute("data-bgm-playback-status")) === "paused",
			{
				timeout: 30_000,
				timeoutMsg: "fixture pause confirmation was not observed",
			},
		);
		expect(await $(".bgm-icon").getAttribute("class")).not.toContain(
			"bgm-icon--playing",
		);

		await control.click();
		await browser.pause(250);
		expect(await $(".bgm-icon").getAttribute("class")).not.toContain(
			"bgm-icon--playing",
		);
		expect(await player.getAttribute("data-bgm-playback-status")).toBe(
			"paused",
		);
	});
});
