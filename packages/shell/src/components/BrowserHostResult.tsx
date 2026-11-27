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
import { t } from "../lib/i18n";

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
			return t("g1b.hostRecApproval");
		case "capability-denied":
			return t("g1b.hostRecCapability");
		case "timeout":
			return t("g1b.hostRecTimeout");
		case "cancelled":
			return t("g1b.hostRecCancelled");
		case "disconnected":
			return t("g1b.hostRecDisconnected");
		case "stale-ref":
			return t("g1b.hostRecStaleRef");
		case "method-denied":
			return t("g1b.hostRecMethodDenied");
		case "workspace-escape":
			return t("g1b.hostRecWorkspaceEscape");
		default:
			return t("g1b.hostRecDefault");
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
				<span className="browser-host-space" title={t("g1b.hostWorkspaceTitle")}>
					{card.workspaceId || t("g1b.hostNoWorkspace")}
				</span>
				<span className="browser-host-badge" data-state={card.status}>
					{status === "running" || card.status === "pending"
						? t("g1b.hostStatusRunning")
						: card.status === "success"
							? t("g1b.hostStatusDone")
							: card.status === "refused"
								? t("g1b.hostStatusRefused")
								: t("chat.error")}
				</span>
			</div>

			{status === "running" && (
				<output className="browser-host-progress" aria-live="polite">
					{t("g1b.hostProgress")}
				</output>
			)}

			{evidence && (
				<dl className="browser-host-evidence">
					<div className="browser-host-evidence-row">
						<dt>{t("g1b.hostAddrLabel")}</dt>
						<dd className="browser-host-url">
							{evidence.url}
							<span className="browser-host-revision">{t("g1b.hostRevisionLabel", { revision: evidence.urlRevision })}</span>
						</dd>
					</div>
					<div className="browser-host-evidence-row">
						<dt>{t("g1b.hostSnapshotLabel")}</dt>
						<dd>{evidence.snapshotRef || t("g1b.hostNone")}</dd>
					</div>
					<div className="browser-host-evidence-row">
						<dt>{t("g1b.hostCaptureLabel")}</dt>
						<dd>{evidence.screenshotRef || t("g1b.hostNone")}</dd>
					</div>
				</dl>
			)}

			{workspaces !== undefined &&
				(workspaces.length === 0 ? (
					<p className="browser-host-empty">
						{t("g1b.hostEmptyWorkspaces")}
					</p>
				) : (
					<ul className="browser-host-spaces">
						{workspaces.map((space) => (
							<li key={space.id}>
								<span className="browser-host-space-id">{space.id}</span>
								<span className="browser-host-space-meta">
									{space.mode === "headless" ? t("g1b.hostHeadlessMode") : space.mode} · {t("g1b.hostRevisionLabel", { revision: space.revision })}
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
