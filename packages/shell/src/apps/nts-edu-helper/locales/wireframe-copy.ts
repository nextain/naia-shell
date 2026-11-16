import { Logger } from "../../../lib/logger";
import {
	type AxWorkbookFields,
	type ChecklistCategoryId,
	type ChecklistStatus,
	axText,
	resolveAxLocale,
} from "./messages";

Logger.debug("AxWireframeCopy", "loading localized AX workbook synthesizers");

export function escapeAxHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function parseLocalizedStage1Reply(
	current: AxWorkbookFields,
	replyText: string,
): AxWorkbookFields {
	const lines = replyText.split("\n").map((l) => l.trim());
	let bottleneckRisk = current.bottleneckRisk;
	let noPiiPrinciple = current.noPiiPrinciple;
	let approvalStopRule = current.approvalStopRule;

	for (const line of lines) {
		const m1 = /^(?:병목위험|BOTTLENECK)\s*[:：]\s*(.+)$/i.exec(line);
		if (m1?.[1]) bottleneckRisk = m1[1].trim();
		const m2 = /^(?:개인정보원칙|NO_PII)\s*[:：]\s*(.+)$/i.exec(line);
		if (m2?.[1]) noPiiPrinciple = m2[1].trim();
		const m3 = /^(?:한줄승인규칙|APPROVAL_RULE)\s*[:：]\s*(.+)$/i.exec(line);
		if (m3?.[1]) approvalStopRule = m3[1].trim();
	}

	return {
		...current,
		bottleneckRisk,
		noPiiPrinciple,
		approvalStopRule,
	};
}

export function buildOfflineStage1Draft(
	current: AxWorkbookFields,
	localeOverride?: string,
): AxWorkbookFields {
	const lang = resolveAxLocale(localeOverride);
	if (lang === "en") {
		return {
			...current,
			bottleneckRisk: `In ${current.agencyName}, manual clause-by-clause updates for "${current.serviceName}" take excessive staff hours and risk mixing statutory effective dates with operational deadlines.`,
			noPiiPrinciple: `Inputs are strictly restricted to ${current.sourceDocs}; citizen or employee personal data is excluded prior to processing.`,
			approvalStopRule: `AI writes a cited draft for "${current.serviceName}" and halts; ${current.targetUser} cross-checks key claims against original text before clicking Approve.`,
		};
	}
	return {
		...current,
		bottleneckRisk: `${current.agencyName}에서 「${current.serviceName}」 대상 문서를 수작업으로 대조·갱신할 때 시간이 오래 걸리고 시행일·적용 기준을 섞어 적는 실수 위험이 있다.`,
		noPiiPrinciple: `입력 자료는 공개 근거(${current.sourceDocs})와 비식별 표준 양식으로 한정하며, 민원인·납세자·직원 개인정보는 원천 배제한다.`,
		approvalStopRule: `AI는 조항 출처와 [[확인 필요]]가 분리된 갱신 초안을 저장한 뒤 멈추고, ${current.targetUser}이(가) 대표 주장을 원문과 직접 대조해 승인한 버전만 반영한다.`,
	};
}

export function parseLocalizedStage2Reply(
	current: AxWorkbookFields,
	replyText: string,
): AxWorkbookFields {
	const lines = replyText.split("\n").map((l) => l.trim());
	let purpose = current.purpose;
	let aiRole = current.aiRole;
	let humanRole = current.humanRole;
	let approvalGate = current.approvalGate;
	let screenAreas = current.screenAreas;

	for (const line of lines) {
		const m1 = /^(?:업무목적|PURPOSE)\s*[:：]\s*(.+)$/i.exec(line);
		if (m1?.[1]) purpose = m1[1].trim();
		const m2 = /^(?:AI역할|AI_ROLE)\s*[:：]\s*(.+)$/i.exec(line);
		if (m2?.[1]) aiRole = m2[1].trim();
		const m3 = /^(?:사람역할|HUMAN_ROLE)\s*[:：]\s*(.+)$/i.exec(line);
		if (m3?.[1]) humanRole = m3[1].trim();
		const m4 = /^(?:승인지점|APPROVAL_GATE)\s*[:：]\s*(.+)$/i.exec(line);
		if (m4?.[1]) approvalGate = m4[1].trim();
		const m5 = /^(?:화면구성|SCREEN_AREAS)\s*[:：]\s*(.+)$/i.exec(line);
		if (m5?.[1]) screenAreas = m5[1].trim();
	}

	return {
		...current,
		purpose,
		aiRole,
		humanRole,
		approvalGate,
		screenAreas,
	};
}

export function buildOfflineStage2Draft(
	current: AxWorkbookFields,
	localeOverride?: string,
): AxWorkbookFields {
	const lang = resolveAxLocale(localeOverride);
	if (lang === "en") {
		return {
			...current,
			purpose: `Streamline "${current.serviceName}" at ${current.agencyName} using ${current.sourceDocs} so ${current.targetUser} verifies cited diffs instead of manual hunting.`,
			aiRole: `Compare ${current.sourceDocs} against current materials, generate Before -> After diffs with exact clause citations, isolate uncertain operational rules in [[Needs Confirmation]], and stop without self-completing.`,
			humanRole: `${current.targetUser} cross-checks representative claims and numbers against original text and clicks ⑤ Approve or ⑥ Reject with revision notes.`,
			approvalGate: `1st Gate: ${current.targetUser} approves Draft vN -> 2nd Gate: Division head signs off before release [[Needs Confirmation — agency sign-off policy]].`,
		};
	}
	return {
		...current,
		purpose: `${current.agencyName}의 공개 근거(${current.sourceDocs})에서 바뀐 조항을 찾아 출처 달린 「${current.serviceName}」 초안을 만들고, 사람이 대조·승인한 버전만 안전하게 반영한다.`,
		aiRole: `입력 근거(${current.sourceDocs})와 현행 문서를 비교해 '변경 전 → 변경 후' 및 조항 출처를 작성하고, 원문으로 확인되지 않는 실무 해석은 [[확인 필요]]로 분리한 뒤 스스로 완료를 선언하지 않고 멈춘다.`,
		humanRole: `${current.targetUser}이(가) 핵심 수치·적용 시점 대표 주장을 원문과 대조하고, 화면에서 ⑤ 승인 또는 사유를 적은 ⑥ 반려를 결정한다.`,
		approvalGate: `1차 초안 승인: ${current.targetUser}(갱신 초안 vN) → 2차 배포 승인: 부서장 최종 결재 [[확인 필요 — 기관 위임전결 규정]].`,
	};
}

export function renderLocalizedWorkbookMarkdown(
	fields: AxWorkbookFields,
	localeOverride?: string,
): string {
	const lang = resolveAxLocale(localeOverride);
	const catLabel = (id: ChecklistCategoryId) =>
		axText(`ax.cat.${id}`, undefined, lang);
	const statusLabel = (st: ChecklistStatus) =>
		axText(`ax.status.${st}`, undefined, lang);

	const fallbackUnverified =
		lang === "ko" ? "[[확인 필요]]" : "[[Needs Confirmation]]";

	const checklistRows = fields.checklist
		.map(
			(item) =>
				`| ${catLabel(item.id)} | ${statusLabel(item.status)} | ${item.note || fallbackUnverified} |`,
		)
		.join("\n");

	if (lang === "en") {
		return [
			`# ${fields.serviceName} — Public-Sector AX 2-Page Service Plan`,
			"",
			`- **Agency / Division**: ${fields.agencyName}`,
			`- **Target User**: ${fields.targetUser}`,
			`- **Public Evidence Sources**: ${fields.sourceDocs}`,
			"",
			"## Page 1 · Product Plan & Problem Statement",
			"",
			"### 1. Workflow Objective & Bottleneck",
			`- **Current Bottleneck**: ${fields.bottleneckRisk}`,
			`- **Objective**: ${fields.purpose}`,
			"",
			"### 2. Personal Data Exclusion & Stop Rule",
			`- **No-PII Rule**: ${fields.noPiiPrinciple}`,
			`- **One-Line Approval Stop Rule**: ${fields.approvalStopRule}`,
			"",
			"### 3. AI Duties vs. Human Duties",
			`- **What AI Does**: ${fields.aiRole}`,
			`- **What Human Does**: ${fields.humanRole}`,
			"",
			"### 4. Human Approval Checkpoints",
			`${fields.approvalGate}`,
			"",
			"## Page 2 · Screen Plan (Zones ①–⑦) & Public AI Checklist",
			"",
			"### Screen Layout ①–⑦",
			`${fields.screenAreas}`,
			"",
			"### 6-Category Public AI Review Checklist",
			"| Category | Status | Evidence / Action Note |",
			"|---|---|---|",
			checklistRows,
			"",
		].join("\n");
	}

	return [
		`# ${fields.serviceName} — 공공 AX 서비스 기획서 (상위기획 · 화면기획 통합본)`,
		"",
		`- **기관 / 부서명**: ${fields.agencyName}`,
		`- **대상 사용자**: ${fields.targetUser}`,
		`- **입력 공개 근거자료**: ${fields.sourceDocs}`,
		"",
		"## 1장 · 상위기획 및 문제정의서",
		"",
		"### 1. 업무 목적 및 현행 병목",
		`- **현행 병목과 실수 위험**: ${fields.bottleneckRisk}`,
		`- **업무 목적**: ${fields.purpose}`,
		"",
		"### 2. 개인정보 배제 원칙 및 한 줄 승인 규칙",
		`- **개인정보 배제 원칙**: ${fields.noPiiPrinciple}`,
		`- **핵심 한 줄 승인 규칙**: ${fields.approvalStopRule}`,
		"",
		"### 3. AI가 하는 일과 사람이 하는 일",
		`- **AI가 하는 일**: ${fields.aiRole}`,
		`- **사람이 하는 일**: ${fields.humanRole}`,
		"",
		"### 4. 사람 승인 지점",
		`${fields.approvalGate}`,
		"",
		"## 2장 · 화면기획(①~⑦) 및 공공 AI 6대 체크리스트",
		"",
		"### 화면 영역 ①~⑦ 구성",
		`${fields.screenAreas}`,
		"",
		"### 공공 AI 6대 체크리스트 검토 표",
		"| 점검 영역 | 판정 | 기획서 근거 및 조치 메모 |",
		"|---|---|---|",
		checklistRows,
		"",
	].join("\n");
}

export function renderLocalizedWireframeHtml(
	fields: AxWorkbookFields,
	localeOverride?: string,
): string {
	const lang = resolveAxLocale(localeOverride);
	const agency = escapeAxHtml(fields.agencyName);
	const service = escapeAxHtml(fields.serviceName);
	const user = escapeAxHtml(fields.targetUser);
	const sources = escapeAxHtml(fields.sourceDocs);
	const noPii = escapeAxHtml(fields.noPiiPrinciple);
	const stopRule = escapeAxHtml(fields.approvalStopRule);
	const aiRole = escapeAxHtml(fields.aiRole);
	const humanRole = escapeAxHtml(fields.humanRole);
	const gate = escapeAxHtml(fields.approvalGate);
	const isKo = lang === "ko";

	return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${service} — 04-화면.html</title>
<style>
  :root {
    --ink: #0f172a; --sub: #475569; --line: #cbd5e1; --bg: #f8fafc;
    --pri: #4338ca; --soft: #eef2ff; --ok: #047857; --okbg: #ecfdf5;
    --warn: #b45309; --warnbg: #fffbeb;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 14.5px/1.55 "Pretendard", "Noto Sans KR", system-ui, sans-serif; color: var(--ink); background: var(--bg); }
  .wireframe { max-width: 960px; margin: 0 auto; background: #fff; border: 2px solid var(--ink); border-radius: 14px; overflow: hidden; }
  header { padding: 14px 18px; background: var(--soft); border-bottom: 2px solid var(--ink); display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
  header h1 { margin: 0; font-size: 19px; }
  .badge { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; background: #fff; border: 1px solid var(--pri); color: var(--pri); }
  .num { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--pri); color: #fff; font-size: 12px; font-weight: 800; margin-right: 6px; }
  .cols { display: grid; grid-template-columns: 1fr 1.85fr; }
  .cols > section:first-child { border-right: 2px solid var(--ink); }
  section, footer { padding: 14px 16px; }
  footer { border-top: 2px solid var(--ink); background: #f8fafc; }
  h2 { margin: 0 0 10px; font-size: 15.5px; display: flex; align-items: center; }
  .box { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; background: #fff; }
  .box.warn { background: var(--warnbg); border-color: #fcd34d; color: #92400e; }
  .box.adv { background: #f1f5f9; border-color: #94a3b8; }
  .cite { display: inline-block; margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--pri); background: var(--soft); padding: 2px 8px; border-radius: 999px; }
  .btn { border: 0; border-radius: 9px; padding: 8px 14px; font: inherit; font-weight: 700; cursor: pointer; margin-right: 6px; margin-top: 6px; }
  .btn.pri { background: var(--pri); color: #fff; }
  .btn.ok { background: var(--ok); color: #fff; }
  .btn.reject { background: #fff; color: var(--warn); border: 1.5px solid #f59e0b; }
  input.reason { width: 100%; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font: inherit; margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid var(--line); padding: 7px 8px; text-align: left; }
  th { background: #e2e8f0; }
  .pill-ok { color: var(--ok); background: var(--okbg); padding: 2px 8px; border-radius: 999px; font-weight: 700; }
  .pill-re { color: var(--warn); background: var(--warnbg); padding: 2px 8px; border-radius: 999px; font-weight: 700; }
  @media (max-width: 680px) { .cols { grid-template-columns: 1fr; } .cols > section:first-child { border-right: 0; border-bottom: 2px solid var(--ink); } }
</style>
</head>
<body>
<div class="wireframe">
  <header>
    <h1><span class="num">①</span>${service} <small style="font-weight:500;color:#475569">(${agency})</small></h1>
    <span class="badge">${isKo ? "검토자" : "Reviewer"}: ${user}</span>
  </header>
  <div class="cols">
    <section>
      <h2><span class="num">②</span>${isKo ? "공개 근거자료 선택" : "Select Public Sources"}</h2>
      <div class="box">
        <strong>${isKo ? "입력 공개 자료" : "Input Sources"}</strong>
        <p style="margin:4px 0 0;font-size:13px;color:#334155">${sources}</p>
      </div>
      <div class="box warn" style="font-size:12.5px">
        <strong>${isKo ? "개인정보 배제 원칙" : "No-PII Rule"}:</strong> ${noPii}
      </div>
      <button type="button" class="btn pri" id="btn-draft"><span class="num" style="background:#fff;color:#4338ca">③</span>${isKo ? "초안 만들기 (새 버전)" : "Generate Cited Draft"}</button>
    </section>
    <section>
      <h2><span class="num">④</span>${isKo ? "출처 포함 갱신 초안 & 반대 검토" : "Cited AI Draft & Adversarial Review"} (<span id="ver-label">v1</span>)</h2>
      <div class="box">
        <div style="color:#64748b;text-decoration:line-through;font-size:13px">${isKo ? "변경 전: 종전 기준 문장 (개정 조항 미반영)" : "Before: Legacy guidance text prior to amendment"}</div>
        <div style="margin-top:4px;font-weight:600">${isKo ? "변경 후(AI 초안)" : "After (AI Draft)"}: ${aiRole}</div>
        <span class="cite">${isKo ? "출처" : "Citation"}: ${sources}</span>
      </div>
      <div class="box warn">
        <strong>[[확인 필요]]</strong> ${isKo ? "원문으로 직접 확인되지 않는 부서 내부 결재·시행 세부 해석은 승인 대상에서 분리합니다." : "Unverified internal interpretations are isolated from approval."} (${gate})
      </div>
      <div class="box adv">
        <strong>${isKo ? "다른 AI의 반대 검토" : "Adversarial AI Check"}:</strong> ${humanRole}
      </div>
      <div style="margin-top:8px">
        <div style="font-size:12.5px;color:#475569;margin-bottom:4px"><strong>${isKo ? "한 줄 승인 규칙" : "Stop Rule"}:</strong> ${stopRule}</div>
        <input class="reason" id="reason-input" type="text" placeholder="${isKo ? "반려 또는 승인 메모 입력 (선택)..." : "Optional approval / rejection reason..."}" />
        <div>
          <button type="button" class="btn ok" id="btn-approve">⑤ ${isKo ? "승인 (사람 확정)" : "Approve (Human Only)"}</button>
          <button type="button" class="btn reject" id="btn-reject">⑥ ${isKo ? "반려 · 수정 요청" : "Reject & Request Revision"}</button>
        </div>
      </div>
    </section>
  </div>
  <footer>
    <h2><span class="num">⑦</span>${isKo ? "승인 · 반려 처리 감사 기록" : "Human Approval & Rejection Audit Log"}</h2>
    <table>
      <thead>
        <tr>
          <th>${isKo ? "대상 버전" : "Target Version"}</th>
          <th>${isKo ? "승인자" : "Reviewer"}</th>
          <th>${isKo ? "결정" : "Decision"}</th>
          <th>${isKo ? "시각" : "Time"}</th>
          <th>${isKo ? "다음 행동 / 사유" : "Next Step / Note"}</th>
        </tr>
      </thead>
      <tbody id="audit-body">
        <tr id="empty-row"><td colspan="5" style="color:#64748b">${isKo ? "아직 승인 기록이 없습니다. 사람이 ⑤ 승인 또는 ⑥ 반려를 누르면 기록됩니다." : "No approval records yet. Press ⑤ Approve or ⑥ Reject above."}</td></tr>
      </tbody>
    </table>
  </footer>
</div>
<script>
  (function () {
    var version = 1;
    var verEl = document.getElementById("ver-label");
    var bodyEl = document.getElementById("audit-body");
    var reasonEl = document.getElementById("reason-input");
    function stamp() {
      var d = new Date();
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    }
    function record(approved) {
      var empty = document.getElementById("empty-row");
      if (empty) empty.remove();
      var tr = document.createElement("tr");
      var note = reasonEl.value.trim();
      var tdVer = document.createElement("td");
      tdVer.textContent = "Draft v" + version;
      var tdUser = document.createElement("td");
      tdUser.textContent = ${JSON.stringify(fields.targetUser)};
      var tdDec = document.createElement("td");
      var pill = document.createElement("span");
      pill.className = approved ? "pill-ok" : "pill-re";
      pill.textContent = approved ? ${JSON.stringify(isKo ? "승인됨" : "Approved")} : ${JSON.stringify(isKo ? "반려" : "Rejected")};
      tdDec.appendChild(pill);
      var tdTime = document.createElement("td");
      tdTime.textContent = stamp();
      var tdNext = document.createElement("td");
      tdNext.textContent = approved
        ? (note || ${JSON.stringify(isKo ? "새 파일로 배포 준비 (원본 보존)" : "Ready for release as new file")})
        : ((note ? note + " -> " : "") + "v" + (version + 1) + ${JSON.stringify(isKo ? " 재작성 및 재검토" : " revision required")});
      tr.appendChild(tdVer);
      tr.appendChild(tdUser);
      tr.appendChild(tdDec);
      tr.appendChild(tdTime);
      tr.appendChild(tdNext);
      bodyEl.insertBefore(tr, bodyEl.firstChild);
      reasonEl.value = "";
      if (!approved) {
        version += 1;
        verEl.textContent = "v" + version;
      }
    }
    document.getElementById("btn-draft").onclick = function () {
      version += 1;
      verEl.textContent = "v" + version;
    };
    document.getElementById("btn-approve").onclick = function () { record(true); };
    document.getElementById("btn-reject").onclick = function () { record(false); };
  })();
</script>
</body>
</html>
`;
}

export function renderLocalizedStarterProjectFiles(
	fields: AxWorkbookFields,
	wireframeHtml: string,
	localeOverride?: string,
): Array<{ path: string; content: string }> {
	const lang = resolveAxLocale(localeOverride);
	const compiledPlanMd = renderLocalizedWorkbookMarkdown(fields, lang);
	const projectYaml = [
		"version: 1",
		"project:",
		"  id: nts-ax-planning-studio",
		lang === "ko"
			? "  name: 공공 AX기획 실습 패키지"
			: "  name: Public-Sector AX Planning Studio",
		"  coding_app: opencode",
		"  docs_dirs:",
		"    - docs",
		"",
	].join("\n");

	const agentsMd = [
		"# AGENTS.md — Public-Sector AX Planning Assistant Rules",
		"",
		"- Cite exact public source filenames and article numbers on every claim.",
		"- Isolate any unverified operational or sign-off detail inside `[[Needs Confirmation]]` / `[[확인 필요]]`.",
		"- Never declare completion or overwrite original documents; pause at the human approval checkpoint.",
		"- Never include personal identifiable information (PII).",
		"",
	].join("\n");

	return [
		{ path: "AGENTS.md", content: agentsMd },
		{ path: "project.yaml", content: projectYaml },
		{ path: "docs/01-ax-service-plan.md", content: compiledPlanMd },
		{ path: "04-wireframe.html", content: wireframeHtml },
	];
}

export function getLocalizedWireframeDownloadName(
	localeOverride?: string,
): string {
	return resolveAxLocale(localeOverride) === "ko"
		? "04-화면.html"
		: "04-screen.html";
}
