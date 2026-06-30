// KnowledgeGraphView — 지식 그래프 2D/3D 캔버스 force 뷰어(K3, 의존성 0 — 캔버스만).
// nodes/edges+deg+군집을 군집색·degree 크기로 렌더. 2D↔3D 토글(3D=원근+자동회전).
// 경량(글로우 제거 — shadowBlur 가 perf 주범). 노드 클릭 → onNodeClick(근거→원문 탐색용).
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
	communityColor,
	type KnowledgeGraph,
	type KnowledgeGraphNode,
} from "../lib/knowledge-result";

interface Sim {
	id: string;
	label: string;
	deg: number;
	community: number;
	x: number; y: number; z: number;
	vx: number; vy: number; vz: number;
	fx: number; fy: number; fz: number;
}

export function KnowledgeGraphView({
	graph,
	width = 380,
	height = 300,
	onNodeClick,
	selectedId,
}: {
	graph: KnowledgeGraph;
	width?: number;
	height?: number;
	onNodeClick?: (node: KnowledgeGraphNode) => void;
	selectedId?: string;
}) {
	const [mode, setMode] = useState<"2d" | "3d">("2d");
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	// 클릭 히트테스트용 — 애니메이션 루프 밖에서 최신 위치/투영 참조(effect 재실행 없이).
	const simsRef = useRef<Sim[] | null>(null);
	const projRef = useRef<((s: Sim) => { px: number; py: number; scale: number }) | null>(null);
	const redrawRef = useRef<(() => void) | null>(null); // 2D 정착(raf 정지) 후 선택 변경 시 1프레임 재draw용
	const selectedIdRef = useRef<string | undefined>(selectedId);
	selectedIdRef.current = selectedId;
	const onNodeClickRef = useRef(onNodeClick);
	onNodeClickRef.current = onNodeClick;
	const W = width;
	const H = height;

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		if (typeof requestAnimationFrame !== "function") return; // 헤드리스 가드

		const N = graph.nodes.length;
		const sims: Sim[] = graph.nodes.map((n, i) => {
			const a = (i / Math.max(1, N)) * Math.PI * 2; // 결정론 초기 배치(원형/구면)
			return {
				id: n.id, label: n.label, deg: n.deg, community: n.community,
				x: Math.cos(a) * 80, y: Math.sin(a) * 80, z: mode === "3d" ? Math.sin(a * 1.7) * 80 : 0,
				vx: 0, vy: 0, vz: 0, fx: 0, fy: 0, fz: 0,
			};
		});
		simsRef.current = sims;
		const idx = new Map(sims.map((s, i) => [s.id, i]));
		const edges = graph.edges.filter((e) => idx.has(e.from) && idx.has(e.to));
		let yaw = 0;
		let frame = 0;
		const maxFrames = 600;
		let raf = 0;

		const step = () => {
			for (let i = 0; i < N; i++) {
				const a = sims[i];
				a.fx = -a.x * 0.01; a.fy = -a.y * 0.01; a.fz = -a.z * 0.01; // 중심 인력
				for (let j = 0; j < N; j++) {
					if (i === j) continue;
					const b = sims[j];
					const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
					const d2 = dx * dx + dy * dy + dz * dz + 0.01;
					const d = Math.sqrt(d2);
					const rep = 1400 / d2; // 반발
					a.fx += (dx / d) * rep; a.fy += (dy / d) * rep; a.fz += (dz / d) * rep;
				}
			}
			for (const e of edges) {
				const a = sims[idx.get(e.from) as number];
				const b = sims[idx.get(e.to) as number];
				const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
				const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
				const spring = (d - 60) * 0.02 * (e.weight || 1); // 스프링(연결=당김)
				const ux = dx / d, uy = dy / d, uz = dz / d;
				a.fx += ux * spring; a.fy += uy * spring; a.fz += uz * spring;
				b.fx -= ux * spring; b.fy -= uy * spring; b.fz -= uz * spring;
			}
			for (const a of sims) {
				a.vx = (a.vx + a.fx) * 0.82; a.vy = (a.vy + a.fy) * 0.82; a.vz = (a.vz + a.fz) * 0.82;
				a.x += a.vx; a.y += a.vy; if (mode === "3d") a.z += a.vz;
			}
		};

		const proj = (s: Sim): { px: number; py: number; scale: number } => {
			const cx = W / 2, cy = H / 2;
			if (mode === "2d") return { px: cx + s.x, py: cy + s.y, scale: 1 };
			const rx = s.x * Math.cos(yaw) - s.z * Math.sin(yaw);
			const rz = s.x * Math.sin(yaw) + s.z * Math.cos(yaw);
			const persp = 320 / (320 + rz);
			return { px: cx + rx * persp, py: cy + s.y * persp, scale: persp };
		};
		projRef.current = proj;

		const draw = () => {
			const bg = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.7);
			bg.addColorStop(0, "#141b27");
			bg.addColorStop(1, "#0a0e16");
			ctx.fillStyle = bg;
			ctx.fillRect(0, 0, W, H);
			if (mode === "3d") yaw += 0.004;
			ctx.strokeStyle = "rgba(120,150,200,0.25)";
			ctx.lineWidth = 1;
			for (const e of edges) {
				const a = proj(sims[idx.get(e.from) as number]);
				const b = proj(sims[idx.get(e.to) as number]);
				ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
			}
			const sel = selectedIdRef.current;
			const labelThreshold = N <= 40 ? 0 : 2; // 큰 그래프는 degree≥2 만 라벨(겹침 방지)
			for (const s of sims) {
				const p = proj(s);
				const r = (4 + Math.min(8, s.deg * 1.5)) * p.scale;
				ctx.fillStyle = communityColor(s.community);
				ctx.beginPath(); ctx.arc(p.px, p.py, Math.max(1.5, r), 0, Math.PI * 2); ctx.fill();
				if (sel === s.id) {
					// 선택 노드 강조 링(흰색)
					ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
					ctx.beginPath(); ctx.arc(p.px, p.py, Math.max(1.5, r) + 3, 0, Math.PI * 2); ctx.stroke();
					ctx.lineWidth = 1;
				}
				if (s.deg >= labelThreshold || sel === s.id) {
					ctx.fillStyle = sel === s.id ? "#fff" : "rgba(225,230,240,0.9)";
					ctx.font = sel === s.id ? "bold 11px sans-serif" : "10px sans-serif";
					ctx.fillText(s.label.slice(0, 16), p.px + r + 3, p.py + 3);
				}
			}
		};

		redrawRef.current = draw; // 정착 후 선택 변경 시 외부에서 1프레임 재draw
		const tick = () => {
			if (frame < maxFrames) step();
			draw();
			frame++;
			// 2D 는 정착 후 정지(CPU 0). 3D 회전은 지속하되 정착 후엔 step 생략(draw 만 = 가벼움).
			if (mode === "2d" && frame >= maxFrames) return;
			raf = requestAnimationFrame(tick);
		};
		tick();
		return () => { if (raf) cancelAnimationFrame(raf); };
	}, [graph, mode, W, H]);

	// 2D 는 정착 후 RAF 정지 → selectedIdRef 만으론 재draw 트리거 없음. 선택/모드 변경 시 1프레임 재draw(선택 링 반영).
	useEffect(() => {
		if (mode === "2d") redrawRef.current?.();
	}, [selectedId, mode]);

	const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
		const onClick = onNodeClickRef.current;
		const sims = simsRef.current;
		const project = projRef.current;
		const canvas = canvasRef.current;
		if (!onClick || !sims || !project || !canvas) return;
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		const sx = (e.clientX - rect.left) * (W / rect.width); // CSS 스케일 → 버퍼 좌표
		const sy = (e.clientY - rect.top) * (H / rect.height);
		let best: Sim | null = null;
		let bestD = 22 * 22; // 히트 반경(버퍼 좌표)
		for (const s of sims) {
			const p = project(s);
			const dx = p.px - sx, dy = p.py - sy;
			const d2 = dx * dx + dy * dy;
			if (d2 < bestD) { bestD = d2; best = s; }
		}
		if (best) {
			const node = graph.nodes.find((n) => n.id === (best as Sim).id);
			if (node) onClick(node);
		}
	};

	return (
		<div
			className="knowledge-graph-view"
			data-testid="knowledge-graph"
			data-mode={mode}
			style={{
				borderRadius: 12,
				padding: 8,
				background:
					"radial-gradient(120% 120% at 50% 0%, rgba(76,139,245,0.10), rgba(10,14,22,0.6))",
				border: "1px solid rgba(120,150,200,0.22)",
			}}
		>
			<div
				className="knowledge-graph-toolbar"
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					marginBottom: 6,
					gap: 8,
				}}
			>
				<span
					className="knowledge-graph-meta"
					style={{ fontSize: 11, color: "var(--cream-dim, #aab)", letterSpacing: "0.02em" }}
				>
					● 노드 {graph.nodes.length} · 관계 {graph.edges.length} · 군집{" "}
					{graph.communityCount}
					{onNodeClick ? " · 노드를 클릭해 출처 보기" : ""}
				</span>
				<button
					type="button"
					className="knowledge-graph-mode"
					onClick={() => setMode((m) => (m === "2d" ? "3d" : "2d"))}
					style={{
						fontSize: 11,
						padding: "3px 10px",
						borderRadius: 999,
						border: "1px solid rgba(120,150,200,0.35)",
						background: "rgba(76,139,245,0.12)",
						color: "var(--cream, #e8e0d0)",
						cursor: "pointer",
					}}
				>
					{mode === "2d" ? "🌐 3D 보기" : "▦ 2D 보기"}
				</button>
			</div>
			<canvas
				ref={canvasRef}
				width={W}
				height={H}
				className="knowledge-graph-canvas"
				onClick={handleCanvasClick}
				style={{
					width: "100%",
					height: "auto",
					borderRadius: 8,
					display: "block",
					background: "#0a0e16",
					cursor: onNodeClick ? "pointer" : "default",
				}}
			/>
		</div>
	);
}
