import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";

/**
 * 70c — 실 기본 프로바이더(nextain 게이트웨이, DeepSeek V4 Flash) 라이브 대화 E2E
 *
 * UC-LLM-DEFAULT-DEEPSEEK-FLASH의 배포 기본 경로(naia 키 → nextain 게이트웨이 →
 * deepseek-v4-flash)로 실제 대화가 완주하는지 실 UI(설정 탭 전환→저장→채팅)로
 * 검증한다. v0.2.2 실사용 QA에서 이 경로의 자동 e2e 부재가 갭으로 확인됐다
 * (naia-shell#476 Scope 8).
 *
 * NAIA_API_KEY(유료 테스트 회원 gw- 키)가 없으면 skip — 키 없는 CI에서 무해.
 * 세션을 공유하는 다른 스펙을 오염시키지 않도록 종료 시 원래 provider 로 복원한다.
 */
const E2E_NAIA_KEY = process.env.NAIA_API_KEY;

async function waitAppRoot(): Promise<void> {
	await browser.waitUntil(
		() => browser.execute(() => document.querySelector(".app-root") !== null),
		{ timeout: 30_000, timeoutMsg: "Shell app root did not restore" },
	);
}

/**
 * provider/model 전환 — SettingsTab 저장과 같은 경로(localStorage naia-config +
 * write_naia_config IPC 로 워크스페이스 config.json 동기)로 전환한다. 설정 UI
 * 내비게이션은 3-탭 개편 이후 e2e 셀렉터가 전면 드리프트라(#476 후속) 여기서는
 * 구성 계층에서 전환하고, 대화 완주 자체를 실 UI(sendMessage)로 검증한다.
 */
async function switchProviderViaSettings(
	provider: string,
	model: string,
): Promise<void> {
	await browser.execute(
		async (p: string, m: string) => {
			const shell = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (command: string, value: unknown) => Promise<unknown>;
				};
			};
			const invoke = shell.__TAURI_INTERNALS__?.invoke;
			if (!invoke) throw new Error("Tauri invoke unavailable");
			const raw = localStorage.getItem("naia-config");
			const config = raw
				? (JSON.parse(raw) as Record<string, unknown>)
				: {};
			const next = {
				...config,
				provider: p,
				model: m,
				onboardingComplete: true,
			};
			localStorage.setItem("naia-config", JSON.stringify(next));
			const adkPath = localStorage.getItem("naia-adk-path");
			if (adkPath) {
				const { naiaKey: _nk, apiKey: _ak, ...publicConfig } = next as Record<
					string,
					unknown
				>;
				await invoke("write_naia_config", {
					adkPath,
					json: JSON.stringify(publicConfig, null, 2),
				});
			}
		},
		provider,
		model,
	);
	await browser.refresh();
	await waitAppRoot();
	await browser.pause(1_500);
}

describe("70c — nextain default-provider live chat", () => {
	const testFn = E2E_NAIA_KEY?.startsWith("gw-") ? it : it.skip;

	testFn("naia 키 + nextain/deepseek-v4-flash 기본 슬롯으로 실 대화가 완주한다", async () => {
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 30_000 });

		// naia 회원 키는 apikey 입력이 아니라 보안 저장(keychain 대역)으로 공급된다.
		await browser.execute(async (naiaKey: string) => {
			const shell = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (command: string, value: unknown) => Promise<unknown>;
				};
			};
			const invoke = shell.__TAURI_INTERNALS__?.invoke;
			if (!invoke) throw new Error("Tauri invoke unavailable");
			await invoke("e2e_seed_secure_naia_key", { naiaKey });
		}, E2E_NAIA_KEY as string);

		try {
			await switchProviderViaSettings("nextain", "deepseek-v4-flash");
			// refresh 가 프론트 자격 상태를 재수화하므로 전환 후 한 번 더 주입한다.
			await browser.execute(async (naiaKey: string) => {
				const shell = window as unknown as {
					__TAURI_INTERNALS__?: {
						invoke: (command: string, value: unknown) => Promise<unknown>;
					};
				};
				await shell.__TAURI_INTERNALS__?.invoke("e2e_seed_secure_naia_key", {
					naiaKey,
				});
			}, E2E_NAIA_KEY as string);
			// initAuth(auth_update 전송)는 앱 로드 시 1회 실행 — 키 주입 후 재로드해야
			// naiaKey 가 agent 로 전파된다.
			await browser.refresh();
			await waitAppRoot();
			await browser.pause(1_500);
			// 결정론 보강: 로그인 경로(sendAuthUpdate)와 같은 wire 로 creds_update 를 직접 전송.
			await browser.execute(async (naiaKey: string) => {
				const shell = window as unknown as {
					__TAURI_INTERNALS__?: {
						invoke: (command: string, value: unknown) => Promise<unknown>;
					};
				};
				await shell.__TAURI_INTERNALS__?.invoke("send_to_agent_command", {
					message: JSON.stringify({
						type: "creds_update",
						provider: "nextain",
						naiaKey,
					}),
				});
			}, E2E_NAIA_KEY as string);
			await browser.pause(500);

			await sendMessage("안녕! 지금 응답 가능한지 한 문장으로만 답해줘.", {
				completedMessageTimeoutMs: 120_000,
			});
			const reply = await getLastAssistantMessage();
			console.log(`[E2E] nextain/deepseek-v4-flash response: ${reply}`);
			expect(reply.length).toBeGreaterThan(0);
			expect(reply).not.toMatch(/\[오류\]|API key|Bad Request|not found|Error/i);
		} finally {
			// 세션 공유 스펙 오염 방지 — e2e 기본 provider 로 복원
			await switchProviderViaSettings("codex", "gpt-5.4");
		}
	});
});
