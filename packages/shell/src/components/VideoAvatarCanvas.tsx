import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAdkPath, writeSlotsManifest } from "../lib/adk-store";
import {
	clearCameraActions,
	registerCameraActions,
} from "../lib/avatar/camera-actions";
import {
	CascadeAvatarRenderer,
	ensureRemoteCharacter,
	localFacadeUrlFromReady,
	probeCascadeHealth,
	remoteCascadeUrlFromConfig,
} from "../lib/avatar/cascade-renderer";
import { hasExplicitLocalAvatarProfile } from "../lib/avatar/nva-gate";
import { loadConfig } from "../lib/config";
import { useAvatarStore } from "../stores/avatar";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";

interface VideoAvatarCanvasProps {
	nvaModel?: string;
}

// loading=기동/연결 중, cascade=립싱크 라이브, standby=로컬 적용됐으나 백엔드 미기동(대기),
// unavailable=로컬 프로파일 없음/원격 미도달, error=치명 오류.
type Mode = "loading" | "cascade" | "standby" | "unavailable" | "error";

// standby(대기중)에서 백엔드가 뜨는지 재확인하는 폴링 주기(ms). 재기동은 안 하고 상태만 본다.
const RETRY_POLL_MS = 4000;

function isLoopbackRuntime(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
	} catch {
		return false;
	}
}

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
 *  - cascade: 명시한 원격 cascadeRuntimeUrl 또는 로컬 spawn facade 도달 시 /idle 루프 + 발화 시
 *             립싱크 스트림. 렌더러를 store 에 등록 → ChatArea 이 발화 오디오를 흘려보냄(입 움직임).
 *  - 자동기동: 로컬 GPU 프로파일(아바타)+로그인이면 마운트 시 start_cascade 를 자동 호출.
 *  - 미연결: ★정적 idle 폴백을 만들지 않는다(사용자 요구: cascade 미적용 시 아바타 노출 X).
 *           상태만 은은하게 표면화("연결 중"/"미연결")한다.
 * SoT: .agents/progress/naia-shell-local-serving-wiring-diagnosis-2026-07-02.md
 */
export function VideoAvatarCanvas({ nvaModel }: VideoAvatarCanvasProps) {
	const setLoaded = useAvatarStore((s) => s.setLoaded);
	// 로컬 spawn 된 cascade facade URL. 명시한 원격 NVA Host가 있으면 그 설정이 우선한다.
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
		let retryTimer: ReturnType<typeof setTimeout> | null = null;

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

			// Local cascade may start only from an explicit avatar-capable local profile.
			// Legacy auto/off or stale remote config must not unlock local NVA after logout.
			const cfg = loadConfig();
			const canLocalCascade = hasExplicitLocalAvatarProfile(cfg);

			// (A) cascade 토킹 모드 — 명시한 원격 NVA Host 또는 로컬 spawn facade가 /health에 도달할 때.
			// ★알려진 URL 이 없어도 이미 떠 있는 cascade(warm/이전 세션/설정 탭 기동)가 있으면 그 facade
			//   URL 을 확보한다(self-heal): localFacadeUrl store 는 인메모리라 앱 재시작으로 비고,
			//   start_cascade 는 실행 중이면 캐시 ready 반환(재spawn 아님) → facade_port 확보.
			const configuredCascadeUrl = remoteCascadeUrlFromConfig(cfg);
			// An explicitly configured NVA Host is a user routing decision. It must
			// win over a local profile facade and must never trigger local Ditto as
			// an implicit fallback when the remote health check is transiently down.
			let cascadeUrl = configuredCascadeUrl || localFacadeUrl?.trim();
			if (!cascadeUrl) {
				try {
					if (await invoke<boolean>("cascade_status")) {
						if (disposed) return;
						const url = localFacadeUrlFromReady(
							await invoke<string>("start_cascade"),
						);
						if (url) {
							cascadeUrl = url;
							useCascadeAvatarStore.getState().setLocalFacadeUrl(url);
						}
					}
				} catch {
					/* status/ready 확인 실패 비치명 — 아래 자동기동/대기 경로로 진행 */
				}
				if (disposed) return;
			}
			if (cascadeUrl) {
				const ok = await probeCascadeHealth(cascadeUrl);
				if (disposed) return;
				if (ok) {
					// /load_nva.dir is a server-local path contract. A remote 3090 already
					// has its active NVA; never send it a Windows bundleDir.
					if (!isLoopbackRuntime(cascadeUrl)) {
						// 피커 선택을 원격 활성 캐릭터로 반영: /use_character 로 전환하고,
						// 서버 미등록(예: 재부팅으로 /tmp 업로드분 소실)이면 로컬 번들을 자동
						// 업로드(Rust upload_nva_bundle = 슬래시 엔트리 zip, 백슬래시 버그 원천봉쇄)
						// 후 재전환. 실패 = 서버 활성 캐릭터 유지(fail-soft, 비치명).
						await ensureRemoteCharacter(cascadeUrl, bundleName, () =>
							invoke<string>("upload_nva_bundle", {
								runtimeUrl: cascadeUrl,
								bundleDir,
							}).then(() => undefined),
						);
						if (disposed) return;
						cascadeCfgRef.current = { url: cascadeUrl, name: "" };
						setMode("cascade");
						setLoaded(true);
						return;
					}
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
			if (configuredCascadeUrl) {
				setMode("unavailable");
				setLoaded(false);
				return;
			}

			// (B) cascade 미연결 — 로컬 프로파일이 있으면 cascade 를 자동 기동(1회)한다.
			// ★사용자 요구: 비디오 아바타는 cascade(Ditto 립싱크)에 연결됐을 때만 노출한다.
			//   미연결 시 정적 idle 클립을 "사진처럼" 세워두지 않는다(불투명 UX 제거).
			if (canLocalCascade && !autoStartAttemptedRef.current) {
				autoStartAttemptedRef.current = true;
				setMode("loading");
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

			// (C) 미연결 확정. 로컬 아바타 프로파일이면 "로컬 모델 대기중"(R7) + 폴링 복구(R8):
			//     백엔드가 (느리게/외부에서/재기동으로) 정상적으로 뜨면 자동 인지해 연결한다.
			//     재기동은 안 하고(비용/VRAM), cascade_status 로 "실행 중"을 감지하면 start_cascade 가
			//     캐시된 ready 를 반환 → facade URL 확보 → setLocalFacadeUrl → effect 재실행 → (A).
			if (disposed) return;
			if (canLocalCascade) {
				setMode("standby");
				setLoaded(false);
				const poll = async () => {
					if (disposed) return;
					try {
						const running = await invoke<boolean>("cascade_status");
						if (!disposed && running) {
							const ready = await invoke<string>("start_cascade"); // 실행 중이면 캐시 ready
							if (disposed) return;
							const url = localFacadeUrlFromReady(ready);
							if (url) {
								useCascadeAvatarStore.getState().setLocalFacadeUrl(url);
								return; // → effect 재실행 → (A) 연결
							}
						}
					} catch {
						/* 폴링 실패 비치명 — 다음 주기 재시도 */
					}
					if (!disposed) retryTimer = setTimeout(poll, RETRY_POLL_MS);
				};
				retryTimer = setTimeout(poll, RETRY_POLL_MS);
			} else {
				// 로컬 프로파일 없음/원격 미도달 → 아바타 노출 안 함.
				setMode("unavailable");
				setLoaded(false);
			}
		}

		void load();
		return () => {
			disposed = true;
			if (retryTimer) clearTimeout(retryTimer);
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
			// PUT /voice 계약: 셸에 설정된 레퍼런스 음색을 연결 시점에 서버 활성 음성으로 민다
			// (없으면 서버 기본 = naia 팔레트 유지). NVA 전환과 독립 — 캐릭터가 음색을 못 덮는다.
			void r.setVoice(loadConfig()?.voiceRefUrl);
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
						? "비디오 아바타 불러오는 중…"
						: mode === "standby"
							? "비디오 아바타 준비 중… (잠시 후 표시됩니다)"
							: mode === "error"
								? `비디오 아바타 연결 실패${error ? ` — ${error}` : ""}`
								: "비디오 아바타 미연결 — 설정에서 로컬 GPU 프로파일과 로그인을 확인하세요."}
				</div>
			)}
		</div>
	);
}
