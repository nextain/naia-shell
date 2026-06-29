// KnowledgeGraphView — 지식 그래프 2D/3D 캔버스 force 뷰어(K3). 의존성 0(캔버스만, 엔진 examples/cms 포팅).
// skill_knowledge_graph tool-result(nodes/edges+deg+군집)를 군집색·degree 크기로 렌더. 2D↔3D 토글(3D=원근+자동회전).
import { useEffect, useRef, useState } from "react";
import { communityColor, type KnowledgeGraph } from "../lib/knowledge-result";

interface Sim {
	id: string;
	label: string;
	deg: number;
	community: number;
	x: number; y: number; z: number;
	vx: number; vy: number; vz: number;
	fx: number; fy: number; fz: number;
}

const W = 380;
const H = 300;

export function KnowledgeGraphView({ graph }: { graph: KnowledgeGraph }) {
	const [mode, setMode] = useState<"2d" | "3d">("2d");
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

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

		const draw = () => {
			ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, W, H);
			if (mode === "3d") yaw += 0.004;
			ctx.strokeStyle = "rgba(120,130,150,0.35)"; ctx.lineWidth = 1;
			for (const e of edges) {
				const a = proj(sims[idx.get(e.from) as number]);
				const b = proj(sims[idx.get(e.to) as number]);
				ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
			}
			for (const s of sims) {
				const p = proj(s);
				const r = (4 + Math.min(8, s.deg * 1.5)) * p.scale;
				ctx.fillStyle = communityColor(s.community);
				ctx.beginPath(); ctx.arc(p.px, p.py, Math.max(1.5, r), 0, Math.PI * 2); ctx.fill();
				if (N <= 24 || s.deg >= 2) {
					ctx.fillStyle = "rgba(220,225,235,0.85)"; ctx.font = "10px sans-serif";
					ctx.fillText(s.label.slice(0, 12), p.px + r + 2, p.py + 3);
				}
			}
		};

		const tick = () => {
			if (frame < maxFrames) step();
			draw();
			frame++;
			if (mode === "2d" && frame >= maxFrames) return; // 2D 정착 후 정지(CPU 절약). 3D 는 회전 지속.
			raf = requestAnimationFrame(tick);
		};
		tick();
		return () => { if (raf) cancelAnimationFrame(raf); };
	}, [graph, mode]);

	return (
		<div className="knowledge-graph-view" data-testid="knowledge-graph" data-mode={mode}>
			<div className="knowledge-graph-toolbar">
				<span className="knowledge-graph-meta">
					노드 {graph.nodes.length} · 관계 {graph.edges.length} · 군집 {graph.communityCount}
				</span>
				<button
					type="button"
					className="knowledge-graph-mode"
					onClick={() => setMode((m) => (m === "2d" ? "3d" : "2d"))}
				>
					{mode === "2d" ? "3D 보기" : "2D 보기"}
				</button>
			</div>
			<canvas ref={canvasRef} width={W} height={H} className="knowledge-graph-canvas" />
		</div>
	);
}
