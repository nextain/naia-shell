import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIP = readFileSync(join(__dirname, "fixtures", "sync-5s-25fps.webm"));
const TAURI_NOOP = `window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_INTERNALS__.invoke = window.__TAURI_INTERNALS__.invoke || (async () => undefined);`;

/**
 * ★NVA 레이어드 플레이어 P3 — A/V 실시간 동기 드라이버.
 *   게이트: 오디오 master clock 대비 head 비디오 drift 를 playbackRate 제어로 수렴시킨다. 헤드리스는 vsync
 *   없어 프레임 제시 지터가 크므로(P0 베이스라인 jitterP95~253ms), 드라이버가 **오프셋(meanSigned)을 baseline
 *   대비 유의하게 줄이고 drift 를 유계로 만드는지**를 측정. (절대 p95<80 목표는 실 디스플레이(WebView2)에서.)
 */
test.describe("NVA P3 — A/V 싱크 드라이버(drift 수렴)", () => {
	test("드라이버가 drift 오프셋을 baseline 대비 수렴시킨다", async ({
		page,
	}) => {
		test.setTimeout(60_000);
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const b64 = CLIP.toString("base64");
		const result = await page.evaluate(async (data: string) => {
			const { NvaSyncDriver } = await import(
				"/src/lib/avatar/nva-sync-driver.ts"
			);
			const { SyncMeter, measureSync } = await import(
				"/src/lib/avatar/nva-sync.ts"
			);
			const bin = atob(data);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const blobUrl = URL.createObjectURL(
				new Blob([bytes], { type: "video/webm" }),
			);

			async function run(useDriver: boolean) {
				const video = document.createElement("video");
				video.muted = true;
				video.playsInline = true;
				video.loop = true;
				video.src = blobUrl;
				video.style.cssText =
					"position:fixed;top:0;left:0;width:160px;height:120px";
				document.body.appendChild(video);

				const AC =
					window.AudioContext ||
					(window as unknown as { webkitAudioContext: typeof AudioContext })
						.webkitAudioContext;
				const ctx = new AC();
				await ctx.resume().catch(() => undefined);

				let audioStart: number | null = null;
				const audioClock = () =>
					audioStart == null ? null : ctx.currentTime - audioStart;

				await new Promise<void>((res) => {
					video.addEventListener(
						"playing",
						() => {
							audioStart = ctx.currentTime;
							res();
						},
						{ once: true },
					);
					void video.play().catch(() => res());
				});

				let stats: ReturnType<SyncMeter["stats"]>;
				if (useDriver) {
					const driver = new NvaSyncDriver(video, audioClock, {});
					driver.start();
					await new Promise((r) => setTimeout(r, 3800));
					stats = driver.stats();
					driver.stop();
				} else {
					const meter = new SyncMeter();
					const stop = measureSync(video, audioClock, meter);
					await new Promise((r) => setTimeout(r, 3800));
					stop();
					stats = meter.stats();
				}
				video.pause();
				video.remove();
				await ctx.close().catch(() => undefined);
				return stats;
			}

			const baseline = await run(false);
			const driven = await run(true);
			URL.revokeObjectURL(blobUrl);
			return { baseline, driven };
		}, b64);

		// biome-ignore lint/suspicious/noConsole: P3 진단 로그
		console.log(
			`[P3싱크] baseline: meanSigned=${result.baseline.meanSigned.toFixed(1)} ` +
				`p95=${result.baseline.p95.toFixed(1)} p99=${result.baseline.p99.toFixed(1)} | ` +
				`driven: meanSigned=${result.driven.meanSigned.toFixed(1)} ` +
				`p95=${result.driven.p95.toFixed(1)} p99=${result.driven.p99.toFixed(1)} jitterP95=${result.driven.jitterP95.toFixed(1)}`,
		);

		// 표본 충분.
		expect(result.driven.n).toBeGreaterThan(40);
		// 드라이버가 drift 오프셋(|meanSigned|)을 baseline 대비 대폭 감소(제어 수렴).
		expect(Math.abs(result.driven.meanSigned)).toBeLessThan(
			Math.abs(result.baseline.meanSigned) * 0.5,
		);
		// ★설계 P3 게이트: drift p95<80ms, p99<150ms (playbackRate 제어로 헤드리스 실측 달성).
		expect(result.driven.p95, `driven p95=${result.driven.p95}`).toBeLessThan(80);
		expect(result.driven.p99, `driven p99=${result.driven.p99}`).toBeLessThan(150);
	});
});
