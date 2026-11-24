// IR 시연판(음성으로 대답하는 웹 키오스크) 깃발.
// 시연 기본값(지나·게스트·지식·기억·BC250)은 이 깃발이 켜졌을 때만 쓴다.
// 일반 웹판(#824)에는 새지 않게 한다. 빌드: VITE_NAIA_KIOSK_DEMO=1 vite build --mode web
// 범위 문서: alpha-adk docs/common/naia/web-ir-demo-scope-20261105.md

export function isKioskDemo(): boolean {
	return import.meta.env.MODE === "web" && import.meta.env.VITE_NAIA_KIOSK_DEMO === "1";
}
