// KnowledgeGraphOverlay — 작업영역을 거의 채우는 지식 그래프 오버레이(닫으면 복귀).
// lazy: 호출부가 열릴 때만 마운트 → 닫히면 unmount = 시뮬 정지(평소 부하 0).
// 노드 클릭 → 그 엔티티의 출처 문서 → "원문 열기"(URL=브라우저 / 파일=워크스페이스, 기존 패널 api 재사용).
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { classifySourceUri, type KnowledgeGraph, type KnowledgeGraphNode, entitySourcesFromKbJson } from "../lib/knowledge-result";
import { openKnowledgeSource } from "../lib/knowledge-source-open";
import { KnowledgeGraphView } from "./KnowledgeGraphView";

export function KnowledgeGraphOverlay({
	graph,
	kbJson,
	onClose,
	GraphView = KnowledgeGraphView,
}: {
	graph: KnowledgeGraph;
	/** 노드→출처 매핑용 원본 kb.json(read_naia_knowledge_kb 결과). */
	kbJson: string;
	onClose: () => void;
	/** 그래프 뷰 컴포넌트 주입(테스트 대체 가능). 기본 = KnowledgeGraphView. */
	GraphView?: (p: {
		graph: KnowledgeGraph;
		width?: number;
		height?: number;
		onNodeClick?: (n: KnowledgeGraphNode) => void;
		selectedId?: string;
	}) => ReactElement;
}) {
	const [selected, setSelected] = useState<KnowledgeGraphNode | null>(null);
	const graphAreaRef = useRef<HTMLDivElement | null>(null);
	const [dims, setDims] = useState({ w: 800, h: 520 });

	const sources = useMemo(() => entitySourcesFromKbJson(kbJson), [kbJson]);

	// Esc 로 닫기.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// 그래프 영역 크기 측정(작업영역 채우기). 헤드리스(clientWidth 0)=기본값.
	useEffect(() => {
		const el = graphAreaRef.current;
		if (!el) return;
		const measure = () => {
			const w = Math.floor(el.clientWidth);
			const h = Math.floor(el.clientHeight);
			if (w > 0 && h > 0) setDims({ w: Math.max(320, w), h: Math.max(240, h) });
		};
		measure();
		if (typeof ResizeObserver === "function") {
			const ro = new ResizeObserver(measure);
			ro.observe(el);
			return () => ro.disconnect();
		}
	}, []);

	// 출처 열기 = 공용 헬퍼(민감경로 가드 포함) 후 오버레이 닫기(원문이 보이도록).
	function openSource(uri: string) {
		openKnowledgeSource(uri);
		onClose();
	}

	const selSources = selected ? (sources[selected.id] ?? []) : [];

	return (
		<div
			className="knowledge-graph-overlay-backdrop"
			data-testid="knowledge-graph-overlay"
			onClick={onClose}
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 9000,
				background: "rgba(6,9,14,0.6)",
				backdropFilter: "blur(2px)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: 패널 본체는 backdrop 클릭 전파만 차단(Esc 로 닫기 제공) */}
			<div
				className="knowledge-graph-overlay-panel"
				onClick={(e) => e.stopPropagation()}
				style={{
					width: "92vw",
					height: "88vh",
					maxWidth: 1500,
					maxHeight: 1000,
					background: "linear-gradient(180deg, #11161f, #0b0f16)",
					border: "1px solid rgba(120,150,200,0.28)",
					borderRadius: 14,
					boxShadow: "0 24px 80px -24px rgba(0,0,0,0.8)",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
				{/* 헤더 */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "10px 14px",
						borderBottom: "1px solid rgba(120,150,200,0.18)",
					}}
				>
					<span style={{ fontWeight: 600, color: "var(--cream, #e8e0d0)", fontSize: 14 }}>
						🕸 지식 그래프
						<span style={{ fontSize: 11, color: "var(--cream-dim, #99a)", fontWeight: 400, marginLeft: 10 }}>
							노드 {graph.nodes.length} · 관계 {graph.edges.length} · 군집 {graph.communityCount}
						</span>
					</span>
					<button
						type="button"
						className="knowledge-graph-overlay-close"
						data-testid="knowledge-graph-close"
						onClick={onClose}
						style={{
							fontSize: 13,
							lineHeight: 1,
							padding: "5px 10px",
							borderRadius: 8,
							border: "1px solid rgba(120,150,200,0.3)",
							background: "transparent",
							color: "var(--cream, #e8e0d0)",
							cursor: "pointer",
						}}
					>
						✕ 닫기
					</button>
				</div>

				{/* 본체: 그래프 + 선택 출처 패널 */}
				<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
					<div
						ref={graphAreaRef}
						style={{ flex: 1, minWidth: 0, padding: 10, display: "flex" }}
					>
						<div style={{ flex: 1, minWidth: 0 }}>
							<GraphView
								graph={graph}
								width={dims.w - 36}
								height={dims.h - 60}
								onNodeClick={(n) => setSelected(n)}
								selectedId={selected?.id}
							/>
						</div>
					</div>

					{/* 선택 노드 출처 패널 */}
					{selected && (
						<div
							className="knowledge-graph-detail"
							data-testid="knowledge-graph-detail"
							style={{
								width: 300,
								flexShrink: 0,
								borderLeft: "1px solid rgba(120,150,200,0.18)",
								padding: 14,
								overflowY: "auto",
								color: "var(--cream, #e8e0d0)",
							}}
						>
							<div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
								{selected.label}
							</div>
							<div style={{ fontSize: 11, color: "var(--cream-dim, #99a)", marginBottom: 12 }}>
								{selected.type || "엔티티"} · 연결 {selected.deg}
							</div>
							<div style={{ fontSize: 12, color: "var(--cream-dim, #aab)", marginBottom: 6 }}>
								출처 문서
							</div>
							{selSources.length === 0 ? (
								<div style={{ fontSize: 12, color: "var(--cream-dim, #889)", opacity: 0.8 }}>
									이 노드에 연결된 출처 문서를 찾지 못했습니다.
								</div>
							) : (
								<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
									{selSources.map((uri) => (
										<li key={uri}>
											<button
												type="button"
												className="knowledge-graph-source"
												data-testid="knowledge-graph-source"
												onClick={() => openSource(uri)}
												title={uri}
												style={{
													width: "100%",
													textAlign: "left",
													fontSize: 12,
													padding: "6px 8px",
													borderRadius: 8,
													border: "1px solid rgba(120,150,200,0.25)",
													background: "rgba(76,139,245,0.1)",
													color: "var(--cream, #e8e0d0)",
													cursor: "pointer",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												}}
											>
												{classifySourceUri(uri) === "url" ? "🌐 " : "📄 "}
												{uri.split(/[\\/]/).pop() || uri}
											</button>
										</li>
									))}
								</ul>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
