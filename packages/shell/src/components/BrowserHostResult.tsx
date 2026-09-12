/**
 * #582 S6a — 브라우저 호스트 도구 결과 카드 (P04 시각·UX).
 *
 * 이 카드가 답해야 하는 질문은 하나다: **나이아가 방금 무엇을 했고, 그 증거는 무엇인가.**
 * 백그라운드 브라우저는 화면이 없어서 사용자가 직접 볼 수 없다. 그래서 증거 셋 —
 * 스냅샷 참조·캡처 참조·주소와 개정 — 을 카드가 대신 보여 준다 (FR-ENV-TOOL.6).
 *
 * 여섯 상태를 모두 그린다(verify-visual-ux).
 *   기본   접힌 헤더에 도구 이름과 주소 한 줄
 *   빈     작업 공간이 하나도 없을 때 "없음"과 다음 행동을 구분해 적는다
 *   진행   status=running — 증거 자리를 비워 두지 않고 "받는 중"이라고 말한다
 *   성공   증거 셋
 *   오류   거부 사유를 코드와 설명으로 그대로. 재시도 전에 할 일을 함께 적는다
 *   좁은 폭 1,100px 이하에서 증거 표가 두 줄로 접힌다(전용 CSS)
 */

import { isBrowserHostTool, type BrowserHostCard } from "../lib/browser-host-skill";

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * 도구 결과 문자열을 카드로 읽는다. 형태가 어긋나면 null 이고, 그때 호출자는 기본 렌더로 돌아간다 —
 * 파싱 실패를 빈 카드로 그리면 "증거가 없다"와 "읽지 못했다"가 같은 그림이 된다.
 */
export function parseBrowserHostCard(output: string | undefined): BrowserHostCard | null {
	if (!output) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return null;
	}
	if (!isObject(parsed) || parsed.kind !== "browser-host") return null;
	if (typeof parsed.tool !== "string" || typeof parsed.status !== "string") return null;
	return parsed as unknown as BrowserHostCard;
}

/**
 * 도구 하나를 카드로 그릴 수 있는가. 아직 결과가 없는 진행 중 호출도 카드가 필요하다 —
 * 진행 중에 아무 자리도 없으면 사용자는 "브라우저에서 무엇이 도는지"를 볼 수 없다.
 */
export function browserHostCardFor(
	toolName: string,
	output: string | undefined,
): BrowserHostCard | null {
	const parsed = parseBrowserHostCard(output);
	if (parsed) return parsed;
	if (!isBrowserHostTool(toolName)) return null;
	return { kind: "browser-host", tool: toolName, status: "pending", workspaceId: "" };
}

/** 거부 사유를 사람이 읽을 다음 행동으로 옮긴다. 원시 코드만 보여 주면 복구할 수 없다. */
export function recoveryHint(code: string): string {
	switch (code) {
		case "approval-missing":
			return "이 실행은 호출마다 승인이 필요합니다. 승인한 뒤 다시 요청하세요.";
		case "capability-denied":
			return "이 작업에 필요한 권한이 부여되어 있지 않습니다. 설정에서 권한을 확인하세요.";
		case "timeout":
			return "제한 시간 안에 끝나지 않았습니다. 범위를 좁혀 다시 시도하세요.";
		case "cancelled":
			return "중단된 작업입니다. 이미 일어난 변화는 그대로 남아 있습니다.";
		case "disconnected":
			return "브라우저 호스트에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.";
		case "stale-ref":
			return "참조가 낡았습니다. 스냅샷을 다시 찍은 뒤 그 참조로 조작하세요.";
		case "method-denied":
			return "정책이 막은 동작입니다. 다른 방법을 찾거나 사람이 직접 하세요.";
		case "workspace-escape":
			return "요청 형식이 맞지 않습니다. 인자를 확인하세요.";
		default:
			return "같은 요청을 그대로 반복하지 말고 원인을 먼저 확인하세요.";
	}
}

interface Props {
	readonly card: BrowserHostCard;
	/** 도구 호출의 진행 상태. running 이면 카드가 아직 증거를 못 받았다. */
	readonly status: "running" | "success" | "error";
}

export function BrowserHostResult({ card, status }: Props) {
	const evidence = card.evidence;
	const workspaces = card.workspaces;

	return (
		<div className="browser-host-card" data-tool={card.tool} data-status={card.status}>
			<div className="browser-host-head">
				<span className="browser-host-space" title="작업 공간">
					{card.workspaceId || "작업 공간 선택 전"}
				</span>
				<span className="browser-host-badge" data-state={card.status}>
					{status === "running" || card.status === "pending"
						? "실행 중"
						: card.status === "success"
							? "완료"
							: card.status === "refused"
								? "거절됨"
								: "오류"}
				</span>
			</div>

			{status === "running" && (
				<output className="browser-host-progress" aria-live="polite">
					브라우저에서 실행 중입니다 — 증거를 받는 중
				</output>
			)}

			{evidence && (
				<dl className="browser-host-evidence">
					<div className="browser-host-evidence-row">
						<dt>주소</dt>
						<dd className="browser-host-url">
							{evidence.url}
							<span className="browser-host-revision">개정 {evidence.urlRevision}</span>
						</dd>
					</div>
					<div className="browser-host-evidence-row">
						<dt>스냅샷</dt>
						<dd>{evidence.snapshotRef || "없음"}</dd>
					</div>
					<div className="browser-host-evidence-row">
						<dt>캡처</dt>
						<dd>{evidence.screenshotRef || "없음"}</dd>
					</div>
				</dl>
			)}

			{workspaces !== undefined &&
				(workspaces.length === 0 ? (
					<p className="browser-host-empty">
						열려 있는 작업 공간이 없습니다. 새 공간을 열면 그 안에서 웹 작업이 시작됩니다.
					</p>
				) : (
					<ul className="browser-host-spaces">
						{workspaces.map((space) => (
							<li key={space.id}>
								<span className="browser-host-space-id">{space.id}</span>
								<span className="browser-host-space-meta">
									{space.mode === "headless" ? "화면 없음" : space.mode} · 개정 {space.revision}
								</span>
							</li>
						))}
					</ul>
				))}

			{card.result !== undefined && card.result !== "" && (
				<pre className="browser-host-value">{card.result}</pre>
			)}

			{card.notes?.map((note) => (
				<p className="browser-host-note" key={note}>
					{note}
				</p>
			))}

			{card.refusals && card.refusals.length > 0 && (
				<div className="browser-host-refusals" role="alert">
					{card.refusals.map((refusal) => (
						<div className="browser-host-refusal" key={`${refusal.code}:${refusal.detail}`}>
							<span className="browser-host-refusal-code">{refusal.code}</span>
							<span className="browser-host-refusal-detail">{refusal.detail}</span>
							<span className="browser-host-refusal-hint">{recoveryHint(refusal.code)}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
