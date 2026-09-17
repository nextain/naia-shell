/**
 * 자격증명 등급의 게이트웨이 키를 에이전트에 실어 주는 `creds_update` IPC 의
 * **인자**를 만든다 (#590). 순수 함수 — 창도 환경도 건드리지 않는다.
 *
 * 왜 따로 빼는가. `deliverCredentialedGatewayKey` 는 `browser.execute` 안에서
 * `invoke("send_to_agent_command", …)` 를 부르는데, 그 자리를 실앱 없이 잴 수는
 * 없다. 그래서 "무엇을 invoke 에 넘기는가" 를 이 순수 함수로 떼어, 맨 노드에서
 * `node --test` 로 못 박는다.
 *
 * ## 왜 adkPath 가 반드시 있어야 하는가
 *
 * 네이티브는 `send_to_agent_command` 로 오는 캐시 대상 startup 메시지
 * (`auth_update`/`notify_config`/`creds_update`)가 **자기를 낳은 워크스페이스**를
 * 실어 오기를 요구한다 (lib.rs `StartupMessageCache::validate_source`, #547 의
 * "bind auth replay to selected ADK" 이후). 워크스페이스가 없으면 그 자리에서
 * `startup message IPC requires an ADK path` 로 거절한다.
 *
 * 하네스가 이 값을 빠뜨리면 시딩한 격리 ADK 에 살아 있는 키가 영영 닿지 못하고,
 * `deliverCredentialedGatewayKey` 가 던지는 `creds_update failed` 로 before() 가
 * 죽어 자격증명 등급 스펙(로그인+도구 호출, 재시작 뒤 메모리)이 채팅에 닿기도
 * 전에 무너진다. win-rtx2070 에서 #590 항목 5·6 이 "startup-message IPC 에러" 로
 * 돌지 못한 것이 이것이다 — 격리 ADK 가 하이드레이트되지 않은 것으로 보였다.
 *
 * 스코프는 프런트가 `write_naia_path_cache(normalized)` 로 묶는데(adk-store 의
 * `setAdkPath` 가 끝의 슬래시·역슬래시를 떼고 넘긴다), 그 값의 정본은 localStorage
 * 의 `naia-adk-path` 다. 부르는 쪽은 **바로 그 값을** 읽어 이리로 넘겨야 한다.
 * 환경의 `NAIA_E2E_ADK_PATH`(Node `resolve` 산출 — 윈도우에서는 역슬래시)를 그냥
 * 넘기면 스코프가 묶인 형태와 어긋나 `stale ADK startup IPC rejected` 로 갈릴 수
 * 있어, 그 어긋남을 없애려 여기서도 같은 규칙으로 한 번 더 정규화한다.
 */

/** 스코프 바인딩(setAdkPath)과 같은 규칙으로 끝의 슬래시·역슬래시를 뗀다. */
export function normalizeBoundAdkPath(adkPath) {
	if (typeof adkPath !== "string") return "";
	return adkPath.trim().replace(/[/\\]+$/, "");
}

/**
 * `send_to_agent_command` 에 넘길 인자 `{ message, adkPath }` 를 만든다.
 * `adkPath` 가 비어 있으면(=격리 ADK 가 아직 하이드레이트되지 않음) 던진다 —
 * 네이티브가 조용히 거절하기 전에, 무엇이 없는지 분명히 말하는 자리다.
 *
 * @param {{ provider?: string, naiaKey?: string, adkPath?: string | null }} options
 * @returns {{ message: string, adkPath: string }}
 */
export function buildCredsUpdateInvokeArgs(options = {}) {
	const { provider, naiaKey } = options;
	const adkPath = normalizeBoundAdkPath(options.adkPath ?? "");
	if (!adkPath) {
		throw new Error(
			"creds_update requires a bound ADK path: the isolated workspace was " +
				"never hydrated (localStorage 'naia-adk-path' is empty). Native " +
				"send_to_agent_command rejects a cacheable startup message with no " +
				"workspace (startup message IPC requires an ADK path).",
		);
	}
	if (!provider) {
		throw new Error("creds_update requires a provider");
	}
	return {
		message: JSON.stringify({
			type: "creds_update",
			// 심을 때 고른 provider 와 같아야 한다. 환경으로 바꿔 끼웠는데 키를
			// 기본 provider 슬롯에 넣으면 그 키가 영영 안 쓰인다.
			provider,
			naiaKey: naiaKey ?? "",
		}),
		adkPath,
	};
}
