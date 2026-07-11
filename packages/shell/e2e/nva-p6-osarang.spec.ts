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
 *   게이트: (1) 마스킹(B-R soft geq 알파)이 브라우저에서 배경 투명 + **프린지(반투명 잔여) 유계**로 디코딩 —
 *   핵심 요구, (2) 실 manifest+클립으로 idle→speak 렌더 + speak.face_bbox 위치 head 합성.
 *   마스킹 검증 = 전체 프레임 알파 히스토그램(투명/불투명/프린지 비율)을 다프레임 집계(요행 배제).
 */
test.describe("NVA P6 — osarang.nva 통합(배경 마스킹)", () => {
	test("마스킹된 osarang: 배경 투명 + 프린지 유계 + idle→speak(head 합성)→endSpeak", async ({
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
				const CHAR_PTS: Array<[number, number]> = [
					[90, 185],
					[88, 140],
					[92, 160],
				];
				// 전체 프레임(180x320) 알파 히스토그램: 투명(<20)·불투명(>235)·프린지(20~235) 비율.
				const histogram = () => {
					const d = ctx.getImageData(0, 0, 180, 320).data;
					let trans = 0;
					let opaque = 0;
					let fringe = 0;
					const total = 180 * 320;
					for (let i = 3; i < d.length; i += 4) {
						const a = d[i];
						if (a < 20) trans++;
						else if (a > 235) opaque++;
						else fringe++;
					}
					return {
						transFrac: trans / total,
						opaqueFrac: opaque / total,
						fringeFrac: fringe / total,
					};
				};
				const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
				// 다프레임 집계(최악치). 단발 프레임 요행 배제.
				const aggregate = async () => {
					let maxFringe = 0;
					let minTrans = 1;
					let chMin = 255;
					for (let k = 0; k < 4; k++) {
						await sleep(110);
						const h = histogram();
						maxFringe = Math.max(maxFringe, h.fringeFrac);
						minTrans = Math.min(minTrans, h.transFrac);
						for (const [x, y] of CHAR_PTS)
							chMin = Math.min(chMin, ctx.getImageData(x, y, 1, 1).data[3]);
					}
					return { maxFringe, minTrans, chMin };
				};

				await player.start();
				await sleep(300);
				const s0 = {
					state: player.state,
					frames: player.stats().framesDrawn,
					agg: await aggregate(),
				};
				await player.speak({ video: head, audioClock });
				await sleep(350);
				const s1 = {
					state: player.state,
					face: px(89, 65),
					agg: await aggregate(),
				};
				player.endSpeak();
				await sleep(300);
				const s2 = { state: player.state, agg: await aggregate() };
				player.dispose();
				return { derived, s0, s1, s2 };
			},
			{ FIX, setupSrc: SETUP },
		);

		// biome-ignore lint/suspicious/noConsole: P6 진단(마스킹 히스토그램)
		console.log(
			`[P6 osarang] idle=${JSON.stringify(r.s0.agg)} | speak=${JSON.stringify(r.s1.agg)} face=${r.s1.face}`,
		);
		expect(r.derived.idleKey).toBe("idle");
		expect(r.derived.talkKey).toBe("speak");
		// idle: 캐릭터 불투명 + 배경 투명(상당 비율) + ★프린지(반투명 잔여) 유계 — 소프트 엣지가 얇은 밴드에 국한.
		expect(r.s0.state).toBe("idle");
		expect(r.s0.frames).toBeGreaterThan(0);
		expect(r.s0.agg.chMin, `idle chMin=${r.s0.agg.chMin}`).toBeGreaterThan(200); // 캐릭터 불투명
		expect(
			r.s0.agg.minTrans,
			`idle transFrac=${r.s0.agg.minTrans}`,
		).toBeGreaterThan(0.3); // 배경 투명 상당
		expect(
			r.s0.agg.maxFringe,
			`idle fringeFrac=${r.s0.agg.maxFringe}`,
		).toBeLessThan(0.09); // 프린지 얇음
		// speaking: 배경 마스킹 유지(프린지 유계) + face_bbox head 빨강.
		expect(r.s1.state).toBe("speaking");
		expect(
			r.s1.agg.minTrans,
			`speak transFrac=${r.s1.agg.minTrans}`,
		).toBeGreaterThan(0.3);
		expect(
			r.s1.agg.maxFringe,
			`speak fringeFrac=${r.s1.agg.maxFringe}`,
		).toBeLessThan(0.11); // head 오버레이 여유
		expect(r.s1.face[0], `speak face=${r.s1.face}`).toBeGreaterThan(140);
		expect(r.s1.face[1], `speak face=${r.s1.face}`).toBeLessThan(110);
		// endSpeak: idle 복귀 + 배경 마스킹 유지.
		expect(r.s2.state).toBe("idle");
		expect(
			r.s2.agg.maxFringe,
			`s2 fringeFrac=${r.s2.agg.maxFringe}`,
		).toBeLessThan(0.09);
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
				const face = Array.from(
					ctx.getImageData(Math.floor(w * 0.49), Math.floor(h * 0.19), 1, 1)
						.data,
				);
				URL.revokeObjectURL(url);
				return { w, h, face, canvasW, canvasH };
			},
			{
				pngB64: FIX.srcFrame,
				canvasW: FIX.manifest.canvas.width,
				canvasH: FIX.manifest.canvas.height,
			},
		);

		// biome-ignore lint/suspicious/noConsole: 진단
		console.log(`[source_frame] ${r.w}x${r.h} face=${r.face}`);
		expect(r.w).toBe(r.canvasW);
		expect(r.h).toBe(r.canvasH);
		expect(r.face[0], `face=${r.face}`).toBeGreaterThan(90);
		expect(r.face[0]).toBeGreaterThanOrEqual(r.face[2] - 10);
	});
});
