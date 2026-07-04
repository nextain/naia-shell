import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * NVA 마스크 video 실렌더 — real Chromium 이 완전한 VP9 알파 webm(DittoCompositeAvatar 출력 포맷)을
 * 실제 `CascadeAvatarRenderer.speak()` 의 Blob 경로로 디코드·재생하는지 검증한다.
 *
 * jsdom 단위 테스트(cascade-renderer.test.ts)는 Content-Type 라우팅 "결정"만 본다(미디어 디코드 불가).
 * 이 테스트는 GPU 없이(=composite 렌더는 못 하지만) 그 산출물과 **동형 포맷**의 실 webm 을 page.route 로
 * 서빙해, 브라우저가 마스크 video 를 실제로 그리는지(videoWidth>0)까지 확인한다.
 *  - host `<video>` = GET /idle(미디어 로드) → 디코드.
 *  - buf `<video>` = fetch POST /stream_text → video/webm → **완전 파일 Blob → src** → 디코드·재생.
 * 픽스처 = ffmpeg 로 만든 VP9 yuva420p(alpha_mode=1) + opus 0.5s (e2e/fixtures/masked-video-sample.webm).
 */
const WEBM = readFileSync(
	join(__dirname, "fixtures", "masked-video-sample.webm"),
);

const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET,POST,OPTIONS",
	"access-control-allow-headers": "content-type",
};

// 앱 mount 시 Tauri IPC 부재로 인한 크래시 소음 억제(테스트는 앱이 아니라 렌더러 모듈만 씀).
const TAURI_NOOP = `window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_INTERNALS__.invoke = window.__TAURI_INTERNALS__.invoke || (async () => undefined);
window.__TAURI_INTERNALS__.transformCallback = window.__TAURI_INTERNALS__.transformCallback || ((f) => f);`;

test.describe("NVA 마스크 video 실렌더 (real Chromium, VP9 알파 webm → Blob)", () => {
	test("완전 webm(video/webm)을 Blob 경로로 디코드·재생한다", async ({
		page,
	}) => {
		await page.addInitScript(TAURI_NOOP);
		await page.route(/127\.0\.0\.1:8910\//, async (route) => {
			const req = route.request();
			if (req.method() === "OPTIONS") {
				return route.fulfill({ status: 204, headers: CORS });
			}
			const url = req.url();
			if (
				url.includes("/idle") ||
				url.includes("/stream_text") ||
				url.includes("/stream")
			) {
				return route.fulfill({
					status: 200,
					contentType: "video/webm",
					headers: CORS,
					body: WEBM,
				});
			}
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				headers: CORS,
				body: JSON.stringify({ ok: true }),
			});
		});

		await page.goto("/"); // Vite dev = 렌더러 모듈 서빙(앱 mount 여부 무관)

		const result = await page.evaluate(async () => {
			// MSE 미사용 확증 — webm 은 Blob 경로여야 한다(MSE 로 새면 여기서 잡힌다).
			let mseUsed = false;
			const RealMS = window.MediaSource;
			window.MediaSource = class extends RealMS {
				constructor() {
					super();
					mseUsed = true;
				}
			};

			const container = document.createElement("div");
			const host = document.createElement("video");
			host.playsInline = true;
			host.muted = true;
			container.appendChild(host);
			document.body.appendChild(container);

			const mod = await import("/src/lib/avatar/cascade-renderer.ts");
			const events = [];
			const r = new mod.CascadeAvatarRenderer(
				{ runtimeUrl: "http://127.0.0.1:8910" },
				(t) => events.push(t),
			);
			r.start(host);

			// host = /idle webm 디코드 대기(videoWidth>0).
			await new Promise((res) => {
				const iv = setInterval(() => {
					if (host.videoWidth > 0) {
						clearInterval(iv);
						res(undefined);
					}
				}, 50);
				setTimeout(() => {
					clearInterval(iv);
					res(undefined);
				}, 6000);
			});
			const idleW = host.videoWidth;

			// buf = start() 가 container 에 추가한 두번째 <video>(발화 오버레이).
			const buf = Array.from(container.querySelectorAll("video")).find(
				(v) => v !== host,
			);
			let bufW = 0;
			const grab = () => {
				if (buf) bufW = Math.max(bufW, buf.videoWidth);
			};
			buf?.addEventListener("loadedmetadata", grab);
			buf?.addEventListener("playing", grab);
			buf?.addEventListener("timeupdate", grab);

			await r.speak("안녕하세요");
			grab();
			return {
				idleW,
				bufSrc: (buf?.src ?? "").slice(0, 5),
				bufW,
				events,
				mseUsed,
			};
		});

		// idle 마스크 video 가 실제로 디코드됨(브라우저 렌더 확인).
		expect(result.idleW).toBeGreaterThan(0);
		// 발화 = 완전 파일 **Blob 경로**(MSE 아님) — D2 핵심. blob: src + MediaSource 미생성.
		expect(result.bufSrc).toBe("blob:");
		expect(result.mseUsed).toBe(false);
		// 발화 webm 이 실제 디코드됨(마스크 video 재생) — MSE-mp4 코덱은 webm 디코드 불가라 이게 Blob 증거.
		expect(result.bufW).toBeGreaterThan(0);
		// swap 시 onTalking(true) 전달(발화 시작 동기화).
		expect(result.events).toContain(true);
	});
});
