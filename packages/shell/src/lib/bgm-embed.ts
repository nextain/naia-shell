// FR-WEB-BGM-PLAY (R31): YouTube BGM iframe 를 실제로 띄우고 ▶ 가 실제 곡을 싣게 하는 순수 규칙.

/**
 * 웹판 포털은 `/app` 을 cross-origin isolated(COEP `credentialless`)로 내보낸다.
 * 이때 COEP 헤더가 없는 YouTube embed 문서는 일반 iframe 으로 실을 수 없어
 * (`ERR_BLOCKED_BY_RESPONSE`, `coep-frame-resource-needs-coep-header`) 빈 프레임이 된다.
 * `credentialless` iframe 은 쿠키 없는 별도 저장소로 실려 COEP 없이도 허용된다.
 * isolation 이 없는 데스크톱·로컬 개발에서는 속성을 달지 않아 기존 동작을 그대로 둔다.
 */
export function bgmIframeIsolationAttrs(
	crossOriginIsolated: boolean,
): Record<string, string> {
	return crossOriginIsolated ? { credentialless: "" } : {};
}

export interface BgmStartCandidate {
	id: string;
	title: string;
	thumbnail: string;
	duration: string;
	channel: string;
}

/**
 * 재생기에 iframe 이 없을 때 ▶ 가 실을 곡. 지금 곡 → 마지막 곡 → (호출자가 재생목록 다음 곡을 먼저 시도한 뒤) 기본 곡.
 * 아무것도 없으면 null — 그때 ▶ 는 "재생 중" 표시를 켜지 않는다.
 */
export function pickYoutubeStartTrack(
	current: BgmStartCandidate | null | undefined,
	last: BgmStartCandidate | null | undefined,
): BgmStartCandidate | null {
	return current ?? last ?? null;
}

export function webCatalogStartTrack(
	catalog: readonly { id: string; title: string; channel: string; duration: string }[],
): BgmStartCandidate | null {
	const first = catalog[0];
	if (!first) return null;
	return {
		id: first.id,
		title: first.title,
		channel: first.channel,
		duration: first.duration,
		thumbnail: `https://i.ytimg.com/vi/${first.id}/hqdefault.jpg`,
	};
}

/**
 * 웹판은 요청하자마자 "재생 중"으로 표시한다. 정해진 시간 안에 플레이어가 진행(currentTime>0)을
 * 한 번도 알리지 않았으면 실제로는 시작되지 않은 것이다(페이지 Permissions-Policy 의 autoplay 차단,
 * 봇 확인 화면, embed 거부). 그 판정만 한다 — 사용자가 멈췄거나 다른 곡으로 바뀌었으면 false.
 */
export function youtubeNeverStarted(input: {
	checkedPlaybackId: string;
	currentPlaybackId: string | null;
	observedPlaybackId: string | null;
	lastCurrentTime: number | null;
	manuallyStopped: boolean;
}): boolean {
	if (input.manuallyStopped) return false;
	if (input.currentPlaybackId !== input.checkedPlaybackId) return false;
	if (input.observedPlaybackId !== input.checkedPlaybackId) return false;
	return !(input.lastCurrentTime !== null && input.lastCurrentTime > 0);
}
