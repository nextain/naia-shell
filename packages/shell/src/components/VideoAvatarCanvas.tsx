import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAdkPath, toLocalBlobUrl } from "../lib/adk-store";
import {
	clearCameraActions,
	registerCameraActions,
} from "../lib/avatar/camera-actions";
import {
	CascadeAvatarRenderer,
	probeCascadeHealth,
} from "../lib/avatar/cascade-renderer";
import { loadConfig } from "../lib/config";
import { parseNvaManifest, resolveNvaAssetPath } from "../lib/nva";
import { useAvatarStore } from "../stores/avatar";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";

interface VideoAvatarCanvasProps {
	nvaModel?: string;
}

function decodeBase64Utf8(b64: string): string {
	const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

type Mode = "loading" | "cascade" | "static" | "error";

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
 * NVA 비디오 아바타 — 두 모드:
 *  - cascade: cascadeRuntimeUrl 도달 시 cascade 런타임(Ditto)의 /idle 루프 + 발화 시 립싱크 스트림.
 *             렌더러를 store 에 등록 → ChatPanel 이 발화를 renderer.speak 로 흘려보냄(입 움직임).
 *  - static : 폴백. 로컬 번들의 idle 클립 loop + CSS 마스크(입 안 움직임). cascade 미설정/미도달 시.
 * SoT: .agents/progress/naia-os-cascade-talking-avatar-2026-07-01.md
 */
export function VideoAvatarCanvas({ nvaModel }: VideoAvatarCanvasProps) {
	const setLoaded = useAvatarStore((s) => s.setLoaded);
	// 로컬 spawn 된 cascade facade URL(있으면 원격 config 보다 우선). 변경 시 재프로브.
	const localFacadeUrl = useCascadeAvatarStore((s) => s.localFacadeUrl);
	const [mode, setMode] = useState<Mode>("loading");
	const [videoUrl, setVideoUrl] = useState("");
	const [maskUrl, setMaskUrl] = useState("");
	const [error, setError] = useState("");
	// cascade 비디오 콜백 ref 가 렌더러를 만들 때 쓰는 설정(메인 effect 가 결정).
	const cascadeCfgRef = useRef<{ url: string; name: string } | null>(null);
	const rendererRef = useRef<CascadeAvatarRenderer | null>(null);
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
			pan: (dx, dy) =>
				setPan((p) => ({ x: p.x + dx, y: p.y + dy })),
			reset: () => {
				setPan({ x: 0, y: 0 });
				clearNvaPan();
			},
			save: () => saveNvaPan(panRef.current),
		});
		return () => clearCameraActions();
	}, []);

	useEffect(() => {
		let disposed = false;
		let localVideoUrl = "";
		let localMaskUrl = "";

		async function load() {
			setMode("loading");
			setLoaded(false);
			setError("");
			setVideoUrl("");
			setMaskUrl("");
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

			// (B) 정적 폴백 — 로컬 blob idle 루프 (입 안 움직임)
			const manifestPath = `${bundleDir}${sep}manifest.json`;
			try {
				const b64 = await invoke<string>("read_local_binary", {
					path: manifestPath,
					allowedBase: adkPath,
				});
				const manifest = parseNvaManifest(decodeBase64Utf8(b64));
				const clip = manifest.clips[manifest.defaultClip];
				localVideoUrl = await toLocalBlobUrl(
					resolveNvaAssetPath(bundleDir, clip.video),
				);
				if (clip.mask) {
					localMaskUrl = await toLocalBlobUrl(
						resolveNvaAssetPath(bundleDir, clip.mask),
					);
				}
				if (disposed) return;
				setVideoUrl(localVideoUrl);
				setMaskUrl(localMaskUrl);
				setMode("static");
				setLoaded(true);
			} catch (err) {
				if (disposed) return;
				setError(String(err));
				setMode("error");
				setLoaded(false);
			}
		}

		void load();
		return () => {
			disposed = true;
			if (localVideoUrl.startsWith("blob:")) URL.revokeObjectURL(localVideoUrl);
			if (localMaskUrl.startsWith("blob:")) URL.revokeObjectURL(localMaskUrl);
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
			data-video-avatar-loaded={mode === "cascade" || videoUrl ? "true" : "false"}
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
				videoUrl && (
					<video
						src={videoUrl}
						autoPlay
						loop
						muted
						playsInline
						style={{
							...VIDEO_BASE_STYLE,
							transform: videoTransform(pan),
							WebkitMaskImage: maskUrl ? `url("${maskUrl}")` : undefined,
							maskImage: maskUrl ? `url("${maskUrl}")` : undefined,
							WebkitMaskSize: "contain",
							maskSize: "contain",
							WebkitMaskRepeat: "no-repeat",
							maskRepeat: "no-repeat",
							WebkitMaskPosition: "center",
							maskPosition: "center",
						}}
					/>
				)
			)}
		</div>
	);
}
