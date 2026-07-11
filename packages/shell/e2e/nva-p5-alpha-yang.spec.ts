import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
// ★풀해상도 실 클립을 쓴다 — ffmpeg VP9 디코더는 알파를 복원 못 해 다운스케일 re-encode 가 알파를 파괴한다.
//   브라우저는 원본 알파를 정상 디코딩. (canvas 180x320 로 drawImage 축소; face_bbox 정규화라 위치 보존.)
const BUNDLE = join(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"..",
	"naia-settings",
	"nva-files",
	"alpha-yang",
);
const bundleB64 = (rel: string) =>
	readFileSync(join(BUNDLE, rel)).toString("base64");
const fixB64 = (f: string) =>
	readFileSync(join(__dirname, "fixtures", f)).toString("base64");
// alpha-yang 번들 = naia-settings 로컬 런타임 자산(관례상 미추적). 워크스페이스에 있을 때만 통합 검증.
const HAS_BUNDLE = existsSync(join(BUNDLE, "clips", "idle.webm"));
const FIX = HAS_BUNDLE
	? {
			idle: bundleB64("clips/idle.webm"),
			speak: bundleB64("clips/speak.webm"),
			head: fixB64("head-green-100.mp4"),
			manifest: JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8")),
		}
	: { idle: "", speak: "", head: "", manifest: {} };
const TAURI_NOOP = `window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_INTERNALS__.invoke = window.__TAURI_INTERNALS__.invoke || (async () => undefined);`;

const SETUP = `async function setup(FIX){
  const mk=(s,t)=>{ const bin=atob(s); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); return URL.createObjectURL(new Blob([u],{type:t})); };
  const idleUrl=mk(FIX.idle,"video/webm"), speakUrl=mk(FIX.speak,"video/webm"), headUrl=mk(FIX.head,"video/mp4");
  const head=document.createElement("video"); head.muted=true; head.playsInline=true; head.loop=true; head.src=headUrl;
  await new Promise((res)=>{ head.addEventListener("loadeddata",res,{once:true}); head.play().catch(()=>res()); });
  await new Promise(r=>setTimeout(r,150));
  // 실 manifest 의 clip 경로("clips/idle.webm" 등) → 다운스케일 blob 매핑.
  const clipMap={ "clips/idle.webm":idleUrl, "clips/speak.webm":speakUrl };
  const canvas=document.createElement("canvas"); canvas.width=180; canvas.height=320; document.body.appendChild(canvas);
  const ctx=canvas.getContext("2d",{alpha:true});
  const px=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
  const audioStart=performance.now()/1000;
  return { head, clipMap, canvas, px, audioClock:()=>performance.now()/1000 - audioStart };
}`;

/**
 * ★NVA 레이어드 플레이어 P5 — 실 저작본 alpha-yang.nva 통합.
 *   게이트: 실 alpha-yang manifest + 실 클립(idle 전신 + 안정구간 speak base)으로 플레이어가 idle/speak 를
 *   렌더하고, 발화 시 speak.face_bbox([0.34,0.04,0.19,0.18]) 위치에 head 를 합성한다. 캔버스 픽셀로 검증.
 */
test.describe("NVA P5 — alpha-yang.nva 통합(실 저작본)", () => {
	test("실 alpha-yang manifest+클립: idle→speak(head 합성)→endSpeak", async ({
		page,
	}) => {
		test.skip(
			!HAS_BUNDLE,
			"alpha-yang 번들(naia-settings)이 없어 스킵 — 워크스페이스 전용 통합 테스트",
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
						body: px(90, 210), // 캐릭터 몸통(불투명)
						corner: px(4, 4), // 투명 여백
						face: px(78, 42), // speak.face_bbox 중심(발화중 head 빨강)
						frames: player.stats().framesDrawn,
					};
				};

				await player.start();
				const s0 = await snap(350); // idle
				await player.speak({ video: head, audioClock });
				const s1 = await snap(450); // speaking
				player.endSpeak();
				const s2 = await snap(350); // idle
				player.dispose();
				return { derived, s0, s1, s2 };
			},
			{ FIX, setupSrc: SETUP },
		);

		// biome-ignore lint/suspicious/noConsole: P5 진단(코너 알파 = 소스 투명성)
		console.log(
			`[P5 alpha-yang] idle body=${r.s0.body} corner=${r.s0.corner} | speak face=${r.s1.face}`,
		);
		// 실 manifest derive: idle/speak.
		expect(r.derived.idleKey).toBe("idle");
		expect(r.derived.talkKey).toBe("speak");
		// idle: 상태 + 캐릭터 렌더(몸통 불투명) + 투명 여백 보존.
		expect(r.s0.state).toBe("idle");
		expect(r.s0.frames).toBeGreaterThan(0);
		expect(r.s0.body[3], `idle body=${r.s0.body}`).toBeGreaterThan(120); // 캐릭터 불투명
		expect(r.s0.corner[3], `idle corner=${r.s0.corner}`).toBeLessThan(60); // 여백 투명
		// speaking: 상태 + face_bbox 위치에 head 빨강 합성(스킨톤 아님 = g 낮음).
		expect(r.s1.state).toBe("speaking");
		expect(r.s1.face[0], `speak face=${r.s1.face}`).toBeGreaterThan(140); // 빨강
		expect(r.s1.face[1], `speak face=${r.s1.face}`).toBeLessThan(110); // 스킨톤 아님
		// endSpeak: idle 복귀.
		expect(r.s2.state).toBe("idle");
		expect(r.s2.body[3]).toBeGreaterThan(120);
	});
});
