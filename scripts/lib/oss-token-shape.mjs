// oss-token-shape — 공개 식별자 형태 검사 유틸리티.
//
// WebView2 COM 인터페이스(예: ICoreWebView2PermissionRequestedEventArgs3)와 같은
// 공개 타입명은 긴 CamelCase 단어이며 Shannon entropy 가 4.2 이상으로 측정되어
// 고엔트로피 비밀값(high-entropy-token)으로 오탐될 수 있다.
// 무작위 키나 비밀값 토큰은 각 세그먼트마다 2자 이상의 소문자를 유지하지 못하는 반면,
// 공개 타입명은 [1~3 대문자 + 2자 이상 소문자 + 0~2 숫자] 세그먼트가 연속된다.
// 따라서 3개 이상의 CamelCase 세그먼트로 구성된 완전한 식별자는 비밀값 검사에서 제외한다.

const FULL_IDENTIFIER_RE = /^(?:[A-Z]{1,3}[a-z]{2,}[0-9]{0,2})+$/;
const SEGMENT_RE = /[A-Z]{1,3}[a-z]{2,}[0-9]{0,2}/g;

/**
 * 토큰이 공개 코드 식별자(CamelCase 타입명 등) 형태인지 판별한다.
 *
 * @param {string} tok
 * @returns {boolean}
 */
export function isCodeIdentifierShape(tok) {
	if (typeof tok !== "string") return false;
	if (!FULL_IDENTIFIER_RE.test(tok)) return false;
	const segments = tok.match(SEGMENT_RE);
	return (segments?.length ?? 0) >= 3;
}
