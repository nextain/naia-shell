import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNC_VIDEO = readFileSync(
	join(__dirname, "fixtures", "sync-5s-25fps.webm"),
);
const TAURI_NOOP = `window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_INTERNALS__.invoke = window.__TAURI_INTERNALS__.invoke || (async () => undefined);`;

/**
 * ★NVA 레이어드 플레이어 P0 — 스캐폴드 검증.
 * (1) capability 프로브: 레이어링에 필요한 능력(rVFC/WebGL2/h264 MSE/canvas알파)이 실 브라우저에 있나.
 *     ⚠️정본 목표는 WebView2(e2e-tauri) 프로브지만, 우선 Chromium 에서 기준선 확보(P5 통합서 e2e-tauri 재확인).
 * (2) A/V 싱크 측정 하니스(가장 위험한 가정): 비디오 프레임 PTS(rVFC.mediaTime) 가 오디오 master
 *     clock(AudioContext.currentTime) 을 실시간으로 추종하는가 → drift 통계로 정량 검증.
 */
test.describe("NVA P0 — capability + A/V 싱크 측정 하니스", () => {
	test("capability 프로브: 레이어드 플레이어 능력 확보 (Chromium 기준선)", async ({
		page,
	}) => {
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");
		const caps = await page.evaluate(async () => {
			const mod = await import("/src/lib/avatar/nva-capability.ts");
			return mod.probeNvaCapabilities();
		});
		// Chromium 기준선 = 모두 지원.
		expect(caps.rvfc, `reasons=${caps.reasons.join(",")}`).toBe(true);
		expect(caps.webgl2).toBe(true);
		expect(caps.mseH264).toBe(true);
		expect(caps.canvasAlpha).toBe(true);
		expect(caps.layeredOk).toBe(true);
	});

	test("A/V 싱크: 비디오 프레임 PTS 가 오디오 clock 을 실시간 추종 (drift 유계)", async ({
		page,
	}) => {
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const syncB64 = SYNC_VIDEO.toString("base64");
		const result = await page.evaluate(async (b64: string) => {
			const { SyncMeter, measureSync } = await import(
				"/src/lib/avatar/nva-sync.ts"
			);
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const blob = new Blob([bytes], { type: "video/webm" });
			const url = URL.createObjectURL(blob);
			const video = document.createElement("video");
			video.muted = true;
			video.playsInline = true;
			video.src = url;
			video.style.cssText =
				"position:fixed;top:0;left:0;width:160px;height:120px";
			document.body.appendChild(video);

			// 오디오 master clock = AudioContext.currentTime (resume 로 진행 보장).
			const AC =
				window.AudioContext ||
				(window as unknown as { webkitAudioContext: typeof AudioContext })
					.webkitAudioContext;
			const ctx = new AC();
			await ctx.resume().catch(() => undefined);

			const meter = new SyncMeter();
			let audioStart: number | null = null;
			const audioClock = () =>
				audioStart == null ? null : ctx.currentTime - audioStart;

			await new Promise<void>((res) => {
				video.addEventListener(
					"playing",
					() => {
						audioStart = ctx.currentTime; // 비디오 재생 시작 = 오디오 clock 기준점
						res();
					},
					{ once: true },
				);
				void video.play().catch(() => res());
			});

			const stop = measureSync(video, audioClock, meter);
			await new Promise((res) => setTimeout(res, 3800)); // ~3.8s(5s 클립 안쪽) 측정
			stop();
			const s = meter.stats();
			return {
				stats: s,
				ctxAdvanced: ctx.currentTime > 0.5,
				curTime: video.currentTime,
			};
		}, syncB64);

		// 오디오 clock 이 실제로 진행했고(측정 유효), 프레임이 충분히 샘플됨.
		expect(result.ctxAdvanced).toBe(true);
		expect(result.stats.n).toBeGreaterThan(40); // ~3.8s × 25fps 근처
		// ★핵심: raw drift 의 일정 오프셋(meanSigned)은 lead 상수로 보정 가능 → 실제 싱크 품질 = **오프셋
		//   보정 후 jitter**. jitter 가 작으면(수십 ms) 마스터clock+rVFC 싱크 메커니즘 성립(P3 실싱크 가능).
		//   (P0 = 메커니즘 검증. P3 head 실싱크 목표 = jitter p95<80ms.)
		console.log(
			`[P0싱크] n=${result.stats.n} offset(meanSigned)=${result.stats.meanSigned.toFixed(1)}ms ` +
				`jitterP95=${result.stats.jitterP95.toFixed(1)} jitterP99=${result.stats.jitterP99.toFixed(1)}ms ` +
				`(raw p95=${result.stats.p95.toFixed(1)})`,
		);
		// P0 = **측정 하니스 작동성** 검증(가장 위험한 가정을 측정가능하게 만듦) + 베이스라인 확보.
		//   raw jitter 는 헤드리스(vsync 없음)라 팽창 — 이 지터를 **P3 드라이버(skip/wait/playbackRate)가
		//   보정**해 실싱크 jitter p95<80ms 를 목표로 한다. P0 은 하니스가 drift/jitter 를 정량화함을 확인.
		expect(Number.isFinite(result.stats.jitterP95)).toBe(true);
		expect(result.stats.jitterP95).toBeLessThan(600); // 완전 붕괴 아님(sanity). 실싱크 목표=P3.
	});
});
