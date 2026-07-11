import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
// osarang = pulse9 독점 자산(강남구청). naia-settings 로컬 미추적 — 워크스페이스에 있을 때만 통합 검증.
const BUNDLE = join(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"..",
	"naia-settings",
	"nva-files",
	"osarang",
);
const HAS_BUNDLE = existsSync(join(BUNDLE, "clips", "idle.webm"));
const bB64 = (rel: string) =>
	readFileSync(join(BUNDLE, rel)).toString("base64");
const fB64 = (f: string) =>
	readFileSync(join(__dirname, "fixtures", f)).toString("base64");
const FIX = HAS_BUNDLE
	? {
			idle: bB64("clips/idle.webm"),
			speak: bB64("clips/speak.webm"),
			head: fB64("head-green-100.mp4"),
			srcFrame: bB64("clips/source_frame.png"),
			manifest: JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8")),
		}
	: { idle: "", speak: "", head: "", srcFrame: "", manifest: {} };
const TAURI_NOOP = `window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_INTERNALS__.invoke = window.__TAURI_INTERNALS__.invoke || (async () => undefined);`;

const SETUP = `async function setup(FIX){
  const mk=(s,t)=>{ const bin=atob(s); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); return URL.createObjectURL(new Blob([u],{type:t})); };
  const idleUrl=mk(FIX.idle,"video/webm"), speakUrl=mk(FIX.speak,"video/webm"), headUrl=mk(FIX.head,"video/mp4");
  const head=document.createElement("video"); head.muted=true; head.playsInline=true; head.loop=true; head.src=headUrl;
  await new Promise((res)=>{ head.addEventListener("loadeddata",res,{once:true}); head.play().catch(()=>res()); });
  await new Promise(r=>setTimeout(r,150));
  const clipMap={ "clips/idle.webm":idleUrl, "clips/speak.webm":speakUrl };
  const canvas=document.createElement("canvas"); canvas.width=180; canvas.height=320; document.body.appendChild(canvas);
  const ctx=canvas.getContext("2d",{alpha:true});
  const px=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
  const audioStart=performance.now()/1000;
  return { head, clipMap, canvas, ctx, px, audioClock:()=>performance.now()/1000 - audioStart };
}`;

/**
 * ★NVA 레이어드 플레이어 P6 — osarang.nva 통합(4K→720 축소 + 배경 마스킹).
 *   게이트: (1) 마스킹(B-R soft geq 알파)이 브라우저에서 배경 투명 + **프린지가 실루엣 경계에 국한(떠다니는
 *   반투명 bg 아티팩트 없음)** 으로 디코딩 — 핵심 요구, (2) idle→speak 렌더 + speak.face_bbox head 합성.
 *   검증 = 전체 프레임 알파 분석(투명/불투명/프린지 비율 + **프린지 floating(떠다니는 bg 반투명 아티팩트) 비율**)을 8프레임(~1.4s 루프 커버) worst-case 집계.
 */
test.describe("NVA P6 — osarang.nva 통합(배경 마스킹)", () => {
	test("마스킹된 osarang: 배경 투명 + 프린지 edge-국한 + idle→speak(head 합성)→endSpeak", async ({
		page,
	}) => {
		test.skip(
			!HAS_BUNDLE,
			"osarang 번들(naia-settings)이 없어 스킵 — 워크스페이스 전용",
		);
		test.setTimeout(60_000);
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const r = await page.evaluate(
			async ({ FIX, setupSrc }: { FIX: typeof FIX; setupSrc: string }) => {
				// biome-ignore lint/security/noGlobalEval: 브라우저측 테스트 셋업 주입
				const setup = (0, eval)(`(${setupSrc})`);
				const { head, clipMap, ctx, px, audioClock } = await setup(FIX);
				const { NvaLayeredPlayer } = await import(
					"/src/lib/avatar/nva-layered-player.ts"
				);
				const { derive } = await import("/src/lib/avatar/nva-core.ts");
				const derived = derive(FIX.manifest);
				const player = new NvaLayeredPlayer(
					document.querySelector("canvas") as HTMLCanvasElement,
					FIX.manifest,
					{ resolveClip: (c: string) => clipMap[c] },
				);
				const W = 180;
				const H = 320;
				const TOTAL = W * H;
				// 전체 프레임 알파 분석: 투명/불투명/프린지 비율 + **프린지 edge-locality**(프린지가 불투명 이웃을
				// 가지면 = 실루엣 경계 fringe, 아니면 = 배경에 떠다니는 반투명 아티팩트). 후자가 거의 없어야 clean.
				const analyze = () => {
					const d = ctx.getImageData(0, 0, W, H).data;
					const A = new Uint8Array(TOTAL);
					for (let p = 0; p < TOTAL; p++) A[p] = d[p * 4 + 3];
					let trans = 0;
					let opaque = 0;
					let fringe = 0;
					let floating = 0;
					for (let y = 0; y < H; y++) {
						for (let x = 0; x < W; x++) {
							const p = y * W + x;
							const a = A[p];
							if (a < 20) {
								trans++;
							} else if (a > 235) {
								opaque++;
							} else {
								fringe++;
								// floating = 4이웃 모두 투명(<20) = bg 에 고립된 반투명 아티팩트(색번짐/오분류).
								// 실루엣 경계 소프트 그라디언트 fringe 는 fringe/opaque 이웃을 가져 floating 아님.
								const floatingHere =
									(x <= 0 || A[p - 1] < 20) &&
									(x >= W - 1 || A[p + 1] < 20) &&
									(y <= 0 || A[p - W] < 20) &&
									(y >= H - 1 || A[p + W] < 20);
								if (floatingHere) floating++;
							}
						}
					}
					return {
						transFrac: trans / TOTAL,
						opaqueFrac: opaque / TOTAL,
						fringeFrac: fringe / TOTAL,
						floatingRatio: fringe ? floating / fringe : 0,
					};
				};
				const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
				// 8프레임(~1.4s, 루프 상당구간 커버) worst-case 집계 — 전이 glitch 도 포착.
				const aggregate = async () => {
					let maxFringe = 0;
					let minTrans = 1;
					let minOpaque = 1;
					let maxFloating = 0;
					for (let k = 0; k < 8; k++) {
						await sleep(170);
						const a = analyze();
						maxFringe = Math.max(maxFringe, a.fringeFrac);
						minTrans = Math.min(minTrans, a.transFrac);
						minOpaque = Math.min(minOpaque, a.opaqueFrac);
						maxFloating = Math.max(maxFloating, a.floatingRatio);
					}
					return { maxFringe, minTrans, minOpaque, maxFloating };
				};

				await player.start();
				await sleep(250);
				const s0 = {
					state: player.state,
					frames: player.stats().framesDrawn,
					agg: await aggregate(),
				};
				await player.speak({ video: head, audioClock });
				await sleep(300);
				const s1 = {
					state: player.state,
					face: px(89, 65),
					agg: await aggregate(),
				};
				player.endSpeak();
				await sleep(250);
				const s2 = { state: player.state, agg: await aggregate() };
				player.dispose();
				return { derived, s0, s1, s2 };
			},
			{ FIX, setupSrc: SETUP },
		);

		// biome-ignore lint/suspicious/noConsole: P6 진단(마스킹 분석)
		console.log(
			`[P6 osarang] idle=${JSON.stringify(r.s0.agg)} | speak=${JSON.stringify(r.s1.agg)} face=${r.s1.face}`,
		);
		expect(r.derived.idleKey).toBe("idle");
		expect(r.derived.talkKey).toBe("speak");
		// idle 마스킹 실효(실측 여유: fringe~0.053→<0.075(1.4×), trans~0.775→>0.6, floatingRatio 낮음→<0.15):
		expect(r.s0.state).toBe("idle");
		expect(r.s0.frames).toBeGreaterThan(0);
		expect(
			r.s0.agg.minOpaque,
			`idle opaqueFrac=${r.s0.agg.minOpaque}`,
		).toBeGreaterThan(0.1); // 캐릭터 존재
		expect(
			r.s0.agg.minTrans,
			`idle transFrac=${r.s0.agg.minTrans}`,
		).toBeGreaterThan(0.6); // 배경 대부분 투명
		expect(
			r.s0.agg.maxFringe,
			`idle fringeFrac=${r.s0.agg.maxFringe}`,
		).toBeLessThan(0.075); // 프린지 얇음
		expect(
			r.s0.agg.maxFloating,
			`idle floatingRatio=${r.s0.agg.maxFloating}`,
		).toBeLessThan(0.15); // 떠다니는 반투명 bg 아티팩트 거의 없음(프린지=실루엣 경계 밴드)
		// speaking: 마스킹 유지 + face_bbox head 빨강. (head 오버레이가 프린지/투명 통계에 더해지므로 임계 여유.)
		expect(r.s1.state).toBe("speaking");
		expect(
			r.s1.agg.minTrans,
			`speak transFrac=${r.s1.agg.minTrans}`,
		).toBeGreaterThan(0.55);
		expect(
			r.s1.agg.maxFringe,
			`speak fringeFrac=${r.s1.agg.maxFringe}`,
		).toBeLessThan(0.1);
		expect(r.s1.face[0], `speak face=${r.s1.face}`).toBeGreaterThan(140);
		expect(r.s1.face[1], `speak face=${r.s1.face}`).toBeLessThan(110);
		// endSpeak: idle 복귀 + 마스킹 유지.
		expect(r.s2.state).toBe("idle");
		expect(
			r.s2.agg.maxFringe,
			`s2 fringeFrac=${r.s2.agg.maxFringe}`,
		).toBeLessThan(0.075);
		expect(
			r.s2.agg.maxFloating,
			`s2 floatingRatio=${r.s2.agg.maxFloating}`,
		).toBeLessThan(0.15);
	});

	test("head_image(source_frame.png): 유효한 Ditto 소스 프레임 + canvas 치수 정합", async ({
		page,
	}) => {
		test.skip(!HAS_BUNDLE, "osarang 번들 없음 — 워크스페이스 전용");
		test.setTimeout(45_000);
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const r = await page.evaluate(
			async ({
				pngB64,
				canvasW,
				canvasH,
			}: { pngB64: string; canvasW: number; canvasH: number }) => {
				const bin = atob(pngB64);
				const u = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
				const url = URL.createObjectURL(new Blob([u], { type: "image/png" }));
				const img = new Image();
				await new Promise((res, rej) => {
					img.onload = res;
					img.onerror = rej;
					img.src = url;
				});
				const w = img.naturalWidth;
				const h = img.naturalHeight;
				const c = document.createElement("canvas");
				c.width = w;
				c.height = h;
				const ctx = c.getContext("2d", { alpha: true });
				if (!ctx) throw new Error("no ctx");
				ctx.drawImage(img, 0, 0);
				// face_bbox 부근 여러 표본으로 스킨톤 평균(단일픽셀 요행 배제).
				const pts: Array<[number, number]> = [
					[0.49, 0.18],
					[0.47, 0.2],
					[0.51, 0.2],
					[0.49, 0.22],
				];
				let rSum = 0;
				let bSum = 0;
				let aSum = 0;
				for (const [fx, fy] of pts) {
					const d = ctx.getImageData(
						Math.floor(w * fx),
						Math.floor(h * fy),
						1,
						1,
					).data;
					rSum += d[0];
					bSum += d[2];
					aSum += d[3];
				}
				URL.revokeObjectURL(url);
				return {
					w,
					h,
					rAvg: rSum / 4,
					bAvg: bSum / 4,
					aAvg: aSum / 4,
					canvasW,
					canvasH,
				};
			},
			{
				pngB64: FIX.srcFrame,
				canvasW: FIX.manifest.canvas.width,
				canvasH: FIX.manifest.canvas.height,
			},
		);

		// biome-ignore lint/suspicious/noConsole: 진단
		console.log(
			`[source_frame] ${r.w}x${r.h} rAvg=${r.rAvg} bAvg=${r.bAvg} aAvg=${r.aAvg}`,
		);
		expect(r.w).toBe(r.canvasW);
		expect(r.h).toBe(r.canvasH);
		expect(r.aAvg, "불투명").toBeGreaterThan(150);
		expect(r.rAvg, "스킨 밝기").toBeGreaterThan(120);
		expect(r.rAvg, "R≳B 스킨").toBeGreaterThanOrEqual(r.bAvg - 10);
	});
});
