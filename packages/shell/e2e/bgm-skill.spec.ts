import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * UC8 / FR-BGM.1 — skill_youtube_bgm 배선 회귀 가드 (실 UI, 새 core).
 *
 * 왜 이 테스트가 필요한가(회귀 방지 앵커):
 *  - 구 monolith 의 BGM 스킬이 new-core 이식에서 **도구 등록 배선만 누락**됐다 —
 *    위젯(BgmPlayer)·검색 사이드카(:18791)·agent UC8 어댑터는 전부 존재했으나
 *    나이아가 BGM 존재 자체를 몰랐다. 단위테스트(executeBgmSkill)는 초록불이어도
 *    **배선이 빠지면** 회귀를 못 잡는다 → 그 두 배선을 실 UI 로 고정한다:
 *      (A) 부팅 시 App 이 skill_youtube_bgm 을 agent 에 등록(app_skills 발신)
 *      (B) 채팅 턴 중 agent 가 app_tool_call(skill_youtube_bgm) 을 내면
 *          ChatArea 가 dispatch → 위젯이 실제로 재생 상태로 전환(.bgm-icon--playing)
 *
 * 환경: 실제 vite dev(localhost:1420). Tauri IPC 는 addInitScript 로 mock(React 마운트 전).
 *  - 데모와 동일하게 새 core(__NAIA_NEW_CORE__=true).
 *  - send_to_agent_command payload 를 __E2E_OUTBOUND__ 에 기록(부팅 app_skills 캡처).
 *  - chat_request 수신 시 agent 대역으로 app_tool_call(skill_youtube_bgm, play+videoId — 사이드카 불요)
 *    + finish 를 agent_response 로 emit. dispatch → executeBgmSkill → bgm_youtube_play 이벤트 → 위젯 반응.
 */

const NEW_CORE_FLAG =
	"window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = [];";

// play+videoId 경로 = 사이드카(:18791) 미접촉(검색 skip) → 헤르메틱.
const BGM_TOOL_ARGS = [
	{ action: "play", videoId: "e2evid001", title: "E2E First Track" },
	{ action: "play", videoId: "e2evid001", title: "E2E Same Track Replay" },
];

const LONG_TRACK_WALL_MS = Number(process.env.RADIO_DJ_LONG_TRACK_MS ?? 6_200);
if (!Number.isSafeInteger(LONG_TRACK_WALL_MS) || LONG_TRACK_WALL_MS < 6_000) {
	throw new Error("RADIO_DJ_LONG_TRACK_MS must be an integer >= 6000");
}

const MOCK_SCRIPT = `
(function () {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  };
  var callbacks = new Map(); var nextCbId = 1;
  window.__TAURI_INTERNALS__.transformCallback = function (fn, once) {
    var id = nextCbId++;
    callbacks.set(id, function (data) { if (once) callbacks.delete(id); return fn && fn(data); });
    return id;
  };
  window.__TAURI_INTERNALS__.unregisterCallback = function (id) { callbacks.delete(id); };
  window.__TAURI_INTERNALS__.runCallback = function (id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
  var eventListeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function () {};
  function emitEvent(event, payload) {
    var hs = eventListeners.get(event) || [];
    for (var i = 0; i < hs.length; i++) window.__TAURI_INTERNALS__.runCallback(hs[i], { event: event, payload: payload });
  }
  window.__TAURI_INTERNALS__.convertFileSrc = function (p, proto) { return (proto || "asset") + "://localhost/" + encodeURIComponent(p); };
  window.__NAIA_E2E__ = {
    emitEvent: emitEvent,
  };

  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") {
      if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
      eventListeners.get(args.event).push(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
    if (cmd === "plugin:event|unlisten") return;

    if (cmd === "send_to_agent_command") {
      var payload = JSON.parse(args.message);
      window.__E2E_OUTBOUND__.push(payload);
      // 채팅 턴 중 agent 가 BGM 도구를 부르는 상황 재현: chat_request 의 requestId 로
      // app_tool_call(skill_youtube_bgm) → finish. requestId 일치라야 handleChunk 가 처리(실 계약).
      if (payload && payload.type === "chat_request") {
        var rid = payload.requestId;
        var requestedTracks = Array.isArray(window.__E2E_SOAK_TRACKS__)
          ? window.__E2E_SOAK_TRACKS__
          : [
              { action: "play", videoId: "e2evid001", title: "E2E First Track" },
              { action: "play", videoId: "e2evid001", title: "E2E Same Track Replay" }
            ];
        var chunks = requestedTracks.map(function (track, index) {
          return { type: "app_tool_call", requestId: rid, toolCallId: "tc-bgm-" + (index + 1), toolName: "skill_youtube_bgm", args: track };
        });
        chunks.push(
          { type: "text", requestId: rid, text: "재생을 요청했어요. 실제 재생이 확인되면 곡을 소개할게요." },
          { type: "finish", requestId: rid }
        );
		var d = 150;
		var step = Number(window.__E2E_TOOL_DELAY_MS__ || 200);
        for (var i = 0; i < chunks.length; i++) {
          (function (c, ms) { setTimeout(function () { emitEvent("agent_response", JSON.stringify(c)); }, ms); })(chunks[i], d);
		  d += step;
        }
      }
      return null;
    }
    if (cmd === "cancel_stream" || cmd === "send_approval_response") return null;
	if (cmd === "ensure_bgm_server") return { ready: true, port: 18791 };
    return undefined; // → TAURI_BASE_MOCK_FALLBACK 가 부트 기본값 처리
  };
})();
`;

function configScript(cfg: Record<string, unknown>): string {
	return `localStorage.setItem("naia-config", ${JSON.stringify(JSON.stringify(cfg))});`;
}

test.describe("UC8 BGM 스킬 배선 (FR-BGM.1)", () => {
	const iframeRequests: Array<{
		referer: string;
		url: string;
		videoId: string;
		requestedAt: number;
	}> = [];
	const sidecarSearchRequests: string[] = [];
	let sidecarSearchResponses: Array<
		Array<{ id: string; title: string; thumbnail?: string }>
	> = [];
	test.beforeEach(async ({ page }) => {
		iframeRequests.length = 0;
		sidecarSearchRequests.length = 0;
		sidecarSearchResponses = [];
		await page.route("http://localhost:18791/yt/search**", async (route) => {
			const url = new URL(route.request().url());
			sidecarSearchRequests.push(url.searchParams.get("q") ?? "");
			await route.fulfill({
				contentType: "application/json",
				headers: { "access-control-allow-origin": "*" },
				body: JSON.stringify({ results: sidecarSearchResponses.shift() ?? [] }),
			});
		});
		// Deterministic local iframe: this e2e never contacts YouTube.
		await page.route(
			"https://www.youtube-nocookie.com/embed/**",
			async (route) => {
				const requestUrl = route.request().url();
				const videoId = decodeURIComponent(
					new URL(requestUrl).pathname.split("/").at(-1) ?? "",
				);
				iframeRequests.push({
					referer: route.request().headers().referer ?? "",
					url: requestUrl,
					videoId,
					requestedAt: Date.now(),
				});
				const fastSoak = /^fastsoak-(\d+)-(\d+)-/.exec(videoId);
				const soakDurationMs = Number(
					fastSoak?.[1] ?? /^soak-(\d+)-/.exec(videoId)?.[1] ?? 0,
				);
				const readyDelayMs = fastSoak ? 10 : 700;
				const logicalDurationSeconds = fastSoak
					? Number(fastSoak[2])
					: soakDurationMs >= 6000
						? 3600
						: Math.max(30, Math.round(soakDurationMs / 10));
				const holdPlayback =
					videoId.startsWith("hold-") ||
					(videoId === "e2evid001" &&
						iframeRequests.filter((request) => request.videoId === videoId)
							.length >= 2);
				const fixtureBody = videoId.startsWith("timeout-")
					? "<!doctype html><title>Never becomes ready</title>"
					: videoId.startsWith("error-")
						? `<!doctype html><script>
					parent.postMessage(JSON.stringify({ event: "onReady" }), "*");
					setTimeout(() => parent.postMessage(JSON.stringify({ event: "onError", info: 150 }), "*"), 700);
				</script>`
						: holdPlayback
							? `<!doctype html><script>
						parent.postMessage(JSON.stringify({ event: "onReady" }), "*");
						setTimeout(() => parent.postMessage(JSON.stringify({ event: "onStateChange", info: 1 }), "*"), 700);
					</script>`
							: soakDurationMs > 0
								? `<!doctype html><script>
					const durationMs = ${soakDurationMs};
					const mediaDuration = ${logicalDurationSeconds};
					const send = (event, info) => parent.postMessage(JSON.stringify({ event, info }), "*");
					send("onReady");
					const startedAt = Date.now();
					setTimeout(() => {
						send("onStateChange", 1);
						const progress = setInterval(() => {
							const elapsed = Math.min(durationMs, Date.now() - startedAt);
							send("infoDelivery", {
								currentTime: mediaDuration * elapsed / durationMs,
								duration: mediaDuration,
							});
						}, 100);
						setTimeout(() => {
							clearInterval(progress);
							send("infoDelivery", { currentTime: mediaDuration, duration: mediaDuration });
							send("onStateChange", 0);
							send("onStateChange", 0);
						}, durationMs);
					}, ${readyDelayMs});
				</script>`
								: `<!doctype html><script>
					parent.postMessage(JSON.stringify({ event: "onReady" }), "*");
					setTimeout(() => parent.postMessage(JSON.stringify({ event: "onStateChange", info: 1 }), "*"), 700);
					setTimeout(() => parent.postMessage(JSON.stringify({ event: "onStateChange", info: 0 }), "*"), 1500);
				</script>`;
				await route.fulfill({
					contentType: "text/html",
					body: fixtureBody,
				});
			},
		);
		await page.addInitScript(NEW_CORE_FLAG);
		await page.addInitScript(MOCK_SCRIPT);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript({
			content: configScript({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "e2e-mock-key",
				enableTools: true,
				locale: "ko",
				onboardingComplete: true,
			}),
		});
		await page.goto("/");
		await expect(page.locator(".chat-app")).toBeVisible({ timeout: 10_000 });
	});

	test("(A) 부팅 시 skill_youtube_bgm 이 agent 에 등록된다(app_skills 발신)", async ({
		page,
	}) => {
		// App 부팅 effect 의 sendAppSkills 가 outbound 에 쌓일 때까지 대기.
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const out =
							(window as unknown as { __E2E_OUTBOUND__?: unknown[] })
								.__E2E_OUTBOUND__ ?? [];
						return out.some(
							(m) =>
								m &&
								typeof m === "object" &&
								(m as { type?: string }).type === "app_skills" &&
								(m as { appId?: string }).appId === "bgm-widget" &&
								Array.isArray((m as { tools?: unknown[] }).tools) &&
								(m as { tools: { name?: string }[] }).tools.some(
									(t) => t?.name === "skill_youtube_bgm",
								),
						);
					}),
				{ timeout: 10_000 },
			)
			.toBe(true);
	});

	test("(B) 채팅 턴 중 app_tool_call(skill_youtube_bgm) → 위젯이 실제 재생 상태로 전환", async ({
		page,
	}) => {
		// BGM 위젯 마운트 확인. 라이브러리 큐·반복 의미론(#528)에서는 앞 시나리오의
		// 재생 상태가 이어질 수 있으므로 초기 0 단정 대신 명령→재생 전환만 검증한다.
		await expect(page.locator(".bgm-player")).toBeVisible({ timeout: 5_000 });

		// 채팅 전송 → mock 이 chat_request 의 requestId 로 app_tool_call 발신 → dispatch → 재생.
		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled({ timeout: 5_000 });
		await input.fill("잔잔한 음악 틀어줘");
		await input.press("Enter");

		const registrationOrder = await page.evaluate(() => {
			const out =
				(
					window as unknown as {
						__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
					}
				).__E2E_OUTBOUND__ ?? [];
			const chatIndex = out.findIndex(
				(message) => message.type === "chat_request",
			);
			const registrations = out
				.map((message, index) => ({ message, index }))
				.filter(
					({ message }) =>
						message.type === "app_skills" && message.appId === "bgm-widget",
				);
			return {
				chatIndex,
				registrationCount: registrations.length,
				latestRegistrationIndex: registrations.at(-1)?.index ?? -1,
			};
		});
		expect(registrationOrder.registrationCount).toBeGreaterThanOrEqual(2);
		expect(registrationOrder.latestRegistrationIndex).toBeLessThan(
			registrationOrder.chatIndex,
		);

		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const out =
							(
								window as unknown as {
									__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
								}
							).__E2E_OUTBOUND__ ?? [];
						return (
							out.find((message) => message.type === "app_tool_result")
								?.result ?? null
						);
					}),
				{ timeout: 10_000 },
			)
			.not.toBeNull();
		const toolResult = await page.evaluate(() => {
			const out =
				(
					window as unknown as {
						__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
					}
				).__E2E_OUTBOUND__ ?? [];
			return String(
				out.find((message) => message.type === "app_tool_result")?.result ??
					"",
			);
		});
		expect(JSON.parse(toolResult)).toMatchObject({
			playback: { status: "requested" },
			announceTrack: false,
		});
		expect(JSON.parse(toolResult)).not.toHaveProperty("title");

		const toolResults = await page.evaluate(() => {
			const out =
				(
					window as unknown as {
						__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
					}
				).__E2E_OUTBOUND__ ?? [];
			return out
				.filter((message) => message.type === "app_tool_result")
				.map((message) => JSON.parse(String(message.result)));
		});
		expect(toolResults).toHaveLength(2);
		expect(toolResults[1]).toMatchObject({
			queued: { position: 1, selected: { videoId: "e2evid001" } },
			announceTrack: false,
		});

		// 배선 end-to-end 입증: dispatch → executeBgmSkill → bgm_youtube_play → BgmPlayer 재생.
		// #528: 위젯 UI 는 요청 즉시 재생 의도를 낙관 표시한다. 에이전트 진실은
		// 위 tool result 의 status=requested / announceTrack=false 가 계속 보증한다.
		await expect(page.locator(".bgm-icon--playing")).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.locator(".bgm-track-name")).toContainText(
			"E2E First Track",
		);

		// The fixture ends the first iframe. Only then may the queued second track
		// replace it and become visibly playing.
		await expect(page.locator(".bgm-track-name")).toContainText(
			"E2E Same Track Replay",
			{ timeout: 15_000 },
		);
		const iframe = page.locator(".app-bg-iframe");
		await expect(iframe).toHaveAttribute("referrerpolicy", "origin");
		expect(iframeRequests.length).toBeGreaterThanOrEqual(2);
		const shellOrigin = await page.evaluate(() => window.location.origin);
		expect(
			iframeRequests.every(
				(request) =>
					request.referer.length > 0 &&
					new URL(request.referer).origin === shellOrigin,
			),
		).toBe(true);
		const playbackAttempts = iframeRequests.map((request) =>
			new URL(request.url).searchParams.get("naiaPlayback"),
		);
		expect(new Set(playbackAttempts).size).toBeGreaterThanOrEqual(2);

		const playToggle = page.locator(".bgm-btn--play");
		await expect(playToggle).toHaveText("■");
		await expect(playToggle).toHaveAttribute("aria-label", "정지");
		await page.locator(".bgm-icon").click({ force: true });
		const backgroundVideo = page.locator(
			".bgm-yt-background-option input[type=checkbox]",
		);
		await expect(backgroundVideo).toBeChecked();
		await backgroundVideo.uncheck();
		await expect(page.locator("html")).toHaveAttribute(
			"data-bgm-youtube-background",
			"hidden",
		);
		await expect(page.locator(".app-bg-iframe")).toBeAttached();
		await playToggle.click();
		await expect(playToggle).toHaveText("▶");
		await expect(playToggle).toHaveAttribute("aria-label", "재생");
		await expect(page.locator(".bgm-player")).toHaveAttribute(
			"data-bgm-playback-status",
			"paused",
		);
	});

	test("재생 불가 후보를 인지하면 준비된 다음 곡으로 자동 전환한다", async ({
		page,
	}) => {
		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{
					action: "play",
					videoId: "error-unavailable",
					title: "Unavailable Track",
				},
				{ action: "play", videoId: "hold-fallback", title: "Fallback Track" },
			];
		});
		const input = page.locator(".chat-input");
		await expect(page.locator(".bgm-player")).toBeVisible({ timeout: 10_000 });
		await expect(input).toBeEnabled({ timeout: 10_000 });
		await input.fill("요청한 음악을 틀어줘");
		await input.press("Enter");

		const player = page.locator(".bgm-player");
		await page.waitForTimeout(2_000);
		const outbound = await page.evaluate(
			() =>
				(
					window as unknown as {
						__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
					}
				).__E2E_OUTBOUND__ ?? [],
		);
		expect(outbound.map((message) => message.type)).toContain(
			"app_tool_result",
		);
		const appResults = outbound.filter(
			(message) => message.type === "app_tool_result",
		);
		expect(appResults).toHaveLength(2);
		expect(
			appResults.map((message) => JSON.parse(String(message.result))),
		).toMatchObject([
			// 신계약(#528): play ACK 는 관측 전 상태만 말한다 — 선택 곡명은 싣지 않는다.
			{ ok: true, action: "play", playback: { status: "requested" }, announceTrack: false },
			{ queued: { selected: { videoId: "hold-fallback" } } },
		]);
		expect(iframeRequests.map((request) => request.videoId)).toContain(
			"error-unavailable",
		);
		await expect(player).toHaveAttribute(
			"data-bgm-current-title",
			"Fallback Track",
			{ timeout: 15_000 },
		);
		await expect(player).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
			{
				timeout: 15_000,
			},
		);
		expect(iframeRequests.map((request) => request.videoId).slice(-2)).toEqual([
			"error-unavailable",
			"hold-fallback",
		]);
	});

	test("Radio DJ 준비 후보가 없으면 제한된 새 검색으로 재생을 복구한다", async ({
		page,
	}) => {
		sidecarSearchResponses = [
			[{ id: "error-dynamic-initial", title: "Unavailable Dynamic Track" }],
			[
				{
					id: "duplicate-dynamic",
					title: "Unavailable Dynamic Track (Official Video)",
				},
				{ id: "hold-dynamic-recovered", title: "Dynamically Recovered Track" },
			],
		];
		await page.evaluate(() => {
			const config = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					...config,
					proactiveSpeechProfile: "personal_radio_dj",
					proactiveSpeechPermitted: true,
				}),
			);
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{
					action: "play",
					query: "dynamic recovery jazz",
					mode: "radio_dj",
				},
			];
		});
		const input = page.locator(".chat-input");
		await input.fill("라디오 DJ로 재생 불가 곡도 알아서 바꿔줘");
		await input.press("Enter");
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const messages =
							(
								window as unknown as {
									__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
								}
							).__E2E_OUTBOUND__ ?? [];
						const result = messages.find(
							(message) => message.type === "app_tool_result",
						);
						return result
							? { success: result.success, result: result.result }
							: null;
					}),
				{ timeout: 5_000 },
			)
			.not.toBeNull();
		const radioToolResult = await page.evaluate(() => {
			const messages =
				(
					window as unknown as {
						__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
					}
				).__E2E_OUTBOUND__ ?? [];
			return messages.find((message) => message.type === "app_tool_result");
		});
		expect(
			radioToolResult?.success,
			String(radioToolResult?.result ?? "missing app tool result"),
		).toBe(true);

		const player = page.locator(".bgm-player");
		await expect(player).toHaveAttribute(
			"data-bgm-current-title",
			"Dynamically Recovered Track",
			{ timeout: 15_000 },
		);
		await expect(player).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
			{
				timeout: 15_000,
			},
		);
		expect(sidecarSearchRequests).toEqual([
			"dynamic recovery jazz",
			"dynamic recovery jazz",
		]);
		expect(iframeRequests.map((request) => request.videoId)).toEqual([
			"error-dynamic-initial",
			"hold-dynamic-recovered",
		]);
	});

	test("재생 관측 시간초과만으로는 재생 중인 곡을 다른 곡으로 바꾸지 않는다", async ({
		page,
	}) => {
		// 2026-08-08 field review: the 12s watchdog used to force-skip to the
		// queued track on elapsed time alone. That is exactly what caused songs
		// to change before they had actually ended — the "playing" *message* can
		// be lost (documented WebView2 handshake risk) even though the track
		// itself is fine. Only a real onError (see the next test) is now treated
		// as failure evidence; a pure timeout is diagnostic-only and must leave
		// the current track and the queue untouched.
		test.setTimeout(45_000);
		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{
					action: "play",
					videoId: "timeout-silent",
					title: "Silent Candidate",
				},
				{
					action: "play",
					videoId: "hold-timeout-fallback",
					title: "Timeout Fallback",
				},
			];
		});
		const input = page.locator(".chat-input");
		await input.fill("응답이 없는 곡과 대체곡을 실행해줘");
		await input.press("Enter");

		const player = page.locator(".bgm-player");
		await expect(player).toHaveAttribute(
			"data-bgm-current-title",
			"Silent Candidate",
		);
		await expect(player).toHaveAttribute("data-bgm-queue-length", "1");
		// The watchdog marks a diagnostic "timeout" status once its window
		// elapses, but must not touch the current track or the queue.
		await expect(player).toHaveAttribute(
			"data-bgm-playback-status",
			"timeout",
			{
				timeout: 25_000,
			},
		);
		await page.waitForTimeout(2_000);
		await expect(player).toHaveAttribute(
			"data-bgm-current-title",
			"Silent Candidate",
		);
		await expect(player).toHaveAttribute("data-bgm-queue-length", "1");
		expect(iframeRequests.map((request) => request.videoId)).toEqual([
			"timeout-silent",
		]);
	});

	test("재생 불가 후보가 고갈되면 오류 상태에서 멈추고 재시도를 반복하지 않는다", async ({
		page,
	}) => {
		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{
					action: "play",
					videoId: "error-only",
					title: "Only Unavailable Track",
				},
			];
		});
		const input = page.locator(".chat-input");
		await input.fill("재생할 수 없는 단일 후보를 실행해줘");
		await input.press("Enter");

		const player = page.locator(".bgm-player");
		await expect(player).toHaveAttribute("data-bgm-playback-status", "error", {
			timeout: 15_000,
		});
		await expect(player).toHaveAttribute("data-bgm-queue-length", "0");
		const attemptsAtFailure = iframeRequests.length;
		await page.waitForTimeout(2_000);
		expect(iframeRequests).toHaveLength(attemptsAtFailure);
		expect(iframeRequests.map((request) => request.videoId)).toEqual([
			"error-only",
		]);
		await expect(page.locator(".bgm-icon--playing")).toHaveCount(0);
	});

	test("음악 중 일반 대화가 끼어도 BGM을 교체하거나 멈추지 않는다", async ({
		page,
	}) => {
		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{
					action: "play",
					videoId: "hold-conversation",
					title: "Conversation Bed",
				},
			];
		});
		const input = page.locator(".chat-input");
		await expect(page.locator(".bgm-player")).toBeVisible({ timeout: 10_000 });
		await expect(input).toBeEnabled({ timeout: 10_000 });
		await input.fill("음악 틀어줘");
		await input.press("Enter");
		const player = page.locator(".bgm-player");
		await expect(player).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
			{
				timeout: 15_000,
			},
		);
		const attemptsBeforeConversation = iframeRequests.length;

		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [];
		});
		await input.fill("그런데 오늘 일정은 어때?");
		await input.press("Enter");
		await page.waitForTimeout(1_000);
		await expect(player).toHaveAttribute(
			"data-bgm-current-title",
			"Conversation Bed",
		);
		await expect(player).toHaveAttribute("data-bgm-playback-status", "playing");
		expect(iframeRequests).toHaveLength(attemptsBeforeConversation);
	});

	test("음성 도구 흐름으로 즐겨찾기를 등록하고 다시 재생한다", async ({
		page,
	}) => {
		const input = page.locator(".chat-input");
		await expect(page.locator(".bgm-player")).toBeVisible({ timeout: 10_000 });
		await expect(input).toBeEnabled({ timeout: 10_000 });
		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{ action: "play", videoId: "hold-favorite", title: "Favorite Track" },
				{ action: "favorite_add" },
			];
		});
		await input.fill("첫 번째 음악 명령을 실행해줘");
		await input.press("Enter");
		await expect
			.poll(() =>
				page.evaluate(() => {
					// #528+#543: 좋아요 SoT = BGM 라이브러리(앱 샌드박스). 브라우저 E2E 는
					// mock 샌드박스 파일계에서 같은 파일을 판독한다.
					const sandbox = (
						window as unknown as {
							__E2E_SANDBOX_FS__?: Record<string, number[]>;
						}
					).__E2E_SANDBOX_FS__;
					const bytes = sandbox?.["land.naia.shell/bgm/library.json"];
					if (!bytes) return [];
					const library = JSON.parse(
						new TextDecoder().decode(Uint8Array.from(bytes)),
					) as { likes?: Array<{ youtubeId?: string }> };
					return (library.likes ?? []).map((track) => track.youtubeId ?? "");
				}),
			)
			.toContain("hold-favorite");

		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{
					action: "play",
					videoId: "hold-other",
					title: "Other Track",
					replace: true,
				},
				{ action: "favorites_play" },
			];
		});
		await input.fill("두 번째 음악 명령을 실행해줘");
		await input.press("Enter");
		await expect(page.locator(".bgm-player")).toHaveAttribute(
			"data-bgm-current-title",
			"Favorite Track",
			{ timeout: 15_000 },
		);

		const resultCountBeforeRemoval = await page.evaluate(
			() =>
				(
					window as unknown as {
						__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
					}
				).__E2E_OUTBOUND__?.filter(
					(message) => message.type === "app_tool_result",
				).length ?? 0,
		);
		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{ action: "favorite_remove" },
				{ action: "favorites_play" },
			];
		});
		await input.fill("현재 곡을 즐겨찾기에서 지우고 빈 목록을 재생해줘");
		await input.press("Enter");
		await expect
			.poll(() =>
				page.evaluate(() => {
					const favorites = (JSON.parse(
						localStorage.getItem("naia-config") ?? "{}",
					).bgmYoutubeFavorites ?? []) as Array<{ id: string }>;
					return favorites.length;
				}),
			)
			.toBe(0);
		await expect
			.poll(() =>
				page.evaluate((before) => {
					const results =
						(
							window as unknown as {
								__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
							}
						).__E2E_OUTBOUND__?.filter(
							(message) => message.type === "app_tool_result",
						) ?? [];
					return results
						.slice(before)
						.map((message) => JSON.parse(String(message.result)));
				}, resultCountBeforeRemoval),
			)
			.toMatchObject([
				{ ok: true, action: "favorite_remove" },
				{ ok: false, action: "favorites_play", reason: "no_favorites" },
			]);
	});

	test("사용자 곡 교체는 준비된 대기열을 폐기하고 새 곡을 즉시 소유한다", async ({
		page,
	}) => {
		const input = page.locator(".chat-input");
		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{ action: "play", videoId: "hold-original", title: "Original Track" },
				{ action: "play", videoId: "hold-prepared", title: "Prepared Track" },
			];
		});
		await input.fill("라디오를 시작해줘");
		await input.press("Enter");
		const player = page.locator(".bgm-player");
		await expect(player).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
			{
				timeout: 15_000,
			},
		);
		await expect(player).toHaveAttribute("data-bgm-queue-length", "1");

		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{
					action: "play",
					videoId: "hold-user-choice",
					title: "User Choice",
					replace: true,
				},
			];
		});
		await input.fill("다른 곡으로 바로 바꿔줘");
		await input.press("Enter");
		await expect(player).toHaveAttribute(
			"data-bgm-current-title",
			"User Choice",
			{
				timeout: 15_000,
			},
		);
		await expect(player).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
			{
				timeout: 15_000,
			},
		);
		await expect(player).toHaveAttribute("data-bgm-queue-length", "0");
		expect(iframeRequests.map((request) => request.videoId)).toEqual([
			"hold-original",
			"hold-user-choice",
		]);
	});

	test("정지는 현재 재생과 대기열을 끝내고 늦은 자동 전환을 만들지 않는다", async ({
		page,
	}) => {
		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [
				{ action: "play", videoId: "hold-stop-current", title: "Stop Current" },
				{
					action: "play",
					videoId: "hold-must-not-start",
					title: "Must Not Start",
				},
			];
		});
		const input = page.locator(".chat-input");
		await input.fill("음악 두 곡을 이어서 틀어줘");
		await input.press("Enter");
		const player = page.locator(".bgm-player");
		await expect(player).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
			{
				timeout: 15_000,
			},
		);
		await expect(player).toHaveAttribute("data-bgm-queue-length", "1");

		await page.evaluate(() => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = [{ action: "stop" }];
		});
		await input.fill("라디오 그만");
		await input.press("Enter");
		await expect(player).toHaveAttribute("data-bgm-playback-status", "ended", {
			timeout: 15_000,
		});
		await expect(player).toHaveAttribute("data-bgm-queue-length", "0");
		const attemptsAtStop = iframeRequests.length;
		await page.waitForTimeout(2_000);
		expect(iframeRequests).toHaveLength(attemptsAtStop);
		expect(iframeRequests.map((request) => request.videoId)).toEqual([
			"hold-stop-current",
		]);
		await expect(page.locator(".bgm-icon--playing")).toHaveCount(0);
	});

	test("가변 길이 10곡을 종료 기준으로 연속 재생하고 긴 곡 관측을 5초 넘게 유지한다", async ({
		page,
	}) => {
		test.setTimeout(Math.max(60_000, LONG_TRACK_WALL_MS + 60_000));
		const runtimeErrors: string[] = [];
		page.on("pageerror", (error) =>
			runtimeErrors.push(error.stack ?? error.message),
		);
		page.on("console", (message) => {
			// 출처 URL 을 함께 기록 — "Failed to load resource: net::ERR_FAILED" 는
			// 본문에 URL 이 없어 아래 필터가 announcements 노이즈를 귀속할 수 없다.
			if (message.type() === "error")
				runtimeErrors.push(
					`${message.text()} [${message.location().url ?? ""}]`,
				);
		});
		const tracks = [
			{
				videoId: `soak-${LONG_TRACK_WALL_MS}-0`,
				title: "Long 60 Minute Mix",
			},
			{ videoId: "soak-250-1", title: "Short Track 1" },
			{ videoId: "soak-1700-2", title: "Medium Track 2" },
			{ videoId: "soak-400-3", title: "Short Track 3" },
			{ videoId: "soak-2300-4", title: "Long Track 4" },
			{ videoId: "soak-300-5", title: "Short Track 5" },
			{ videoId: "soak-1200-6", title: "Medium Track 6" },
			{ videoId: "soak-700-7", title: "Short Track 7" },
			{ videoId: "soak-1900-8", title: "Medium Track 8" },
			{ videoId: "soak-500-9", title: "Final Track 9" },
		];
		const player = page.locator(".bgm-player");
		await page.evaluate((queuedTracks) => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = queuedTracks.map((track) => ({
				action: "play",
				...track,
			}));
		}, tracks);
		const input = page.locator(".chat-input");
		await input.fill("가변 길이 라디오 장기 재생");
		await input.press("Enter");

		await expect(player).toHaveAttribute(
			"data-bgm-current-title",
			tracks[0].title,
		);
		await expect(player).toHaveAttribute("data-bgm-queue-length", "9");
		await page.waitForTimeout(5_300);
		await expect(player).toHaveAttribute("data-bgm-playback-status", "playing");
		expect(
			Number(await player.getAttribute("data-bgm-current-time")),
		).toBeGreaterThan(0);
		expect(Number(await player.getAttribute("data-bgm-duration"))).toBe(3600);

		for (const [index, track] of tracks.slice(1).entries()) {
			await expect(player).toHaveAttribute(
				"data-bgm-current-title",
				track.title,
				{
					timeout: index === 0 ? LONG_TRACK_WALL_MS + 10_000 : 10_000,
				},
			);
		}
		await expect(player).toHaveAttribute("data-bgm-playback-status", "ended", {
			timeout: 10_000,
		});
		await expect(player).toHaveAttribute("data-bgm-queue-length", "0");
		expect(iframeRequests.map((request) => request.videoId)).toEqual(
			tracks.map((track) => track.videoId),
		);
		const playbackAttempts = iframeRequests.map((request) =>
			new URL(request.url).searchParams.get("naiaPlayback"),
		);
		expect(new Set(playbackAttempts).size).toBe(tracks.length);
		for (let index = 0; index < iframeRequests.length - 1; index += 1) {
			const durationMs = Number(
				/^soak-(\d+)-/.exec(iframeRequests[index].videoId)?.[1] ?? 0,
			);
			expect(
				iframeRequests[index + 1].requestedAt -
					iframeRequests[index].requestedAt,
			).toBeGreaterThanOrEqual(durationMs);
		}
		const bgmRuntimeErrors = runtimeErrors.filter(
			(error) =>
				!error.includes("BrowserCenterArea.tsx") &&
				!error.includes("AvatarCanvas") &&
				!error.includes("net::ERR_CONNECTION_REFUSED") &&
				// 비표준 포트(dev :1436 등)에선 www.naia.land/api/announcements 의
				// CORS 거부와 그에 따른 net::ERR_FAILED 가 콘솔 오류로 잡힌다 —
				// announcements 로 귀속되는 그 계열만 좁게 제외한다(무관 네트워크
				// 노이즈; youtube/bgm 오류 검출력은 유지).
				!(
					error.includes("naia.land/api/announcements") &&
					/CORS|net::ERR_FAILED|Failed to load resource|Failed to fetch/.test(
						error,
					)
				),
		);
		expect(bgmRuntimeErrors).toEqual([]);
	});

	test("논리시간 2시간 체크포인트와 8시간 60곡 soak를 유한 상태로 완주한다", async ({
		page,
	}) => {
		test.setTimeout(60_000);
		const runtimeErrors: string[] = [];
		page.on("pageerror", (error) =>
			runtimeErrors.push(error.stack ?? error.message),
		);
		const logicalTrackSeconds = 480;
		const tracks = Array.from({ length: 60 }, (_, index) => ({
			videoId: `fastsoak-${index === 0 ? 700 : 120}-${logicalTrackSeconds}-${index}`,
			title: `Accelerated Soak Track ${String(index + 1).padStart(2, "0")}`,
		}));
		await page.evaluate((queuedTracks) => {
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
					__E2E_TOOL_DELAY_MS__?: number;
				}
			).__E2E_TOOL_DELAY_MS__ = 5;
			(
				window as typeof window & {
					__E2E_SOAK_TRACKS__?: Array<Record<string, unknown>>;
				}
			).__E2E_SOAK_TRACKS__ = queuedTracks.map((track) => ({
				action: "play",
				...track,
			}));
		}, tracks);
		const input = page.locator(".chat-input");
		await input.fill("8시간 상당 가속 라디오 soak");
		await input.press("Enter");
		const player = page.locator(".bgm-player");

		await expect(player).toHaveAttribute("data-bgm-queue-length", "59", {
			timeout: 10_000,
		});
		await expect
			.poll(() => iframeRequests.length, { timeout: 15_000 })
			.toBeGreaterThanOrEqual(15);
		expect(15 * logicalTrackSeconds).toBe(2 * 60 * 60);

		await expect(player).toHaveAttribute("data-bgm-playback-status", "ended", {
			timeout: 30_000,
		});
		await expect(player).toHaveAttribute("data-bgm-queue-length", "0");
		expect(60 * logicalTrackSeconds).toBe(8 * 60 * 60);
		expect(iframeRequests.map((request) => request.videoId)).toEqual(
			tracks.map((track) => track.videoId),
		);
		const playbackIds = iframeRequests.map((request) =>
			new URL(request.url).searchParams.get("naiaPlayback"),
		);
		expect(new Set(playbackIds).size).toBe(tracks.length);
		const recentTracks = await page.evaluate(
			() =>
				JSON.parse(localStorage.getItem("yt-bgm-recent-v1") ?? "[]") as Array<{
					id: string;
				}>,
		);
		expect(recentTracks).toHaveLength(20);
		expect(new Set(recentTracks.map((track) => track.id)).size).toBe(20);
		expect(recentTracks[0].id).toBe(tracks.at(-1)?.videoId);
		const bgmRuntimeErrors = runtimeErrors.filter(
			(error) =>
				!error.includes("BrowserCenterArea.tsx") &&
				!error.includes("AvatarCanvas") &&
				!error.includes("net::ERR_CONNECTION_REFUSED"),
		);
		expect(bgmRuntimeErrors).toEqual([]);
	});
});
