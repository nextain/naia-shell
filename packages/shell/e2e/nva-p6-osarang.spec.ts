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
			srcFrame: bB64("clips/source_frame.png"), // head_image(Ditto 소스 = 전체 프레임)
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
  return { head, clipMap, canvas, px, audioClock:()=>performance.now()/1000 - audioStart };
}`;

/**
 * ★NVA 레이어드 플레이어 P6 — osarang.nva 통합(4K→720 축소 + 배경 마스킹).
 *   게이트: (1) 마스킹(B-R geq 알파)이 브라우저에서 배경 투명(corner alpha 0)으로 디코딩 — 핵심 요구,
 *   (2) 실 manifest+클립으로 idle→speak 렌더 + speak.face_bbox([0.41,0.15,0.17,0.11]) 위치 head 합성.
 */
test.describe("NVA P6 — osarang.nva 통합(배경 마스킹)", () => {
	test("마스킹된 osarang: 배경 투명 + idle→speak(head 합성)→endSpeak", async ({
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
				const { head, clipMap, px, audioClock } = await setup(FIX);
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
				const canvas = document.querySelector("canvas") as HTMLCanvasElement;
				const ctx2 = canvas.getContext("2d", { alpha: true });
				if (!ctx2) throw new Error("no ctx2");
				const alphaAt = (x: number, y: number) =>
					ctx2.getImageData(x, y, 1, 1).data[3];
				// 캐릭터 밖 배경 표본(코너 4 + 좌우/상단 엣지) — 전부 투명이어야 마스킹 성립.
				const BG_PTS: Array<[number, number]> = [
					[4, 4],
					[176, 4],
					[4, 316],
					[176, 316],
					[8, 160],
					[172, 160],
					[8, 90],
					[172, 90],
				];
				// 캐릭터 몸통 표본 — 전부 불투명이어야(마스크가 캐릭터를 지우지 않음).
				const CHAR_PTS: Array<[number, number]> = [
					[90, 185],
					[88, 140],
					[92, 160],
				];
				const maskMetrics = () => {
					const bg = BG_PTS.map(([x, y]) => alphaAt(x, y));
					const ch = CHAR_PTS.map(([x, y]) => alphaAt(x, y));
					// 상단 3행(캐릭터 위 = 배경) 평균 알파 — 프린지/반투명 잔여 검출.
					const strip = ctx2.getImageData(0, 0, 180, 3).data;
					let sum = 0;
					let n = 0;
					for (let i = 3; i < strip.length; i += 4) {
						sum += strip[i];
						n++;
					}
					return {
						bgMax: Math.max(...bg),
						chMin: Math.min(...ch),
						stripAvg: sum / n,
					};
				};
				const snap = async (ms: number) => {
					await new Promise((res) => setTimeout(res, ms));
					return {
						state: player.state,
						body: px(90, 185),
						corner: px(4, 4),
						face: px(89, 65),
						frames: player.stats().framesDrawn,
						mask: maskMetrics(),
					};
				};

				await player.start();
				const s0 = await snap(400);
				await player.speak({ video: head, audioClock });
				const s1 = await snap(450);
				player.endSpeak();
				const s2 = await snap(350);
				player.dispose();
				return { derived, s0, s1, s2 };
			},
			{ FIX, setupSrc: SETUP },
		);

		// biome-ignore lint/suspicious/noConsole: P6 진단(마스킹 메트릭)
		console.log(
			`[P6 osarang] idle mask=${JSON.stringify(r.s0.mask)} body=${r.s0.body} | speak mask=${JSON.stringify(r.s1.mask)} face=${r.s1.face}`,
		);
		expect(r.derived.idleKey).toBe("idle");
		expect(r.derived.talkKey).toBe("speak");
		// idle: 캐릭터 렌더 + ★배경 마스킹 실효(다점 배경 전부 투명 + 캐릭터 전부 불투명 + 상단 스트립 평균 알파 낮음).
		expect(r.s0.state).toBe("idle");
		expect(r.s0.frames).toBeGreaterThan(0);
		expect(
			r.s0.mask.chMin,
			`idle char min alpha=${r.s0.mask.chMin}`,
		).toBeGreaterThan(200); // 캐릭터 불투명(마스크가 캐릭터를 안 지움)
		// ★주 지표: 캐릭터 위 배경 스트립(540px) 평균 알파 ≈ 0 = 배경 영역이 사실상 전부 투명(프린지/반투명 잔여 없음).
		expect(
			r.s0.mask.stripAvg,
			`idle strip avg=${r.s0.mask.stripAvg}`,
		).toBeLessThan(6);
		// bgMax(개별 배경점) — 소프트 마스크의 안티앨리어싱 엣지가 실루엣 근처 배경점에 부분 알파를 남길 수 있어 다소 완화.
		expect(
			r.s0.mask.bgMax,
			`idle bg max alpha=${r.s0.mask.bgMax}`,
		).toBeLessThan(50);
		// speaking: 배경 마스킹 유지 + face_bbox 위치 head 빨강 합성.
		expect(r.s1.state).toBe("speaking");
		expect(
			r.s1.mask.stripAvg,
			`speak strip avg=${r.s1.mask.stripAvg}`,
		).toBeLessThan(6);
		expect(
			r.s1.mask.bgMax,
			`speak bg max alpha=${r.s1.mask.bgMax}`,
		).toBeLessThan(50);
		expect(r.s1.face[0], `speak face=${r.s1.face}`).toBeGreaterThan(140);
		expect(r.s1.face[1], `speak face=${r.s1.face}`).toBeLessThan(110);
		// endSpeak: idle 복귀 + 배경 여전히 마스킹.
		expect(r.s2.state).toBe("idle");
		expect(
			r.s2.mask.stripAvg,
			`s2 strip avg=${r.s2.mask.stripAvg}`,
		).toBeLessThan(6);
		expect(r.s2.mask.bgMax, `s2 bg max alpha=${r.s2.mask.bgMax}`).toBeLessThan(
			50,
		);
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
				// face_bbox 영역(0.41,0.15 중심)에서 스킨톤 표본 — 소스가 실제 얼굴 담음.
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
		// Ditto 소스 = 전체 프레임 → canvas 치수와 일치.
		expect(r.w).toBe(r.canvasW);
		expect(r.h).toBe(r.canvasH);
		// face_bbox 위치에 스킨톤(밝고 R≥B, 불투명) = 실제 얼굴.
		expect(r.face[0], `face=${r.face}`).toBeGreaterThan(90);
		expect(r.face[0]).toBeGreaterThanOrEqual(r.face[2] - 10); // R ≳ B(스킨)
	});
});
