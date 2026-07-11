import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) =>
	readFileSync(join(__dirname, "fixtures", f)).toString("base64");
// idle=빨강중앙, speak=파랑중앙, gesture=노랑중앙(0.5s), head=green+빨강사각(h264).
const FIX = {
	idle: fx("base-alpha-200.webm"),
	speak: fx("speak-blue-200.webm"),
	gesture: fx("gesture-yellow-200.webm"),
	head: fx("head-green-100.mp4"),
};
const TAURI_NOOP = `window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_INTERNALS__.invoke = window.__TAURI_INTERNALS__.invoke || (async () => undefined);`;

// 브라우저측 셋업 헬퍼(문자열 주입): blob url + head video + manifest + player.
const SETUP = `async function setup(FIX){
  const mk = (b64,type)=>{ const bin=atob(b64); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); return URL.createObjectURL(new Blob([u],{type})); };
  const idleUrl=mk(FIX.idle,"video/webm"), speakUrl=mk(FIX.speak,"video/webm"), gestureUrl=mk(FIX.gesture,"video/webm"), headUrl=mk(FIX.head,"video/mp4");
  const head=document.createElement("video"); head.muted=true; head.playsInline=true; head.loop=true; head.src=headUrl;
  await new Promise((res)=>{ head.addEventListener("loadeddata",res,{once:true}); head.play().catch(()=>res()); });
  await new Promise(r=>setTimeout(r,150));
  const clipMap={ "idle.webm":idleUrl, "speak.webm":speakUrl, "wave.webm":gestureUrl };
  const manifest={ nva_version:"0.2", canvas:{width:200,height:200,fps:25}, animations:{
    idle:{clip:"idle.webm",loop:true,can_talk:false},
    speak:{clip:"speak.webm",loop:true,can_talk:true,face_bbox:[0.25,0.25,0.5],head_chroma:"#00ff00",head_image:"h.png",head_time:0},
    wave:{clip:"wave.webm",loop:false,can_talk:false},
  }};
  const canvas=document.createElement("canvas"); canvas.width=200; canvas.height=200; document.body.appendChild(canvas);
  const ctx=canvas.getContext("2d",{alpha:true});
  const px=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
  const audioStart=performance.now()/1000;
  const audioClock=()=>performance.now()/1000 - audioStart;
  return { head, clipMap, manifest, canvas, px, audioClock };
}`;

/**
 * ★NVA 레이어드 플레이어 P4 — 상태머신 + 합성. P1 base + P2 head + P3 sync 조립.
 *   게이트: idle↔speak↔gesture 전환(더블버퍼)·barge-in·gesture preempt·race. 상태 + 캔버스 픽셀 검증.
 *   detect: p(60,100)= idle 빨강 / speak 파랑(head green 제거로 base 노출) / gesture 노랑. p(100,100)= 발화중 head 빨강.
 */
test.describe("NVA P4 — 레이어드 플레이어 상태머신(전환)", () => {
	test("전환 시퀀스: idle→speak→endSpeak→gesture→복귀 + head 합성", async ({
		page,
	}) => {
		test.setTimeout(60_000);
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const r = await page.evaluate(
			async ({ FIX, setupSrc }: { FIX: typeof FIX; setupSrc: string }) => {
				// biome-ignore lint/security/noGlobalEval: 브라우저측 테스트 셋업 주입
				const setup = (0, eval)(`(${setupSrc})`);
				const { head, clipMap, manifest, px, audioClock } = await setup(FIX);
				const { NvaLayeredPlayer } = await import(
					"/src/lib/avatar/nva-layered-player.ts"
				);
				const player = new NvaLayeredPlayer(
					document.querySelector("canvas") as HTMLCanvasElement,
					manifest,
					{ resolveClip: (c: string) => clipMap[c] },
				);
				const snap = async (ms: number) => {
					await new Promise((res) => setTimeout(res, ms));
					return { state: player.state, p60: px(60, 100), p100: px(100, 100) };
				};

				await player.start();
				const s0 = await snap(300); // idle
				await player.speak({ video: head, audioClock });
				const s1 = await snap(450); // speaking
				player.endSpeak();
				const s2 = await snap(300); // idle
				await player.gesture("wave");
				const s3 = await snap(200); // gesturing
				const s4 = await snap(800); // gesture 종료 후 복귀
				player.dispose();
				return { s0, s1, s2, s3, s4 };
			},
			{ FIX, setupSrc: SETUP },
		);

		// idle: 상태 idle + base 빨강(p60).
		expect(r.s0.state).toBe("idle");
		expect(r.s0.p60[0], `s0.p60=${r.s0.p60}`).toBeGreaterThan(150);
		expect(r.s0.p60[2]).toBeLessThan(120);
		// speaking: 상태 speaking + speak base 파랑(p60, head green 제거로 노출) + head 빨강(p100).
		expect(r.s1.state).toBe("speaking");
		expect(r.s1.p60[2], `s1.p60=${r.s1.p60}`).toBeGreaterThan(150); // 파랑 base
		expect(r.s1.p100[0], `s1.p100=${r.s1.p100}`).toBeGreaterThan(120); // head 빨강
		// endSpeak: idle 빨강 복귀.
		expect(r.s2.state).toBe("idle");
		expect(r.s2.p60[0], `s2.p60=${r.s2.p60}`).toBeGreaterThan(150);
		expect(r.s2.p60[2]).toBeLessThan(120);
		// gesturing: 노랑(r+g).
		expect(r.s3.state).toBe("gesturing");
		expect(r.s3.p60[0], `s3.p60=${r.s3.p60}`).toBeGreaterThan(150);
		expect(r.s3.p60[1]).toBeGreaterThan(150);
		expect(r.s3.p60[2]).toBeLessThan(120);
		// gesture 종료 후 idle(빨강) 복귀.
		expect(r.s4.state).toBe("idle");
		expect(r.s4.p60[0], `s4.p60=${r.s4.p60}`).toBeGreaterThan(150);
		expect(r.s4.p60[2]).toBeLessThan(120);
	});

	test("barge-in + race: 급전환에도 크래시 없이 일관 상태", async ({
		page,
	}) => {
		test.setTimeout(60_000);
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const r = await page.evaluate(
			async ({ FIX, setupSrc }: { FIX: typeof FIX; setupSrc: string }) => {
				// biome-ignore lint/security/noGlobalEval: 브라우저측 테스트 셋업 주입
				const setup = (0, eval)(`(${setupSrc})`);
				const { head, clipMap, manifest, px, audioClock } = await setup(FIX);
				const { NvaLayeredPlayer } = await import(
					"/src/lib/avatar/nva-layered-player.ts"
				);
				const player = new NvaLayeredPlayer(
					document.querySelector("canvas") as HTMLCanvasElement,
					manifest,
					{ resolveClip: (c: string) => clipMap[c] },
				);
				await player.start();
				let threw = false;
				try {
					// race: speak 2연타(첫 로드 완료 전 두번째).
					const p1 = player.speak({ video: head, audioClock });
					const p2 = player.speak({ video: head, audioClock });
					await Promise.all([p1, p2]);
					await new Promise((res) => setTimeout(res, 300));
					const afterRace = { state: player.state, p60: px(60, 100) };
					// barge-in: 발화 중 즉시 endSpeak.
					const p3 = player.speak({ video: head, audioClock });
					player.endSpeak();
					await p3.catch(() => undefined);
					await new Promise((res) => setTimeout(res, 400));
					const afterBarge = { state: player.state, p60: px(60, 100) };
					player.dispose();
					return { threw, afterRace, afterBarge };
				} catch (e) {
					threw = true;
					return { threw, error: String(e) };
				}
			},
			{ FIX, setupSrc: SETUP },
		);

		expect(r.threw, `error=${(r as { error?: string }).error}`).toBe(false);
		// race 후 speaking(파랑 base) 안정.
		expect(r.afterRace?.state).toBe("speaking");
		expect(r.afterRace?.p60[2], `race.p60=${r.afterRace?.p60}`).toBeGreaterThan(
			120,
		);
		// barge-in 후 idle(빨강) 복귀.
		expect(r.afterBarge?.state).toBe("idle");
		expect(
			r.afterBarge?.p60[0],
			`barge.p60=${r.afterBarge?.p60}`,
		).toBeGreaterThan(150);
	});
});
