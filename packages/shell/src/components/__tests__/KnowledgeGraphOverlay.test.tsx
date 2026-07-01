// @vitest-environment jsdom
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const navigate = vi.fn();
const activatePanel = vi.fn();
const openFile = vi.fn();
const setActiveApp = vi.fn();

vi.mock("../../lib/app-registry", () => ({
	appRegistry: {
		getApi: (id: string) =>
			id === "browser"
				? { navigate, activatePanel }
				: id === "workspace"
					? { openFile }
					: undefined,
	},
}));
vi.mock("../../stores/app", () => ({
	useAppStore: { getState: () => ({ setActiveApp }) },
}));

import { KnowledgeGraphOverlay } from "../KnowledgeGraphOverlay";
import type {
	KnowledgeGraph,
	KnowledgeGraphNode,
} from "../../lib/knowledge-result";

const GRAPH: KnowledgeGraph = {
	nodes: [
		{ id: "e1", label: "전입신고", type: "Topic", deg: 1, community: 0 },
		{ id: "e2", label: "신분증", type: "Concept", deg: 1, community: 0 },
	],
	edges: [{ from: "e1", to: "e2", type: "mentions", weight: 1 }],
	communityCount: 1,
};
const KB_JSON = JSON.stringify({
	version: 1,
	kb: {
		cards: [{ title: "전입신고", sourceUris: ["file:///ws/a.md"] }],
		entities: [
			{ id: "e1", name: "전입신고", type: "Topic" },
			{ id: "e2", name: "신분증", type: "Concept" },
		],
		relations: [{ from: "e1", to: "e2", type: "mentions" }],
	},
});

// 캔버스 없이 노드 선택 테스트 — GraphView 를 노드 버튼 목으로 대체(canvas 히트테스트는 Playwright 가 검증).
function MockGraphView({
	graph,
	onNodeClick,
}: {
	graph: KnowledgeGraph;
	onNodeClick?: (n: KnowledgeGraphNode) => void;
}) {
	return (
		<div data-testid="knowledge-graph">
			{graph.nodes.map((n) => (
				<button
					type="button"
					key={n.id}
					data-testid={`node-${n.id}`}
					onClick={() => onNodeClick?.(n)}
				>
					{n.label}
				</button>
			))}
		</div>
	);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("KnowledgeGraphOverlay (작업영역 오버레이 + 노드→출처→원문)", () => {
	it("열림 + 닫기 버튼 → onClose", () => {
		const onClose = vi.fn();
		render(
			<KnowledgeGraphOverlay
				graph={GRAPH}
				kbJson={KB_JSON}
				onClose={onClose}
				GraphView={MockGraphView}
			/>,
		);
		expect(screen.getByTestId("knowledge-graph-overlay")).toBeTruthy();
		fireEvent.click(screen.getByTestId("knowledge-graph-close"));
		expect(onClose).toHaveBeenCalled();
	});

	it("노드 클릭 → 출처 패널 + 파일 출처 클릭 → workspace openFile + 오버레이 닫힘", () => {
		const onClose = vi.fn();
		render(
			<KnowledgeGraphOverlay
				graph={GRAPH}
				kbJson={KB_JSON}
				onClose={onClose}
				GraphView={MockGraphView}
			/>,
		);
		expect(screen.queryByTestId("knowledge-graph-detail")).toBeNull();
		fireEvent.click(screen.getByTestId("node-e2")); // Concept — mentions 로 출처 전파됨
		expect(screen.getByTestId("knowledge-graph-detail")).toBeTruthy();
		fireEvent.click(screen.getByTestId("knowledge-graph-source"));
		expect(openFile).toHaveBeenCalledWith("/ws/a.md");
		expect(setActiveApp).toHaveBeenCalledWith("workspace");
		expect(onClose).toHaveBeenCalled(); // 원문 보이게 닫힘
	});

	it("출처 없는 노드 → '출처 못 찾음' 안내", () => {
		const graphNoSrc: KnowledgeGraph = {
			nodes: [{ id: "x", label: "고아", type: "Concept", deg: 0, community: 0 }],
			edges: [],
			communityCount: 1,
		};
		render(
			<KnowledgeGraphOverlay
				graph={graphNoSrc}
				kbJson={JSON.stringify({
					version: 1,
					kb: { cards: [], entities: [{ id: "x", name: "고아" }], relations: [] },
				})}
				onClose={vi.fn()}
				GraphView={MockGraphView}
			/>,
		);
		fireEvent.click(screen.getByTestId("node-x"));
		expect(screen.getByTestId("knowledge-graph-detail").textContent).toContain(
			"찾지 못했",
		);
	});
});
