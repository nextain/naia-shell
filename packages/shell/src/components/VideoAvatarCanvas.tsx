import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAdkPath, writeSlotsManifest } from "../lib/adk-store";
import {
	clearCameraActions,
	registerCameraActions,
} from "../lib/avatar/camera-actions";
import {
	CascadeAvatarRenderer,
	localFacadeUrlFromReady,
	probeCascadeHealth,
} from "../lib/avatar/cascade-renderer";
import { detectGpuVramGb } from "../lib/capabilities/gpu";
import {
	resolveActiveTier,
	resolveLocalCapabilities,
} from "../lib/capabilities/vram-tiers";
import { loadConfig } from "../lib/config";
import { useAvatarStore } from "../stores/avatar";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";

interface VideoAvatarCanvasProps {
	nvaModel?: string;
}

type Mode = "loading" | "cascade" | "unavailable" | "error";

// 사용자 이동(pan) 오프셋 영속 — VRM 카메라 저장과 대칭. px 단위, 리셋으로 0.
const NVA_PAN_KEY = "naia-nva-pan-v1";
interface NvaPan {
	x: number;
	y: number;
}
function loadNvaPan(): NvaPan {
	try {
		const raw = localStorage.getItem(NVA_PAN_KEY);
		if (!raw) return { x: 0, y: 0 };
		const p = JSON.parse(raw) as Partial<NvaPan>;
		return { x: Number(p.x) || 0, y: Number(p.y) || 0 };
	} catch {
		return { x: 0, y: 0 };
	}
}
function saveNvaPan(p: NvaPan): void {
	try {
		localStorage.setItem(NVA_PAN_KEY, JSON.stringify(p));
	} catch {
		/* best-effort */
	}
}
function clearNvaPan(): void {
	try {
		localStorage.removeItem(NVA_PAN_KEY);
	} catch {
		/* best-effort */
	}
}

// 비디오를 VRM 과 같은 위치(왼쪽 naia 컬럼 중앙)로 배치 + 사용자 이동 오프셋.
// avatar-canvas-layer 는 전체 폭(100vw)이라 비디오가 화면 중앙(50vw)에 온다 →
// naia 컬럼 중앙(--naia-width/2)으로 translateX. 알파 webm 이라 투명 여백이 왼쪽으로
// 잘려도 인물은 프레임 중앙(≈컬럼 중앙)에 남아 무해(=VRM filmOffset 프레이밍과 대칭).
function videoTransform(pan: NvaPan): string {
	return `translate(calc(var(--naia-width, 320px) / 2 - 50vw + ${pan.x}px), ${pan.y}px)`;
}

const VIDEO_BASE_STYLE = {
	maxWidth: "min(100%, 56vh)",
	maxHeight: "92%",
	objectFit: "contain" as const,
};

/**
 * NVA 비디오 아바타 — cascade(Ditto 립싱크) 연결 시에만 노출.
 *  - cascade: 로컬 spawn facade(우선) 또는 원격 cascadeRuntimeUrl 도달 시 /idle 루프 + 발화 시
 *             립싱크 스트림. 렌더러를 store 에 등록 → ChatArea 이 발화 오디오를 흘려보냄(입 움직임).
 *  - 자동기동: 로컬 GPU 프로파일(아바타)+로그인이면 마운트 시 start_cascade 를 자동 호출.
 *  - 미연결: ★정적 idle 폴백을 만들지 않는다(사용자 요구: cascade 미적용 시 아바타 노출 X).
 *           상태만 은은하게 표면화("연결 중"/"미연결")한다.
 * SoT: .agents/progress/naia-shell-local-serving-wiring-diagnosis-2026-07-02.md
 */
export function VideoAvatarCanvas({ nvaModel }: VideoAvatarCanvasProps) {
	const setLoaded = useAvatarStore((s) => s.setLoaded);
	// 로컬 spawn 된 cascade facade URL(있으면 원격 config 보다 우선). 변경 시 재프로브.
	const localFacadeUrl = useCascadeAvatarStore((s) => s.localFacadeUrl);
	const [mode, setMode] = useState<Mode>("loading");
	const [error, setError] = useState("");
	// cascade 비디오 콜백 ref 가 렌더러를 만들 때 쓰는 설정(메인 effect 가 결정).
	const cascadeCfgRef = useRef<{ url: string; name: string } | null>(null);
	const rendererRef = useRef<CascadeAvatarRenderer | null>(null);
	// cascade 자동기동 1회 가드(재기동 루프 방지). nvaModel 변경 시 리셋.
	const autoStartAttemptedRef = useRef(false);
	// 사용자 이동(pan) 오프셋 — AiControlBar 의 ✥ 컨트롤러가 이 값을 누적한다.
	const [pan, setPan] = useState<NvaPan>(loadNvaPan);
	const panRef = useRef(pan);
	panRef.current = pan;

	// AiControlBar(⊕/✥/⌂)가 조작할 액션을 이 아바타 구현으로 등록. 2D 비디오라 회전은
	// 개념 없음(no-op) — 사용자 요청 = '이동(pan) 컨트롤러 동작'. VRM 이 대신 마운트되면
	// AvatarCanvas 가 자신의 카메라 액션으로 덮어쓴다(상호배타 마운트).
	useEffect(() => {
		registerCameraActions({
			rotate: () => {},
			pan: (dx, dy) => setPan((p) => ({ x: p.x + dx, y: p.y + dy })),
			reset: () => {
				setPan({ x: 0, y: 0 });
				clearNvaPan();
			},
			save: () => saveNvaPan(panRef.current),
		});
		return () => clearCameraActions();
	}, []);

	// nvaModel(캐릭터) 변경 시 cascade 자동기동 가드 리셋 → 새 아바타에 대해 재시도 허용.
	// (localFacadeUrl 변경으로 인한 effect 재실행 때는 리셋 안 됨 → 재기동 루프 방지.)
	// biome-ignore lint/correctness/useExhaustiveDependencies: nvaModel 변경 시에만 리셋
	useEffect(() => {
		autoStartAttemptedRef.current = false;
	}, [nvaModel]);

	useEffect(() => {
		let disposed = false;

		async function load() {
			setMode("loading");
			setLoaded(false);
			setError("");
			const adkPath = getAdkPath();
			if (!adkPath || !nvaModel) {
				setError("missing-nva-model");
				setMode("error");
				return;
			}
			// nvaModel 은 번들 폴더 '이름'이어야 한다(피커가 bare name 저장). 과거 헬퍼가
			// 절대경로를 넣은 적이 있어, 경로면 basename 만 취해 이중 결합을 방지한다.
			const bundleName =
				nvaModel.split(/[/\\]/).filter(Boolean).pop() ?? nvaModel;
			const sep = adkPath.includes("\\") ? "\\" : "/";
			const bundleDir = `${adkPath}${sep}naia-settings${sep}nva-files${sep}${bundleName}`;

			// (A) cascade 토킹 모드 — 로컬 spawn facade(우선) 또는 설정 cascadeRuntimeUrl + /health 도달 시
			const cascadeUrl =
				localFacadeUrl?.trim() || loadConfig()?.cascadeRuntimeUrl?.trim();
			if (cascadeUrl) {
				const ok = await probeCascadeHealth(cascadeUrl);
				if (disposed) return;
				if (ok) {
					// 로컬 임베드 cascade 면 번들 디렉토리로 캐릭터 등록(원격이면 경로 부재로 실패 → 무시).
					try {
						await fetch(`${cascadeUrl.replace(/\/$/, "")}/load_nva`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ dir: bundleDir }),
						});
					} catch {
						/* 등록 실패 비치명 — cascade 기본 캐릭터/idle 가능 */
					}
					if (disposed) return;
					cascadeCfgRef.current = { url: cascadeUrl, name: bundleName };
					setMode("cascade");
					setLoaded(true);
					return;
				}
			}

			// (B) cascade 미연결 — 로컬 프로파일이 있으면 cascade 를 자동 기동한다.
			// ★사용자 요구: 비디오 아바타는 cascade(Ditto 립싱크)에 연결됐을 때만 노출한다.
			//   미연결 시 정적 idle 클립을 "사진처럼" 세워두지 않는다(불투명 UX 제거).
			//   cascade 는 음성 프로바이더가 아니라 비디오 아바타 + 로컬 GPU 프로파일에 묶인다.
			const cfg = loadConfig();
			// cascade 자동기동 가능 여부 = 로컬 GPU 프로파일이 "avatar" capability 를 실제 제공할 때만.
			// SettingsTab 의 cascadeAvatarPossible 과 **동일 로직**(capability 기반) — 게이트 불일치로
			// "선택은 됐는데 영원히 미연결"/"voice 프로파일인데 아바타 기동" 같은 어긋남을 막는다.
			// (8G 배타에서 focus=voice/미지정 → resolveLocalCapabilities=["tts"] → avatar 없음 → false.)
			let canLocalCascade = false;
			if (cfg?.naiaKey && cfg.localGpuTier && cfg.localGpuTier !== "off") {
				const vram = await detectGpuVramGb();
				if (disposed) return;
				const tier = resolveActiveTier(cfg.localGpuTier, vram);
				canLocalCascade = resolveLocalCapabilities(
					tier,
					cfg.localAvatarVoiceFocus,
				).includes("avatar");
			}
			if (!autoStartAttemptedRef.current && canLocalCascade) {
				autoStartAttemptedRef.current = true;
				try {
					if (cfg) await writeSlotsManifest(cfg);
					const ready = await invoke<string>("start_cascade");
					if (disposed) return;
					const localUrl = localFacadeUrlFromReady(ready);
					if (localUrl) {
						// facade URL 설정 → 이 effect 재실행 → (A) cascade 모드로 연결(립싱크).
						useCascadeAvatarStore.getState().setLocalFacadeUrl(localUrl);
						return;
					}
				} catch (e) {
					if (disposed) return;
					setError(`cascade-start-failed: ${String(e)}`);
				}
			}
			// cascade 미연결(로컬 프로파일 없음/기동 실패/원격 미도달) → 아바타 노출 안 함.
			if (disposed) return;
			setMode("unavailable");
			setLoaded(false);
		}

		void load();
		return () => {
			disposed = true;
		};
	}, [nvaModel, setLoaded, localFacadeUrl]);

	// cascade 비디오 콜백 ref — 요소 마운트 시 렌더러 생성+start+store등록, 언마운트 시 stop+해제.
	// key={nvaModel} 로 캐릭터 변경 시 재마운트 → 새 렌더러.
	const cascadeVideoRef = useCallback((el: HTMLVideoElement | null) => {
		const setRenderer = useCascadeAvatarStore.getState().setRenderer;
		if (el) {
			const cfg = cascadeCfgRef.current;
			if (!cfg) return;
			const r = new CascadeAvatarRenderer(
				{
					runtimeUrl: cfg.url,
					nvaName: cfg.name,
				},
				// 발화 시작/종료 → 아바타 speaking 상태 동기화(자막·에코게이트 등 소비자와 일관).
				(talking) => useAvatarStore.getState().setSpeaking(talking),
			);
			rendererRef.current = r;
			r.start(el);
			setRenderer(r);
		} else {
			rendererRef.current?.stop();
			rendererRef.current = null;
			setRenderer(null);
		}
	}, []);

	return (
		<div
			data-video-avatar
			data-nva-model={nvaModel ?? ""}
			data-video-avatar-mode={mode}
			data-video-avatar-loaded={mode === "cascade" ? "true" : "false"}
			data-video-avatar-error={error}
			style={{
				position: "relative",
				width: "100%",
				height: "100%",
				overflow: "hidden",
				display: "grid",
				placeItems: "center",
			}}
		>
			{mode === "cascade" ? (
				// host = idle 루프(/idle). 렌더러가 src 와 발화 오버레이(buf)를 관리. 마스크 불요(cascade 가 알파/프레이밍 소유).
				<video
					key={nvaModel}
					ref={cascadeVideoRef}
					playsInline
					muted
					loop
					style={{ ...VIDEO_BASE_STYLE, transform: videoTransform(pan) }}
				/>
			) : (
				// ★cascade 미연결 → 캐릭터(비디오)를 노출하지 않는다(정적 사진 폴백 제거).
				//   상태만 은은하게 표면화(멀뚱히 선 "사진"으로 오해되지 않도록).
				<div
					data-video-avatar-status={mode}
					style={{
						fontSize: "0.85em",
						opacity: 0.5,
						textAlign: "center",
						padding: "1em",
						lineHeight: 1.6,
						pointerEvents: "none",
					}}
				>
					{mode === "loading"
						? "로컬 아바타(cascade) 연결 중…"
						: mode === "error"
							? `아바타 연결 실패${error ? ` — ${error}` : ""}`
							: "로컬 아바타 미연결 — 프로파일 탭에서 로컬 GPU 프로파일 + Naia 로그인을 확인하세요."}
				</div>
			)}
		</div>
	);
}
