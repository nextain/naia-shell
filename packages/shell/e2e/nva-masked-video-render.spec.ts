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

	/**
	 * ★2026-07-10 라이브 립싱크 폭주 근본수정 — real Chromium E2E.
	 * 여러 문장(TTS 청크)이 거의 동시에 speak 를 호출해도(=ChatArea 의 fire-and-forget) 실제
	 * 렌더러가 /stream 을 **직렬**(항상 1건 in-flight)로 보내고 3건 모두 렌더하는지 실 브라우저로 검증.
	 * 예전엔 각 speak 가 gen++ 로 이전을 supersede + 백엔드에 동시 폭주 → facade 20s 타임아웃으로
	 * 렌더 실패(립싱크·발화음성 둘 다 드롭). 큐 직렬화로 해소.
	 */
	test("동시 speak 는 직렬화된다 (real Chromium: /stream in-flight 1건, 3건 모두 렌더)", async ({
		page,
	}) => {
		await page.addInitScript(TAURI_NOOP);
		let inFlight = 0;
		let maxInFlight = 0;
		let streamCount = 0;
		await page.route(/127\.0\.0\.1:8910\//, async (route) => {
			const req = route.request();
			if (req.method() === "OPTIONS") {
				return route.fulfill({ status: 204, headers: CORS });
			}
			const url = req.url();
			if (url.includes("/stream") && req.method() === "POST") {
				streamCount++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 150)); // 렌더 시간 모사
				inFlight--;
				return route.fulfill({
					status: 200,
					contentType: "video/webm",
					headers: CORS,
					body: WEBM,
				});
			}
			if (url.includes("/idle")) {
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

		await page.goto("/");

		const result = await page.evaluate(async () => {
			const container = document.createElement("div");
			const host = document.createElement("video");
			host.playsInline = true;
			host.muted = true;
			container.appendChild(host);
			document.body.appendChild(container);

			const mod = await import("/src/lib/avatar/cascade-renderer.ts");
			const r = new mod.CascadeAvatarRenderer({
				runtimeUrl: "http://127.0.0.1:8910",
			});
			r.start(host);

			// ChatArea 의 fire-and-forget(void speakAudio) 을 재현 — 3문장 동시 발화(await 안 함).
			const ps = [
				r.speak("첫 번째 문장입니다"),
				r.speak("두 번째 문장입니다"),
				r.speak("세 번째 문장입니다"),
			];
			await Promise.all(ps);

			const buf = Array.from(container.querySelectorAll("video")).find(
				(v) => v !== host,
			);
			return { bufSrc: (buf?.src ?? "").slice(0, 5) };
		});

		// ★핵심: 동시 호출이어도 /stream 은 한 번에 1건만(직렬) — 큐 적체·facade 타임아웃 소멸.
		expect(maxInFlight).toBe(1);
		// 3문장 모두 렌더됨(supersede 로 드롭되지 않음).
		expect(streamCount).toBe(3);
		// 실제 webm Blob 경로로 디코드(마지막 발화 src 확인).
		expect(result.bufSrc).toBe("blob:");
	});

	/**
	 * ★2026-07-10 립싱크 "화면 표시" 검증 — 사용자: 음성은 들리는데 립싱크 영상이 안 보인다.
	 * swap 이 opacity=1 + muted=false 를 동시에 설정하므로 논리상 소리나면 보여야 함. 실제 재생 중
	 * buf <video> 의 computed opacity 가 1 에 도달하는지(=화면에 노출) + 스크린샷으로 실측한다.
	 */
	test("립싱크 webm 이 실제로 화면에 표시된다(재생 중 opacity→1 + 스크린샷)", async ({
		page,
	}) => {
		await page.addInitScript(TAURI_NOOP);
		await page.route(/127\.0\.0\.1:8910\//, async (route) => {
			const req = route.request();
			if (req.method() === "OPTIONS") {
				return route.fulfill({ status: 204, headers: CORS });
			}
			const url = req.url();
			if (url.includes("/idle") || url.includes("/stream")) {
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

		await page.goto("/");

		await page.evaluate(async () => {
			const w = window as unknown as {
				__samples: Array<{ t: number; op: string; vw: number; active: boolean }>;
				__stop: () => void;
			};
			const container = document.createElement("div");
			container.id = "avatar-box";
			container.style.cssText =
				"position:fixed;top:0;left:0;width:320px;height:320px;background:#2b2b2b;z-index:99999";
			const host = document.createElement("video");
			host.playsInline = true;
			host.muted = true;
			host.style.cssText = "width:100%;height:100%;object-fit:contain";
			container.appendChild(host);
			document.body.appendChild(container);

			const mod = await import("/src/lib/avatar/cascade-renderer.ts");
			const r = new mod.CascadeAvatarRenderer({
				runtimeUrl: "http://127.0.0.1:8910",
			});
			r.start(host);

			w.__samples = [];
			const iv = setInterval(() => {
				const buf = Array.from(container.querySelectorAll("video")).find(
					(v) => v !== host,
				) as HTMLVideoElement | undefined;
				if (buf)
					w.__samples.push({
						t: buf.currentTime,
						op: getComputedStyle(buf).opacity,
						vw: buf.videoWidth,
						active: buf.style.opacity === "1",
					});
			}, 40);
			w.__stop = () => clearInterval(iv);

			void r.speak("립싱크 화면 표시 테스트입니다"); // fire (await 안 함)
		});

		// 재생 중 스크린샷(fixture webm 0.5s → 300~500ms 사이가 재생 구간)
		await page.waitForTimeout(450);
		await page.screenshot({ path: "D:/alpha-adk/tmp/lipsync-display.png" });
		await page.waitForTimeout(1000);

		const samples = await page.evaluate(() => {
			const w = window as unknown as {
				__samples: Array<{ t: number; op: string; vw: number; active: boolean }>;
				__stop: () => void;
			};
			w.__stop();
			return w.__samples;
		});

		const maxOp = Math.max(...samples.map((s) => Number.parseFloat(s.op)), 0);
		const maxVw = Math.max(...samples.map((s) => s.vw), 0);
		const played = samples.some((s) => s.t > 0);
		// 진단 로그(실패 시 원인 파악)
		console.log(
			`[립싱크표시] maxOpacity=${maxOp} maxVideoWidth=${maxVw} played=${played} samples=${samples.length}`,
		);
		expect(maxVw).toBeGreaterThan(0); // 비디오 트랙 디코드됨
		expect(played).toBe(true); // 실제 재생됨(currentTime 진행)
		expect(maxOp).toBeGreaterThan(0.9); // ★화면에 노출됨(swap 으로 opacity→1)
	});

	/**
	 * ★2026-07-10 audio-first(스트리밍 재생 1단계): speakAudio(..., {muted:true}) 는 립싱크 영상은
	 * 화면에 띄우되(opacity→1) 비디오의 오디오는 unmute 하지 않는다 — 발화음성은 외부(AudioQueue)가
	 * 즉시 재생하므로 이중오디오 방지. real Chromium 으로 muted 유지 + opacity 노출을 함께 검증.
	 */
	test("audio-first: muted 발화는 영상만 표시하고 unmute 하지 않는다", async ({
		page,
	}) => {
		await page.addInitScript(TAURI_NOOP);
		await page.route(/127\.0\.0\.1:8910\//, async (route) => {
			const req = route.request();
			if (req.method() === "OPTIONS")
				return route.fulfill({ status: 204, headers: CORS });
			const url = req.url();
			if (url.includes("/idle") || url.includes("/stream")) {
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
		await page.goto("/");

		const result = await page.evaluate(async () => {
			const container = document.createElement("div");
			const host = document.createElement("video");
			host.playsInline = true;
			host.muted = true;
			container.appendChild(host);
			document.body.appendChild(container);
			const mod = await import("/src/lib/avatar/cascade-renderer.ts");
			const r = new mod.CascadeAvatarRenderer({
				runtimeUrl: "http://127.0.0.1:8910",
			});
			r.start(host);

			const samples: Array<{ op: string; muted: boolean; t: number }> = [];
			const iv = setInterval(() => {
				const buf = Array.from(container.querySelectorAll("video")).find(
					(v) => v !== host,
				) as HTMLVideoElement | undefined;
				if (buf)
					samples.push({
						op: getComputedStyle(buf).opacity,
						muted: buf.muted,
						t: buf.currentTime,
					});
			}, 40);
			// btoa 로 더미 base64(WAV 헤더 불요 — /stream 라우트가 webm 반환). muted:true.
			void r.speakAudio(btoa("dummy-audio-payload"), 24000, { muted: true });
			await new Promise((res) => setTimeout(res, 900));
			clearInterval(iv);
			// 화면 노출된(opacity 1) 순간의 muted 상태를 본다.
			const shown = samples.filter((s) => Number.parseFloat(s.op) > 0.9);
			return {
				maxOp: Math.max(...samples.map((s) => Number.parseFloat(s.op)), 0),
				shownCount: shown.length,
				anyUnmutedWhileShown: shown.some((s) => s.muted === false),
			};
		});

		expect(result.maxOp).toBeGreaterThan(0.9); // 영상은 화면에 노출됨(립싱크 보임)
		expect(result.shownCount).toBeGreaterThan(0);
		expect(result.anyUnmutedWhileShown).toBe(false); // ★muted 유지 — 비디오 오디오 재생 안 함
	});
});
