describe("4060 local voice and Ditto avatar through the real Tauri Shell", () => {
	after(async () => {
		// The facade is a real user-owned process, not an E2E fixture. It was
		// pointed at the isolated copied bundle during this acceptance, so restore
		// its configured source before the E2E root is cleaned up.
		const source = process.env.NAIA_E2E_NVA_SOURCE;
		if (!source) return;
		const response = await fetch("http://127.0.0.1:8910/load_nva", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dir: source }),
		});
		if (!response.ok) {
			throw new Error(
				`failed to restore the live NVA after E2E: HTTP ${response.status}`,
			);
		}
	});

	async function tauriInvoke<T>(
		command: string,
		args: Record<string, unknown>,
	): Promise<T> {
		return (await browser.execute(
			async (name: string, payload: Record<string, unknown>) => {
				const w = window as unknown as {
					__TAURI_INTERNALS__?: {
						invoke: (command: string, value: unknown) => Promise<unknown>;
					};
					__TAURI__?: {
						core?: {
							invoke: (command: string, value: unknown) => Promise<unknown>;
						};
					};
				};
				const invoke =
					w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
				if (!invoke) throw new Error("Tauri invoke unavailable");
				return invoke(name, payload);
			},
			command,
			args,
		)) as T;
	}

	it("loads the copied NVA in the live facade and exposes the rendered avatar", async () => {
		await browser.waitUntil(
			() => browser.execute(() => document.querySelector(".app-root") !== null),
			{ timeout: 45_000, timeoutMsg: "Shell app root did not render" },
		);
		// The App listener that reflects persisted settings into its avatar state is
		// registered after the first shell paint.
		await browser.pause(1_000);
		const adkPath = process.env.NAIA_E2E_ADK_PATH;
		expect(adkPath).toBeTruthy();
		const ui = {
			avatarProvider: "naia-video-avatar",
			nvaModel: "naia",
			localGpuTier: "laptop-4060-8g",
			ttsProvider: "naia-local-voice",
			vllmTtsHost: "http://127.0.0.1:8910",
			cascadeRuntimeUrl: "http://127.0.0.1:8910",
		};
		await tauriInvoke("write_naia_ui_config", {
			adkPath: adkPath ?? "",
			json: JSON.stringify(ui),
		});
		await browser.execute((next: Record<string, unknown>) => {
			const current = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			localStorage.setItem(
				"naia-config",
				JSON.stringify({ ...current, ...next, naiaKey: "e2e-local-facade" }),
			);
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
		}, ui);
		await browser.waitUntil(
			() =>
				browser.execute(
					() => document.querySelector("[data-video-avatar]") !== null,
				),
			{
				timeout: 45_000,
				timeoutMsg: "video avatar did not mount after settings update",
			},
		);
		const avatar = await $("[data-video-avatar]");
		await browser.waitUntil(
			async () =>
				(await avatar.getAttribute("data-video-avatar-loaded")) === "true",
			{
				timeout: 90_000,
				timeoutMsg: "4060 cascade never loaded the selected NVA",
			},
		);
		expect(await avatar.getAttribute("data-video-avatar-mode")).toBe("cascade");
		const video = await avatar.$("video");
		await video.waitForExist({ timeout: 30_000 });
		await browser.waitUntil(
			async () => Boolean(await video.getAttribute("src")),
			{
				timeout: 30_000,
				timeoutMsg: "cascade avatar did not receive its idle media",
			},
		);
	});
});
