import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../config", () => ({
	DEFAULT_GATEWAY_URL: "ws://localhost:18789",
	// 스토어 자격 확인은 채팅 게이트웨이가 아니라 랩 게이트웨이를 쓴다(#471).
	// 목에 이 상수가 없으면 소스가 아니라 목이 먼저 터진다.
	LAB_GATEWAY_URL: "ws://localhost:18789",
	loadConfig: vi.fn(() => ({
		gatewayUrl: "ws://localhost:18789/",
	})),
}));

import {
	getStoreGatewayUrl,
	getStoreProductName,
	getStoreProductMetadata,
	hasStoreEntitlement,
} from "../app-store-client";

describe("app-store-client", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	beforeEach(() => {
		vi.restoreAllMocks();
		invoke.mockReset();
	});

	it("derives the HTTP gateway used for native entitlement checks", () => {
		expect(getStoreGatewayUrl()).toBe("http://localhost:18789");
	});

	it("checks ownership behind native IPC", async () => {
		invoke.mockResolvedValue(true);
		await expect(hasStoreEntitlement("slides")).resolves.toBe(true);
		expect(invoke).toHaveBeenCalledWith("app_store_has_entitlement", {
			appId: "slides",
			gatewayUrl: "http://localhost:18789",
		});
	});

	it("resolves the localized product name from the public catalog", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: [
						{
							app_id: "land.naia.slides",
							manifest: { nameKo: "나이아 슬라이드" },
						},
					],
				}),
			}),
		);

		await expect(getStoreProductName("land.naia.slides")).resolves.toBe(
			"나이아 슬라이드",
		);
	});

	it("does not borrow another product's name", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: [{ app_id: "another.app", manifest: { name: "Wrong" } }],
				}),
			}),
		);

		await expect(getStoreProductName("land.naia.slides")).resolves.toBeNull();
	});

	it("selects catalog copy for the requested language before the default and preserves the thumbnail", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ app_id: "app", manifest: { name: "Default", nameKo: "한국어", nameEn: "English", description: "Default description", descriptionKo: "설명", descriptionEn: "Description", thumbnailUrl: "/thumb.png" } }] }) }));
		await expect(getStoreProductMetadata("app", "ko")).resolves.toEqual({ name: "한국어", description: "설명", thumbnailUrl: "/thumb.png", permissions: null });
		await expect(getStoreProductMetadata("app", "en")).resolves.toEqual({ name: "English", description: "Description", thumbnailUrl: "/thumb.png", permissions: null });
	});
});
