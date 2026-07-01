/**
 * cascade 토킹 아바타 렌더러 공유 store.
 *
 * VideoAvatarCanvas 가 cascade 모드로 진입하면 활성 CascadeAvatarRenderer 를 여기 등록하고,
 * ChatPanel(발화 파이프라인)이 이를 읽어 `renderer.speak(text)`/`interrupt()` 로 입을 움직인다.
 * cascade 미사용(정적 폴백)이면 renderer = null → ChatPanel 은 평소 로컬 TTS 경로를 탄다.
 *
 * SoT: .agents/progress/naia-os-cascade-talking-avatar-2026-07-01.md
 */
import { create } from "zustand";
import type { CascadeAvatarRenderer } from "../lib/avatar/cascade-renderer";

interface CascadeAvatarState {
	/** 활성 cascade 렌더러. null = cascade 비활성(정적 폴백 또는 VRM). */
	renderer: CascadeAvatarRenderer | null;
	setRenderer: (r: CascadeAvatarRenderer | null) => void;
	/**
	 * 로컬 spawn 된 cascade facade URL(`http://127.0.0.1:{facade_port}`). start_cascade 의
	 * CASCADE_READY 페이로드에서 유도. 설정된 원격 `cascadeRuntimeUrl` 보다 우선(로컬 우선).
	 * null = 로컬 cascade 미가동 → VideoAvatarCanvas 는 config.cascadeRuntimeUrl 로 폴백.
	 */
	localFacadeUrl: string | null;
	setLocalFacadeUrl: (url: string | null) => void;
}

export const useCascadeAvatarStore = create<CascadeAvatarState>((set) => ({
	renderer: null,
	setRenderer: (renderer) => set({ renderer }),
	localFacadeUrl: null,
	setLocalFacadeUrl: (localFacadeUrl) => set({ localFacadeUrl }),
}));
