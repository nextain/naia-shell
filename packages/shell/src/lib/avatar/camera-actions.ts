/**
 * 아바타 이동/회전 액션 브리지 — AiControlBar(⊕회전 / ✥이동 / ⌂리셋)가 **현재 활성 아바타**를
 * 조작하도록 하는 경량 싱글턴.
 *
 * 3D VRM(AvatarCanvas: three.js 카메라)과 2D NVA 비디오(VideoAvatarCanvas: CSS transform)는
 * `avatarProvider` 분기로 한 번에 하나만 마운트된다. 각 컴포넌트가 마운트 시 자신의 구현을 이
 * 싱글턴에 등록하고, 언마운트 시 no-op 으로 되돌린다. AiControlBar 는 어느 아바타가 붙어있든
 * 동일하게 `getCameraActions().pan(...)` 만 호출한다.
 *
 * 별도 모듈로 분리한 이유: VideoAvatarCanvas 가 이 브리지 하나 때문에 three.js 를 끌어오는
 * AvatarCanvas 를 import 하지 않도록(번들 분리).
 */
export type CameraActions = {
	rotate: (dx: number, dy: number) => void;
	pan: (dx: number, dy: number) => void;
	reset: () => void;
	save: () => void;
};

const _cameraActions: CameraActions = {
	rotate: () => {},
	pan: () => {},
	reset: () => {},
	save: () => {},
};

/** 활성 아바타의 이동/회전 액션. 반환 객체는 안정적(싱글턴) — 등록 측이 필드를 교체한다. */
export function getCameraActions(): CameraActions {
	return _cameraActions;
}

/** 마운트 측이 자신의 구현을 등록. */
export function registerCameraActions(actions: Partial<CameraActions>): void {
	Object.assign(_cameraActions, actions);
}

/** 언마운트 측이 no-op 으로 되돌림(다음 아바타가 등록하기 전까지 안전). */
export function clearCameraActions(): void {
	_cameraActions.rotate = () => {};
	_cameraActions.pan = () => {};
	_cameraActions.reset = () => {};
	_cameraActions.save = () => {};
}
