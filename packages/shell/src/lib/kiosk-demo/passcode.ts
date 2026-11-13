// 시연 첫 화면 비밀번호(숫자 4자리). 정적 사이트라 화면에서만 막는다.
// 비밀번호 숫자는 코드에 두지 않고 sha256 값으로만 대조한다.

export const KIOSK_PASSCODE_SHA256 =
	"b2cf84c62d338adb214f88c9e56a42a8e87c17ae5f7eb176bb248b3cb6baa4f7";
export const KIOSK_PASSCODE_LENGTH = 4;
export const KIOSK_PASSCODE_PASSED_KEY = "naia-kiosk-passcode-passed";

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function verifyKioskPasscode(
	input: string,
	expectedSha256: string = KIOSK_PASSCODE_SHA256,
): Promise<boolean> {
	if (!/^\d{4}$/.test(input)) return false;
	try {
		return (await sha256Hex(input)) === expectedSha256.toLowerCase();
	} catch {
		return false;
	}
}

/** 통과 여부만 남긴다. 비밀번호나 해시는 저장하지 않는다. */
export function hasPassedKioskPasscode(): boolean {
	try {
		return (
			typeof localStorage !== "undefined" &&
			localStorage.getItem(KIOSK_PASSCODE_PASSED_KEY) === "1"
		);
	} catch {
		return false;
	}
}

export function markKioskPasscodePassed(): void {
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(KIOSK_PASSCODE_PASSED_KEY, "1");
		}
	} catch {
		// ignore storage errors
	}
}
