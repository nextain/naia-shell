// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
	KIOSK_PASSCODE_PASSED_KEY,
	KIOSK_PASSCODE_SHA256,
	hasPassedKioskPasscode,
	markKioskPasscodePassed,
	sha256Hex,
	verifyKioskPasscode,
} from "./passcode";

// 진짜 비밀번호는 시험에 적지 않는다. 흉내 값의 해시를 대조 함수에 넣어 확인한다.
const FAKE_PASSCODE = "0000";

describe("kiosk passcode", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("keeps only a sha256 of the passcode in code", () => {
		expect(KIOSK_PASSCODE_SHA256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("hashes with sha256 like `printf %s <값> | sha256sum`", async () => {
		expect(await sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("accepts only the 4-digit value whose hash matches", async () => {
		const fakeSha256 = await sha256Hex(FAKE_PASSCODE);
		expect(await verifyKioskPasscode(FAKE_PASSCODE, fakeSha256)).toBe(true);
		expect(await verifyKioskPasscode("1111", fakeSha256)).toBe(false);
		expect(await verifyKioskPasscode("", fakeSha256)).toBe(false);
		expect(await verifyKioskPasscode("000", fakeSha256)).toBe(false);
		expect(await verifyKioskPasscode("00000", fakeSha256)).toBe(false);
		expect(await verifyKioskPasscode("abcd", fakeSha256)).toBe(false);
		// 흉내 값은 운영 해시로는 통과하지 못한다.
		expect(await verifyKioskPasscode(FAKE_PASSCODE)).toBe(false);
	});

	it("remembers only that this browser passed", () => {
		expect(hasPassedKioskPasscode()).toBe(false);
		markKioskPasscodePassed();
		expect(hasPassedKioskPasscode()).toBe(true);
		expect(localStorage.getItem(KIOSK_PASSCODE_PASSED_KEY)).toBe("1");
		expect(localStorage.length).toBe(1);
	});
});
