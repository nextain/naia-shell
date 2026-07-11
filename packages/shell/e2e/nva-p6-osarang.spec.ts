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
				const snap = async (ms: number) => {
					await new Promise((res) => setTimeout(res, ms));
					return {
						state: player.state,
						body: px(90, 185), // 캐릭터(검은 치마/다리) 불투명
						corner: px(4, 4), // 마스킹된 배경 = 투명
						face: px(89, 65), // speak.face_bbox 중심(발화중 head 빨강)
						frames: player.stats().framesDrawn,
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

		// biome-ignore lint/suspicious/noConsole: P6 진단(코너 = 마스킹 검증)
		console.log(
			`[P6 osarang] idle body=${r.s0.body} corner=${r.s0.corner} | speak face=${r.s1.face}`,
		);
		expect(r.derived.idleKey).toBe("idle");
		expect(r.derived.talkKey).toBe("speak");
		// idle: 캐릭터 렌더 + ★배경 마스킹(corner 투명) — osarang 핵심 요구.
		expect(r.s0.state).toBe("idle");
		expect(r.s0.frames).toBeGreaterThan(0);
		expect(r.s0.body[3], `idle body=${r.s0.body}`).toBeGreaterThan(120); // 캐릭터 불투명
		expect(r.s0.corner[3], `idle corner=${r.s0.corner}`).toBeLessThan(70); // 배경 마스킹→투명
		// speaking: face_bbox 위치 head 빨강 합성.
		expect(r.s1.state).toBe("speaking");
		expect(r.s1.face[0], `speak face=${r.s1.face}`).toBeGreaterThan(140);
		expect(r.s1.face[1], `speak face=${r.s1.face}`).toBeLessThan(110);
		// endSpeak: idle 복귀 + 배경 여전히 투명.
		expect(r.s2.state).toBe("idle");
		expect(r.s2.corner[3], `s2 corner=${r.s2.corner}`).toBeLessThan(70);
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
