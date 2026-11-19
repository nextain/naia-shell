/**
 * R13: 웹판(브라우저)에는 Tauri ADK 파일이 없다. 게이트웨이 올리기가 성공한 뒤
 * 로컬 사본 함수가 Tauri invoke 를 불러 "알 수 없는 오류"로 끝나지 않아야 한다.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../adk-store", () => ({ getAdkPath: () => "naia-adk" }));
vi.mock("../../web-runtime/web-assets", () => ({ isWebMode: () => true }));
vi.mock("../../config", () => ({
	DEFAULT_LOCAL_VOICE_HOST: "http://localhost:8910",
	LAB_GATEWAY_URL: "https://gateway.test",
	getNaiaKeySecure: vi.fn().mockResolvedValue("gw-test-key"),
	canonicalRefAudioUrl: (url: string) => url,
}));
vi.mock("../../logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	clearLocalRefAudio,
	getLocalRefAudioB64,
	hydrateLocalRefAudioB64,
	persistLocalRefAudioB64,
} from "../ref-audio-api";

describe("R13 web build reference voice local copy", () => {
	const storage = new Map<string, string>();

	beforeEach(() => {
		storage.clear();
		mockInvoke.mockReset();
		mockInvoke.mockRejectedValue(new Error("Tauri is not available"));
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		});
	});

	it("R13 persist after a gateway upload does not call Tauri or throw", async () => {
		await expect(persistLocalRefAudioB64("UklGRiQAAABXQVZF")).resolves.toBeUndefined();
		expect(mockInvoke).not.toHaveBeenCalled();
		// 게이트웨이가 원본을 가지므로 브라우저에 사본을 남기지 않는다.
		expect(getLocalRefAudioB64()).toBeNull();
	});

	it("R13 hydrate and clear skip Tauri in the web build", async () => {
		await expect(hydrateLocalRefAudioB64()).resolves.toBeNull();
		await expect(clearLocalRefAudio()).resolves.toBeUndefined();
		expect(mockInvoke).not.toHaveBeenCalled();
	});
});
