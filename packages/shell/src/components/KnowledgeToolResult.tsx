// KnowledgeToolResult — 지식 도구(skill_knowledge_ask/search) 결과를 답변 + 출처 칩으로 렌더(K2).
// 칩 클릭 = "근거→원문": URL 이면 브라우저 패널 navigate, 워크스페이스 경로면 파일뷰어 openFile(+패널 전환).
// 파싱은 lib/knowledge-result(순수), dispatch 는 panelRegistry api(browser/workspace) 재사용.
import { panelRegistry } from "../lib/panel-registry";
import { usePanelStore } from "../stores/panel";
import { classifySourceUri, toFilePath, type ParsedKnowledge } from "../lib/knowledge-result";

/** 출처 1건 열기 — URL=브라우저(navigate+패널 전환), 파일=워크스페이스 파일뷰어(openFile). 기존 패널 api 재사용
 *  (panel-registry PanelApi=Record<string,fn>, ChatPanel.openFileInWorkspace 동형 — BrowserPanelApi.navigate/
 *  activatePanel · WorkspacePanelApi.openFile 가 그 api 의 멤버). */
export function openKnowledgeSource(uri: string): void {
	if (classifySourceUri(uri) === "url") {
		const api = panelRegistry.getApi("browser");
		api?.navigate(uri);
		api?.activatePanel?.();
		usePanelStore.getState().setActivePanel("browser");
	} else {
		panelRegistry.getApi("workspace")?.openFile(toFilePath(uri));
		usePanelStore.getState().setActivePanel("workspace");
	}
}

function SourceChip({ title, uri }: { title: string; uri: string }) {
	const kind = classifySourceUri(uri);
	return (
		<button
			type="button"
			className="knowledge-source-chip"
			data-source-kind={kind}
			data-source-uri={uri}
			title={`근거 열기: ${uri}`}
			onClick={() => openKnowledgeSource(uri)}
		>
			<span className="knowledge-source-icon">{kind === "url" ? "🌐" : "📄"}</span>
			<span className="knowledge-source-title">{title}</span>
		</button>
	);
}

/** sources/hits → 칩 목록(각 source 의 첫 sourceUri 를 클릭 대상으로; 빈 출처는 칩 없음). */
function Chips({ items }: { items: { title: string; sourceUris: string[] }[] }) {
	const chips = items
		.map((it) => ({ title: it.title, uri: it.sourceUris[0] }))
		.filter((c): c is { title: string; uri: string } => typeof c.uri === "string" && c.uri.length > 0);
	if (chips.length === 0) return null;
	return (
		<div className="knowledge-sources" data-testid="knowledge-sources">
			{chips.map((c, i) => (
				<SourceChip key={`${c.uri}-${i}`} title={c.title} uri={c.uri} />
			))}
		</div>
	);
}

interface Props {
	data: ParsedKnowledge;
}

export function KnowledgeToolResult({ data }: Props) {
	if (data.kind === "ask") {
		return (
			<div className="knowledge-tool-result" data-knowledge-kind="ask" data-abstained={data.abstained}>
				<div className="knowledge-answer">{data.answer}</div>
				{!data.abstained && <Chips items={data.sources} />}
			</div>
		);
	}
	// search
	return (
		<div className="knowledge-tool-result" data-knowledge-kind="search">
			{data.hits.length === 0 ? (
				<div className="knowledge-answer">검색 결과가 없습니다.</div>
			) : (
				<ul className="knowledge-hits">
					{data.hits.map((h, i) => (
						<li key={`${h.title}-${i}`} className="knowledge-hit">
							<div className="knowledge-hit-title">{h.title}</div>
							<div className="knowledge-hit-snippet">{h.snippet}</div>
							<Chips items={[h]} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
