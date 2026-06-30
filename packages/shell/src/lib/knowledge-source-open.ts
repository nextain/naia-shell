// knowledge-source-open — 지식 출처 1건 열기(근거→원문). URL=브라우저 navigate / 파일=워크스페이스 openFile.
// KnowledgeToolResult(칩)·KnowledgeGraphOverlay(노드 출처) 공용(중복 제거). 파일 분기에 **민감경로 가드**
// (탬퍼된/오염 kb.json 의 sourceUris 로 키·인증서·시크릿을 열어버리는 것 차단 — 방어, 일반 .md/.txt 는 통과).
import { usePanelStore } from "../stores/panel";
import { classifySourceUri, toFilePath } from "./knowledge-result";
import { panelRegistry } from "./panel-registry";

// 민감/위험 파일(키·인증서·env·ssh) — 출처 클릭으로 열지 않는다. 에이전트 fs-sandbox denylist 와 같은 취지(셸측).
const SENSITIVE_SOURCE: readonly RegExp[] = [
	/(^|\/)\.env(\.[^/]*)?$/i, // 디렉토리경계 .env 파일만(`my.env.notes.md` 같은 정상 문서 오탐 방지)
	/(^|\/)\.keys?(\/|$)/i,
	/\.dpapi$/i,
	/(^|\/)\.ssh(\/|$)/i,
	/\.(pem|p12|pfx|key|age|gpg|asc|keystore|jks)$/i,
	/(^|\/)\.gnupg(\/|$)/i,
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i,
];

/** 파일 출처 경로가 열어도 안전한가 — 널바이트·UNC·민감 키/인증서 거부(방어). 일반 문서는 통과. */
export function isSafeSourcePath(path: string): boolean {
	if (!path || path.includes("\0")) return false;
	const norm = path.replace(/\\/g, "/");
	if (/^\/\//.test(norm)) return false; // UNC(\\server / //server)
	return !SENSITIVE_SOURCE.some((re) => re.test(norm));
}

/** 출처 1건 열기 — URL=브라우저(navigate+패널 전환), 파일=워크스페이스 파일뷰어(openFile, 민감경로 거부).
 *  URL 은 classifySourceUri 가 http(s) 만 url 로 보므로 javascript:/data: 는 url 로 안 감(파일 분기→가드). */
export function openKnowledgeSource(uri: string): void {
	if (classifySourceUri(uri) === "url") {
		const api = panelRegistry.getApi("browser");
		api?.navigate(uri);
		api?.activatePanel?.();
		usePanelStore.getState().setActivePanel("browser");
		return;
	}
	const path = toFilePath(uri);
	if (!isSafeSourcePath(path)) return; // 민감/위험 = 무시(silent, 클릭으로 시크릿 노출 차단)
	panelRegistry.getApi("workspace")?.openFile(path);
	usePanelStore.getState().setActivePanel("workspace");
}
