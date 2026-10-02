// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, ...args: unknown[]) => {
		if (cmd === "frontend_log") return Promise.resolve();
		return invokeMock(cmd, ...args);
	}),
}));

let eventListeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
		eventListeners.set(eventName, handler);
		return () => {
			eventListeners.delete(eventName);
		};
	}),
}));

vi.mock("../../lib/config", () => ({
	LAB_GATEWAY_URL: "https://api.naia.test",
	getNaiaKeySecure: vi.fn(async () => "gw-testkey123"),
}));

// Real steam-billing is NOT mocked per #729 instructions.
// HTTP fetch is mocked at network level.
const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import { listen } from "@tauri-apps/api/event";
import { getNaiaKeySecure } from "../../lib/config";
import * as steamBilling from "../../lib/steam-billing";
import { SteamPurchaseModal } from "../SteamPurchaseModal";
import { setLocale } from "../../lib/i18n";
import { useAppStore } from "../../stores/app";

describe("SteamPurchaseModal component (#729)", () => {
	const defaultPacks = [
		{ id: "pack-100", price_cents: 999, currency: "USD", credits: 1000 },
		{ id: "pack-250", price_cents: 1999, currency: "USD", credits: 2500 },
	];

	beforeEach(async () => {
		document.body.innerHTML = "";
		await setLocale("ko");
		vi.clearAllMocks();
		eventListeners.clear();
		invokeMock.mockReset();
		vi.mocked(listen).mockImplementation(async (eventName: any, handler: any) => {
			eventListeners.set(eventName, handler);
			return () => {
				eventListeners.delete(eventName);
			};
		});
		vi.mocked(getNaiaKeySecure).mockImplementation(async () => "gw-testkey123");

		// Default packs fetch response
		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return {
					ok: true,
					status: 200,
					json: async () => defaultPacks,
				};
			}
			return {
				ok: false,
				status: 404,
				json: async () => ({ detail: { error: "not_found" } }),
			};
		});
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
	});

	it("renders nothing when isOpen is false", () => {
		const { container } = render(
			<SteamPurchaseModal isOpen={false} onClose={vi.fn()} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders modal and loads packs from fetch when isOpen is true", async () => {
		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByRole("dialog")).toBeDefined();
		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
			expect(screen.getByText("2500 크레딧")).toBeDefined();
		});
	});

	it("client flow: starts purchase, awaits early listener, handles microtxn authorization, finalizes order and shows success", async () => {
		let orderPostCount = 0;
		let finalizePostCount = 0;

		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
				orderPostCount++;
				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-12345",
						status: "INITIATED",
						flow: "client",
						steamurl: null,
						pack: defaultPacks[1],
					}),
				};
			}
			if (urlStr.includes("/finalize")) {
				finalizePostCount++;
				return {
					ok: true,
					status: 200,
					json: async () => ({ status: "GRANTED", granted_now: true }),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		const onPurchaseSuccess = vi.fn();
		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
				onPurchaseSuccess={onPurchaseSuccess}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("2500 크레딧")).toBeDefined();
		});

		// Select the second pack
		fireEvent.click(screen.getByText("2500 크레딧"));

		// Click purchase button
		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(orderPostCount).toBe(1);
			expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
		});

		// Simulate authorization callback arriving from Steam SDK
		const handler = eventListeners.get("steam_microtxn_authorization");
		expect(handler).toBeDefined();
		handler!({
			payload: {
				app_id: 5354630,
				order_id: "order-12345",
				authorized: true,
			},
		});

		await waitFor(() => {
			expect(finalizePostCount).toBe(1);
			expect(onPurchaseSuccess).toHaveBeenCalledTimes(1);
			expect(screen.getByText("크레딧 충전이 완료되었습니다!")).toBeDefined();
		});
	});

	it("early authorization: microtxn event arrives before order HTTP POST completes, automatically finalizes when order arrives", async () => {
		let finalizeDone = false;

		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
				// While order POST is in-flight, Steam SDK emits authorization event early!
				const handler = eventListeners.get("steam_microtxn_authorization");
				if (handler) {
					handler({
						payload: {
							app_id: 5354630,
							order_id: "order-buffered-99",
							authorized: true,
						},
					});
				}

				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-buffered-99",
						status: "INITIATED",
						flow: "client",
						steamurl: null,
						pack: defaultPacks[0],
					}),
				};
			}
			if (urlStr.includes("/finalize")) {
				finalizeDone = true;
				return {
					ok: true,
					status: 200,
					json: async () => ({ status: "GRANTED", granted_now: true }),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(finalizeDone).toBe(true);
			expect(screen.getByText("크레딧 충전이 완료되었습니다!")).toBeDefined();
		});
	});

	it("idempotency key and pack preservation on retry even after pack selection change (#729 지적 2)", async () => {
		const orderBodies: any[] = [];
		let postAttempt = 0;

		fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
				postAttempt++;
				if (init?.body) {
					orderBodies.push(JSON.parse(String(init.body)));
				}
				if (postAttempt === 1) {
					// 1st POST fails (e.g. response lost / network failure)
					throw new Error("Network connection lost");
				}
				// 2nd POST succeeds
				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-retry-123",
						status: "INITIATED",
						flow: "client",
						steamurl: null,
						pack: defaultPacks[0],
					}),
				};
			}
			if (urlStr.includes("/finalize")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						status: "GRANTED",
						granted_now: true,
					}),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		// 1. Initial selection: 1000 credits (pack-1)
		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		// First attempt fails with error message and displays retry button
		await waitFor(() => {
			expect(screen.getByText("Network connection lost")).toBeDefined();
			expect(screen.getByText("다시 시도")).toBeDefined();
		});

		expect(orderBodies.length).toBe(1);
		const firstKey = orderBodies[0].idempotency_key;
		expect(firstKey).toBeTruthy();
		expect(orderBodies[0].pack_id).toBe("pack-100");

		// 2. User changes pack selection in UI (mouse) to 2500 credits (pack-250)
		fireEvent.click(screen.getByText("2500 크레딧"));

		// 3. User clicks "다시 시도" (retry)
		fireEvent.click(screen.getByText("다시 시도"));

		await waitFor(() => {
			expect(postAttempt).toBe(2);
			expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
		});

		expect(orderBodies.length).toBe(2);
		const secondKey = orderBodies[1].idempotency_key;
		const secondPackId = orderBodies[1].pack_id;

		// Critical verification: Retry POST MUST retain original idempotency key AND original pack_id!
		expect(secondKey).toBe(firstKey);
		expect(secondPackId).toBe("pack-100");

		// 4. Simulate microtransaction authorization to proceed through finalize (#729 P2 지적 2)
		const authHandler = eventListeners.get("steam_microtxn_authorization");
		expect(authHandler).toBeDefined();
		await act(async () => {
			authHandler!({
				payload: {
					app_id: 5354630,
					order_id: "order-retry-123",
					authorized: true,
				},
			});
		});

		// 5. Success screen must show 1000 credits (+1000 크레딧) for original order, NOT +2500
		await waitFor(() => {
			expect(screen.getByText("크레딧 충전이 완료되었습니다!")).toBeDefined();
			expect(screen.getByText("+1000 크레딧")).toBeDefined();
			expect(screen.queryByText("+2500 크레딧")).toBeNull();
		});
	});

	it("new purchase generates a new idempotency key with newly selected pack (#729 지적 2)", async () => {
		const orderBodies: any[] = [];

		fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
				if (init?.body) {
					orderBodies.push(JSON.parse(String(init.body)));
				}
				return {
					ok: false,
					status: 409,
					json: async () => ({ detail: { error: "failed_attempt" } }),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		// 1. Initial selection: 1000 credits (pack-100)
		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(screen.getByText("다시 시도")).toBeDefined();
		});

		expect(orderBodies.length).toBe(1);
		expect(orderBodies[0].pack_id).toBe("pack-100");

		// 2. Select another pack (keyboard Enter on 2500 credits)
		fireEvent.keyDown(screen.getByText("2500 크레딧"), { key: "Enter" });

		// 3. Click the explicit footer "구매하기" button to start a brand-new purchase
		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(orderBodies.length).toBe(2);
		});

		// A new purchase attempt MUST generate a new idempotency key AND use the newly selected pack!
		expect(orderBodies[1].idempotency_key).not.toBe(orderBodies[0].idempotency_key);
		expect(orderBodies[1].pack_id).toBe("pack-250");
	});

	it("preserves original key and pack on retry after selecting another pack with keyboard (#729 P2 지적 4)", async () => {
		const orderBodies: any[] = [];

		fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
				if (init?.body) {
					orderBodies.push(JSON.parse(String(init.body)));
				}
				if (orderBodies.length === 1) {
					return {
						ok: false,
						status: 409,
						json: async () => ({ detail: { error: "failed_attempt" } }),
					};
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-retry-kbd",
						status: "INITIATED",
						flow: "client",
						steamurl: null,
						pack: defaultPacks[0],
					}),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		// 1. Initial selection: 1000 credits (pack-100)
		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(screen.getByText("다시 시도")).toBeDefined();
		});

		expect(orderBodies.length).toBe(1);
		const originalKey = orderBodies[0].idempotency_key;
		expect(originalKey).toBeTruthy();
		expect(orderBodies[0].pack_id).toBe("pack-100");

		// 2. User navigates with keyboard to select 2500 credits (pack-250)
		fireEvent.keyDown(screen.getByText("2500 크레딧"), { key: "Enter" });

		// 3. Instead of new purchase, user clicks "다시 시도" (retry)
		fireEvent.click(screen.getByText("다시 시도"));

		await waitFor(() => {
			expect(orderBodies.length).toBe(2);
			expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
		});

		// Retry POST MUST retain original idempotency key AND original pack_id (pack-100, NOT pack-250)
		expect(orderBodies[1].idempotency_key).toBe(originalKey);
		expect(orderBodies[1].pack_id).toBe("pack-100");
		expect(orderBodies[1].pack_id).not.toBe("pack-250");
	});

	it("order status CREATED limit transitions to delayed UI with retry check and close buttons (#729 P1 지적 8)", async () => {
		const orderBodies: any[] = [];
		let postCount = 0;

		fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
				postCount++;
				if (init?.body) {
					orderBodies.push(JSON.parse(String(init.body)));
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-delayed-1",
						status: "CREATED",
						flow: "client",
						steamurl: null,
						pack: defaultPacks[0],
					}),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				pollIntervalMs={5}
				maxPollAttempts={2}
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		// After maxPollAttempts reached, transitions to delayed UI
		await waitFor(() => {
			expect(screen.getByText("확인이 지연되고 있습니다.")).toBeDefined();
			expect(screen.getByText("다시 확인")).toBeDefined();
			expect(screen.getByText("닫기")).toBeDefined();
		});

		const initialKey = orderBodies[0].idempotency_key;

		// Click "다시 확인" to re-check with same key
		fireEvent.click(screen.getByText("다시 확인"));

		await waitFor(() => {
			expect(postCount).toBeGreaterThan(3);
		});

		// The re-check request MUST retain the same idempotency key
		const latestKey = orderBodies[orderBodies.length - 1].idempotency_key;
		expect(latestKey).toBe(initialKey);
	});

	it("immediate GRANTED status displays already granted notice and does not invoke success callbacks (#729 지적 3)", async () => {
		const onPurchaseSuccess = vi.fn();
		const onSuccess = vi.fn();
		let authReadyDispatched = false;
		const authReadyListener = () => {
			authReadyDispatched = true;
		};
		window.addEventListener("naia_auth_ready", authReadyListener);

		try {
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-already-granted",
							status: "GRANTED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
					onPurchaseSuccess={onPurchaseSuccess}
					onSuccess={onSuccess}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("1000 크레딧"));
			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				// Displays already granted notice instead of success message
				expect(screen.getByText("이미 반영된 주문입니다.")).toBeDefined();
			});

			// Must not call onPurchaseSuccess or onSuccess
			expect(onPurchaseSuccess).not.toHaveBeenCalled();
			expect(onSuccess).not.toHaveBeenCalled();

			// Must not display new recharge text or +N credits
			expect(screen.queryByText("크레딧 충전이 완료되었습니다!")).toBeNull();
			expect(screen.queryByText(/\+1000/)).toBeNull();

			// naia_auth_ready balance refresh event must be dispatched
			expect(authReadyDispatched).toBe(true);
		} finally {
			window.removeEventListener("naia_auth_ready", authReadyListener);
		}
	});

	it("failure and unknown statuses show error before flow branching (#729 P1 지적 6)", async () => {
		const statuses = ["INIT_FAILED", "FAILED", "MISMATCH", "REVERSED", "PAID", "UNKNOWN_STATUS"];

		for (const st of statuses) {
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-fail-test",
							status: st,
							flow: "client",
							steamurl: null,
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { unmount } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("1000 크레딧"));
			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(screen.getByText("Steam 결제가 취소되었습니다")).toBeDefined();
			});

			unmount();
			cleanup();
		}
	});

	it("web flow: opens valid Steam URL and manual finalize button completes purchase (#729 P2 지적 10)", async () => {
		let finalizeCalled = false;

		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-web-valid",
						status: "INITIATED",
						flow: "web",
						steamurl: "https://store.steampowered.com/checkout/order-web-valid",
						pack: defaultPacks[0],
					}),
				};
			}
			if (urlStr.includes("/finalize")) {
				finalizeCalled = true;
				return {
					ok: true,
					status: 200,
					json: async () => ({ status: "GRANTED", granted_now: true }),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		invokeMock.mockResolvedValue(undefined);

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(invokeMock).toHaveBeenCalledWith("steam_open_url", {
				url: "https://store.steampowered.com/checkout/order-web-valid",
			});
			expect(screen.getByText("결제를 완료했어요")).toBeDefined();
			expect(screen.getByText("Steam 결제 페이지 다시 열기")).toBeDefined();
		});

		// Click manual finalize button
		fireEvent.click(screen.getByText("결제를 완료했어요"));

		await waitFor(() => {
			expect(finalizeCalled).toBe(true);
			expect(screen.getByText("크레딧 충전이 완료되었습니다!")).toBeDefined();
		});
	});

	it("web flow: initial open succeeds and reopen failure displays error inside web_flow screen (#729 지적 5)", async () => {
		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-web-reopen-fail",
						status: "INITIATED",
						flow: "web",
						steamurl: "https://store.steampowered.com/checkout/order-web-reopen-fail",
						pack: defaultPacks[0],
					}),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		// 1st open succeeds during order initiation
		invokeMock.mockImplementation(async (cmd: string) => {
			if (cmd === "steam_open_url") return undefined;
			return undefined;
		});

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		// Enters web_flow screen successfully
		await waitFor(() => {
			expect(screen.getByText("Steam 결제 페이지 다시 열기")).toBeDefined();
			expect(screen.getByText("결제를 완료했어요")).toBeDefined();
		});

		const steamOpenCalls = invokeMock.mock.calls.filter((c) => c[0] === "steam_open_url");
		expect(steamOpenCalls.length).toBe(1);
		expect(screen.queryByRole("alert")).toBeNull();

		// 2nd open fails when clicking reopen button
		invokeMock.mockImplementation(async (cmd: string) => {
			if (cmd === "steam_open_url") {
				throw new Error("Failed to open browser: OS error");
			}
			return undefined;
		});

		fireEvent.click(screen.getByText("Steam 결제 페이지 다시 열기"));

		// Error message MUST be displayed inside web_flow screen while retaining web_flow buttons
		await waitFor(() => {
			expect(screen.getByRole("alert")).toBeDefined();
			expect(screen.getByText("Failed to open browser: OS error")).toBeDefined();
			expect(screen.getByText("Steam 결제 페이지 다시 열기")).toBeDefined();
			expect(screen.getByText("결제를 완료했어요")).toBeDefined();
		});
	});

	it("web flow: invalid or disallowed URL shows error and does not enter web flow (#729 P2 지적 10)", async () => {
		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-web-invalid",
						status: "INITIATED",
						flow: "web",
						steamurl: "https://phishing-site.example/checkout",
						pack: defaultPacks[0],
					}),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		// Must show error and must NOT enter web_flow instructions
		await waitFor(() => {
			expect(screen.getByText("Steam 결제 URL이 올바르지 않습니다.")).toBeDefined();
			expect(screen.queryByText("결제를 완료했어요")).toBeNull();
		});
	});

	it("duplicate finalize prevention (#729 P2 지적 11)", async () => {
		let finalizeCallCount = 0;
		const onPurchaseSuccess = vi.fn();

		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-dup-test",
						status: "INITIATED",
						flow: "client",
						steamurl: null,
						pack: defaultPacks[0],
					}),
				};
			}
			if (urlStr.includes("/finalize")) {
				finalizeCallCount++;
				// Simulate granted_now: false for already finalized order
				return {
					ok: true,
					status: 200,
					json: async () => ({ status: "GRANTED", granted_now: false }),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
				onPurchaseSuccess={onPurchaseSuccess}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
		});

		// Trigger manual finalize button on client authorizing screen (#729 P1 지적 9)
		fireEvent.click(screen.getByText("결제를 완료했어요"));

		await waitFor(() => {
			expect(finalizeCallCount).toBe(1);
			expect(screen.getByText("이미 반영된 주문입니다.")).toBeDefined();
			expect(screen.queryByText("크레딧 충전이 완료되었습니다!")).toBeNull();
			expect(screen.queryByText("+1000 크레딧")).toBeNull();
		});

		// granted_now: false must NOT call onPurchaseSuccess
		expect(onPurchaseSuccess).not.toHaveBeenCalled();

		// Trigger microtxn authorization event after order is already finalized -> guarded
		const handler = eventListeners.get("steam_microtxn_authorization");
		handler!({
			payload: {
				app_id: 5354630,
				order_id: "order-dup-test",
				authorized: true,
			},
		});

		// Finalize count must remain 1
		expect(finalizeCallCount).toBe(1);
	});

	it("steam_not_linked error provides navigation button to settings (#729 P2 지적 12)", async () => {
		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders")) {
				return {
					ok: false,
					status: 409,
					json: async () => ({ detail: { error: "steam_not_linked" } }),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		const onClose = vi.fn();

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={onClose}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(screen.getByText("Steam 계정 연결이 필요합니다.")).toBeDefined();
			expect(screen.getByText("설정으로 이동")).toBeDefined();
		});

		fireEvent.click(screen.getByText("설정으로 이동"));
		expect(onClose).toHaveBeenCalled();
		expect(useAppStore.getState().activeApp).toBe("settings");
		expect(useAppStore.getState().requestedSettingsTab).toBe("profile");
	});

	it("closes on cancel button click", async () => {
		const onClose = vi.fn();
		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				onClose={onClose}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("취소")).toBeDefined();
		});

		fireEvent.click(screen.getByText("취소"));
		expect(onClose).toHaveBeenCalled();
	});

	describe("order execution cancellation and synchronous guard (#729 지적 3)", () => {
		it("rapid double click during listener registration does not overwrite preserved attempt and retry preserves key and pack (#729 P1 지적 1)", async () => {
			let resolveListener!: (val: any) => void;
			const listenerPromise = new Promise((resolve) => {
				resolveListener = resolve;
			});
			const listenerSpy = vi
				.spyOn(steamBilling, "createSteamAuthListener")
				.mockReturnValueOnce(listenerPromise as any);

			const orderBodies: any[] = [];
			let postCount = 0;

			fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
					postCount++;
					if (init?.body) {
						orderBodies.push(JSON.parse(String(init.body)));
					}
					if (postCount === 1) {
						// First POST fails/lost (returns error)
						return {
							ok: false,
							status: 500,
							json: async () => ({ detail: { error: "order_init_failed" } }),
						};
					}
					// Retry POST succeeds
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-retry-1",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			try {
				render(
					<SteamPurchaseModal
						isOpen={true}
						gatewayUrl="https://api.naia.test"
						naiaKey="test-key"
						onClose={vi.fn()}
					/>,
				);

				await waitFor(() => {
					expect(screen.getByText("1000 크레딧")).toBeDefined();
				});

				const buyBtn = screen.getByText("구매하기");
				// First click starts purchase attempt and enters delayed listener registration
				fireEvent.click(buyBtn);

				// Second click arrives while listener registration is still pending
				fireEvent.click(buyBtn);

				// Now resolve listener registration for the first attempt
				await act(async () => {
					resolveListener({ unlisten: vi.fn() });
				});

				// First POST request was sent and failed with 500
				await waitFor(() => {
					expect(orderBodies.length).toBe(1);
					expect(screen.getByText("다시 시도")).toBeDefined();
				});

				const firstKey = orderBodies[0].idempotency_key;
				const firstPackId = orderBodies[0].pack_id;
				expect(firstKey).toBeTruthy();
				expect(firstPackId).toBe("pack-100");

				// Click retry
				fireEvent.click(screen.getByText("다시 시도"));

				await waitFor(() => {
					expect(orderBodies.length).toBe(2);
					expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
				});

				// Retry POST must have the exact same idempotency key and pack_id as first POST
				expect(orderBodies[1].idempotency_key).toBe(firstKey);
				expect(orderBodies[1].pack_id).toBe(firstPackId);
			} finally {
				listenerSpy.mockRestore();
			}
		});

		it.each(["handleClose", "isOpenChange", "unmount"] as const)(
			"aborts order before POST when closed via %s during secure key retrieval",
			async (closeMode) => {
				let resolveKey!: (val: string) => void;
				const keyPromise = new Promise<string>((resolve) => {
					resolveKey = resolve;
				});
				vi.mocked(getNaiaKeySecure).mockReturnValueOnce(keyPromise as any);

				let postCalled = false;
				fetchMock.mockImplementation(async (url: string | URL | Request) => {
					const urlStr = typeof url === "string" ? url : url.toString();
					if (urlStr.includes("/v1/billing/steam/packs")) {
						return { ok: true, status: 200, json: async () => defaultPacks };
					}
					if (urlStr.includes("/v1/billing/steam/orders")) {
						postCalled = true;
						return { ok: true, status: 200, json: async () => ({}) };
					}
					return { ok: false, status: 404, json: async () => ({}) };
				});

				const onClose = vi.fn();
				const { rerender, unmount } = render(
					<SteamPurchaseModal
						isOpen={true}
						gatewayUrl="https://api.naia.test"
						// naiaKey omitted so it calls getNaiaKeySecure
						onClose={onClose}
					/>,
				);

				await waitFor(() => {
					expect(screen.getByText("1000 크레딧")).toBeDefined();
				});

				fireEvent.click(screen.getByText("구매하기"));

				// Modal closed while awaiting secure key
				if (closeMode === "handleClose") {
					fireEvent.click(screen.getByText("취소"));
				} else if (closeMode === "isOpenChange") {
					rerender(
						<SteamPurchaseModal
							isOpen={false}
							gatewayUrl="https://api.naia.test"
							onClose={onClose}
						/>,
					);
				} else if (closeMode === "unmount") {
					unmount();
				}

				// Late resolution of secure key
				resolveKey("late-key");
				await new Promise((r) => setTimeout(r, 20));

				// POST must not have been called
				expect(postCalled).toBe(false);
			},
		);

		it.each(["handleClose", "isOpenChange", "unmount"] as const)(
			"aborts order before POST and unlistens late listener when closed via %s during listener registration",
			async (closeMode) => {
				const unlistenMock = vi.fn();
				let resolveListener!: (l: any) => void;
				const listenerPromise = new Promise<any>((resolve) => {
					resolveListener = resolve;
				});

				const spy = vi.spyOn(steamBilling, "createSteamAuthListener").mockReturnValueOnce(listenerPromise as any);

				let postCalled = false;
				fetchMock.mockImplementation(async (url: string | URL | Request) => {
					const urlStr = typeof url === "string" ? url : url.toString();
					if (urlStr.includes("/v1/billing/steam/packs")) {
						return { ok: true, status: 200, json: async () => defaultPacks };
					}
					if (urlStr.includes("/v1/billing/steam/orders")) {
						postCalled = true;
						return { ok: true, status: 200, json: async () => ({}) };
					}
					return { ok: false, status: 404, json: async () => ({}) };
				});

				const onClose = vi.fn();
				const { rerender, unmount } = render(
					<SteamPurchaseModal
						isOpen={true}
						gatewayUrl="https://api.naia.test"
						naiaKey="test-key"
						onClose={onClose}
					/>,
				);

				await waitFor(() => {
					expect(screen.getByText("1000 크레딧")).toBeDefined();
				});

				fireEvent.click(screen.getByText("구매하기"));

				// Modal closed while awaiting listener registration
				if (closeMode === "handleClose") {
					fireEvent.click(screen.getByText("취소"));
				} else if (closeMode === "isOpenChange") {
					rerender(
						<SteamPurchaseModal
							isOpen={false}
							gatewayUrl="https://api.naia.test"
							naiaKey="test-key"
							onClose={onClose}
						/>,
					);
				} else if (closeMode === "unmount") {
					unmount();
				}

				// Late resolution of listener registration
				resolveListener({
					waitForOrder: vi.fn(),
					unlisten: unlistenMock,
				});
				await new Promise((r) => setTimeout(r, 20));

				// Late listener must be unlistened immediately and POST must never start
				expect(unlistenMock).toHaveBeenCalledTimes(1);
				expect(postCalled).toBe(false);

				spy.mockRestore();
			},
		);
	});

	it("displays already processed notice without credit addition when granted_now is false (#729 지적 6)", async () => {
		const onPurchaseSuccess = vi.fn();
		const onSuccess = vi.fn();
		let authReadyDispatched = false;
		const authReadyListener = () => {
			authReadyDispatched = true;
		};
		window.addEventListener("naia_auth_ready", authReadyListener);

		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/v1/billing/steam/packs")) {
				return { ok: true, status: 200, json: async () => defaultPacks };
			}
			if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "order-already-granted",
						status: "INITIATED",
						flow: "client",
						steamurl: null,
						pack: defaultPacks[0],
					}),
				};
			}
			if (urlStr.includes("/finalize")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ status: "GRANTED", granted_now: false }),
				};
			}
			return { ok: false, status: 404, json: async () => ({}) };
		});

		try {
			render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
					onPurchaseSuccess={onPurchaseSuccess}
					onSuccess={onSuccess}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("1000 크레딧"));
			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
			});

			fireEvent.click(screen.getByText("결제를 완료했어요"));

			await waitFor(() => {
				expect(screen.getByText("이미 반영된 주문입니다.")).toBeDefined();
			});

			// Must NOT show new credit addition
			expect(screen.queryByText("크레딧 충전이 완료되었습니다!")).toBeNull();
			expect(screen.queryByText("+1000 크레딧")).toBeNull();

			// Callbacks for new purchase must not be invoked
			expect(onPurchaseSuccess).not.toHaveBeenCalled();
			expect(onSuccess).not.toHaveBeenCalled();

			// Auth ready event must still be dispatched to refresh balance
			expect(authReadyDispatched).toBe(true);
		} finally {
			window.removeEventListener("naia_auth_ready", authReadyListener);
		}
	});

	it("modal: shows delayed screen at 10s deadline when initial response hangs, cancels request, and preserves attempt (#729 지적 7)", async () => {
		vi.useFakeTimers();
		try {
			let orderRequestSignal: AbortSignal | null | undefined;
			let initialKey: string | undefined;
			let initialPackId: string | undefined;

			fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					orderRequestSignal = init?.signal;
					const body = JSON.parse(init?.body as string);
					initialKey = body.idempotency_key;
					initialPackId = body.pack_id;
					return new Promise((_resolve, reject) => {
						if (init?.signal?.aborted) {
							return reject(new DOMException("The operation was aborted.", "AbortError"));
						}
						init?.signal?.addEventListener("abort", () => {
							reject(new DOMException("The operation was aborted.", "AbortError"));
						});
					});
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			// Flush initial pack fetch
			await vi.advanceTimersByTimeAsync(0);

			expect(screen.getByText("1000 크레딧")).toBeDefined();
			fireEvent.click(screen.getByText("1000 크레딧"));
			fireEvent.click(screen.getByText("구매하기"));

			// Flush microtasks for executeOrder start
			await vi.advanceTimersByTimeAsync(0);

			expect(initialPackId).toBe("pack-100");
			expect(initialKey).toBeDefined();
			expect(orderRequestSignal?.aborted).toBe(false);

			// Fast forward to 10s deadline
			await vi.advanceTimersByTimeAsync(10000);

			// Must show delayed notice
			expect(screen.getByText("확인이 지연되고 있습니다.")).toBeDefined();
			// Ongoing request must be aborted
			expect(orderRequestSignal?.aborted).toBe(true);

			// Retry check must preserve key and packId
			let retryKey: string | undefined;
			let retryPackId: string | undefined;
			fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/orders")) {
					const body = JSON.parse(init?.body as string);
					retryKey = body.idempotency_key;
					retryPackId = body.pack_id;
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-retried",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			fireEvent.click(screen.getByText("다시 확인"));
			await vi.advanceTimersByTimeAsync(0);

			expect(retryKey).toBe(initialKey);
			expect(retryPackId).toBe("pack-100");
		} finally {
			vi.useRealTimers();
		}
	});

	it("modal: shows delayed screen at 10s deadline when re-request after CREATED hangs, cancels request, and preserves attempt (#729 지적 7)", async () => {
		vi.useFakeTimers();
		try {
			let orderCallCount = 0;
			let reRequestSignal: AbortSignal | null | undefined;
			let initialKey: string | undefined;
			let initialPackId: string | undefined;

			fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					orderCallCount++;
					const body = JSON.parse(init?.body as string);
					initialKey = body.idempotency_key;
					initialPackId = body.pack_id;

					if (orderCallCount === 1) {
						return {
							ok: true,
							status: 200,
							json: async () => ({
								order_id: "order-poll-1",
								status: "CREATED",
								flow: "client",
								steamurl: null,
								pack: defaultPacks[0],
							}),
						};
					}
					// Second request hangs
					reRequestSignal = init?.signal;
					return new Promise((_resolve, reject) => {
						if (init?.signal?.aborted) {
							return reject(new DOMException("The operation was aborted.", "AbortError"));
						}
						init?.signal?.addEventListener("abort", () => {
							reject(new DOMException("The operation was aborted.", "AbortError"));
						});
					});
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await vi.advanceTimersByTimeAsync(0);
			fireEvent.click(screen.getByText("1000 크레딧"));
			fireEvent.click(screen.getByText("구매하기"));

			// Initial request completes with CREATED, sleep for 1s starts
			await vi.advanceTimersByTimeAsync(1000);
			expect(orderCallCount).toBe(2);
			expect(reRequestSignal?.aborted).toBe(false);

			// Advance remaining 9s to hit 10s deadline
			await vi.advanceTimersByTimeAsync(9000);

			expect(screen.getByText("확인이 지연되고 있습니다.")).toBeDefined();
			expect(reRequestSignal?.aborted).toBe(true);

			// Retry check retains original key and pack
			let retryKey: string | undefined;
			let retryPackId: string | undefined;
			fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/orders")) {
					const body = JSON.parse(init?.body as string);
					retryKey = body.idempotency_key;
					retryPackId = body.pack_id;
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-retried-2",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			fireEvent.click(screen.getByText("다시 확인"));
			await vi.advanceTimersByTimeAsync(0);

			expect(retryKey).toBe(initialKey);
			expect(retryPackId).toBe(initialPackId);
		} finally {
			vi.useRealTimers();
		}
	});

	it("modalCount in useAppStore increments by exactly 1 when opened, and returns to baseline when closed (#729 지적 9)", async () => {
		const initialCount = useAppStore.getState().modalCount;

		const { rerender, unmount } = render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);

		// Must increment by exactly 1
		expect(useAppStore.getState().modalCount).toBe(initialCount + 1);

		// When isOpen transitions to false, modalCount must return to baseline
		rerender(
			<SteamPurchaseModal
				isOpen={false}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);
		expect(useAppStore.getState().modalCount).toBe(initialCount);

		// When reopened, increments by 1 again
		rerender(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={vi.fn()}
			/>,
		);
		expect(useAppStore.getState().modalCount).toBe(initialCount + 1);

		// Unmount cleanly restores baseline
		unmount();
		expect(useAppStore.getState().modalCount).toBe(initialCount);
	});

	describe("Late async resolution and attempt token ownership (#729 fix4)", () => {
		it("guard release path 1 (217행): late resolution of secure key in cancelled attempt A does not release execution guard of running attempt B", async () => {
			let resolveKeyA!: (k: string) => void;
			const keyPromiseA = new Promise<string>((res) => {
				resolveKeyA = res;
			});
			let resolveKeyB!: (k: string) => void;
			const keyPromiseB = new Promise<string>((res) => {
				resolveKeyB = res;
			});

			let keyCallCount = 0;
			vi.mocked(getNaiaKeySecure).mockImplementation(async () => {
				keyCallCount++;
				if (keyCallCount === 1) return keyPromiseA;
				if (keyCallCount === 2) return keyPromiseB;
				return "key-unexpected-C";
			});

			let orderPostCount = 0;
			const orderPostPacks: string[] = [];
			fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					orderPostCount++;
					const body = JSON.parse(String(init?.body || "{}"));
					orderPostPacks.push(body.pack_id);
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: `order-${orderPostCount}`,
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks.find((p) => p.id === body.pack_id) || defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			// Attempt A begins with pack-100 (first pack by default)
			fireEvent.click(screen.getByText("구매하기"));
			expect(keyCallCount).toBe(1);

			// Cancel attempt A by closing and reopening the modal
			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("2500 크레딧")).toBeDefined();
			});

			// Attempt B begins with pack-250
			fireEvent.click(screen.getByText("2500 크레딧"));
			fireEvent.click(screen.getByText("구매하기"));
			expect(keyCallCount).toBe(2);

			// Now attempt A finishes its key retrieval late
			resolveKeyA("key-A");
			await new Promise((r) => setTimeout(r, 20));

			// User clicks purchase again (attempt C) while B is still running
			fireEvent.click(screen.getByText("구매하기"));
			await new Promise((r) => setTimeout(r, 20));

			// Attempt C must have been rejected by B's execution guard:
			// No 3rd key retrieval call
			expect(keyCallCount).toBe(2);
			// No order POST yet (B is still awaiting key)
			expect(orderPostCount).toBe(0);

			// Now complete B's key retrieval
			resolveKeyB("key-B");
			await waitFor(() => {
				expect(orderPostCount).toBe(1);
			});
			// B's pack (pack-250) was ordered
			expect(orderPostPacks).toEqual(["pack-250"]);
		});

		it("guard release path 2 (245행): late resolution of listener registration in cancelled attempt A does not release execution guard of running attempt B", async () => {
			let resolveListenA!: (fn: () => void) => void;
			const listenPromiseA = new Promise<() => void>((res) => {
				resolveListenA = res;
			});

			const unlistenA = vi.fn();
			let listenCallCount = 0;
			vi.mocked(listen).mockImplementation(async (event: string, handler: any) => {
				if (event === "steam_microtxn_authorization") {
					listenCallCount++;
					if (listenCallCount === 1) {
						await listenPromiseA;
						return unlistenA;
					}
				}
				eventListeners.set(event, handler);
				return () => {
					eventListeners.delete(event);
				};
			});

			let resolveKeyB!: (k: string) => void;
			const keyPromiseB = new Promise<string>((res) => {
				resolveKeyB = res;
			});

			let keyCallCount = 0;
			vi.mocked(getNaiaKeySecure).mockImplementation(async () => {
				keyCallCount++;
				if (keyCallCount === 1) return keyPromiseB;
				return "key-unexpected-C";
			});

			let orderPostCount = 0;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					orderPostCount++;
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-B",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[1],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			// In attempt A, naiaKey prop is provided so key lookup is skipped and A proceeds to listener registration
			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="key-A"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			// Attempt A begins
			fireEvent.click(screen.getByText("구매하기"));
			expect(listenCallCount).toBe(1);

			// Close and reopen modal without naiaKey prop for B, so B awaits key lookup
			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("2500 크레딧")).toBeDefined();
			});

			// Attempt B begins with pack-250 (awaits key lookup, flowState is still idle!)
			fireEvent.click(screen.getByText("2500 크레딧"));
			fireEvent.click(screen.getByText("구매하기"));
			expect(keyCallCount).toBe(1);

			// Now attempt A finishes its listener registration late
			resolveListenA(() => {});
			await new Promise((r) => setTimeout(r, 20));

			// Attempt A unlistens its own listener immediately
			expect(unlistenA).toHaveBeenCalledTimes(1);

			// User clicks purchase (C) while B is still running
			fireEvent.click(screen.getByText("구매하기"));
			await new Promise((r) => setTimeout(r, 20));

			// C must be rejected: no new key lookup (keyCallCount remains 1)
			expect(keyCallCount).toBe(1);
			expect(orderPostCount).toBe(0);

			// Complete B's key lookup
			resolveKeyB("key-B");

			await waitFor(() => {
				expect(orderPostCount).toBe(1);
			});

			await waitFor(() => {
				expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
			});
		});

		it("guard release path 3 (267행): late resolve of order creation in cancelled attempt A does not release execution guard of running attempt B", async () => {
			let resolveOrderA!: (val: any) => void;
			const orderPromiseA = new Promise<any>((res) => {
				resolveOrderA = res;
			});
			let resolveListenB!: (fn: () => void) => void;
			const listenPromiseB = new Promise<() => void>((res) => {
				resolveListenB = res;
			});

			let listenCallCount = 0;
			vi.mocked(listen).mockImplementation(async (event: any, handler: any) => {
				if (event === "steam_microtxn_authorization") {
					listenCallCount++;
					if (listenCallCount === 2) {
						await listenPromiseB;
					}
				}
				eventListeners.set(event, handler);
				return () => {
					eventListeners.delete(event);
				};
			});

			let orderPostCount = 0;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					orderPostCount++;
					if (orderPostCount === 1) {
						return { ok: true, status: 200, json: async () => orderPromiseA };
					}
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-B",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[1],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			// Attempt A begins
			fireEvent.click(screen.getByText("구매하기"));
			await waitFor(() => {
				expect(orderPostCount).toBe(1);
			});

			// Close and reopen modal
			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("2500 크레딧")).toBeDefined();
			});

			// Attempt B begins with pack-250
			fireEvent.click(screen.getByText("2500 크레딧"));
			fireEvent.click(screen.getByText("구매하기"));
			expect(listenCallCount).toBe(2);

			// Attempt A resolves late with order-A
			resolveOrderA({
				order_id: "order-A",
				status: "INITIATED",
				flow: "client",
				steamurl: null,
				pack: defaultPacks[0],
			});
			await new Promise((r) => setTimeout(r, 20));

			// User clicks purchase (C) while B is still running
			fireEvent.click(screen.getByText("구매하기"));
			await new Promise((r) => setTimeout(r, 20));

			// C is rejected: orderPostCount remains 1
			expect(orderPostCount).toBe(1);

			// Resolve B's listener
			resolveListenB(() => {});

			await waitFor(() => {
				expect(orderPostCount).toBe(2);
			});

			await waitFor(() => {
				expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
			});
		});

		it("guard release path 4 (331행): late reject of order creation in cancelled attempt A does not release execution guard of running attempt B", async () => {
			let rejectOrderA!: (err: any) => void;
			const orderPromiseA = new Promise<any>((_, rej) => {
				rejectOrderA = rej;
			});
			let resolveListenB!: (fn: () => void) => void;
			const listenPromiseB = new Promise<() => void>((res) => {
				resolveListenB = res;
			});

			let listenCallCount = 0;
			vi.mocked(listen).mockImplementation(async (event: any, handler: any) => {
				if (event === "steam_microtxn_authorization") {
					listenCallCount++;
					if (listenCallCount === 2) {
						await listenPromiseB;
					}
				}
				eventListeners.set(event, handler);
				return () => {
					eventListeners.delete(event);
				};
			});

			let orderPostCount = 0;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					orderPostCount++;
					if (orderPostCount === 1) {
						return {
							ok: false,
							status: 500,
							json: async () => {
								await orderPromiseA;
								return { detail: { error: "server_error" } };
							},
						};
					}
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-B",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[1],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			// Attempt A begins
			fireEvent.click(screen.getByText("구매하기"));
			await waitFor(() => {
				expect(orderPostCount).toBe(1);
			});

			// Close and reopen modal
			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("2500 크레딧")).toBeDefined();
			});

			// Attempt B begins
			fireEvent.click(screen.getByText("2500 크레딧"));
			fireEvent.click(screen.getByText("구매하기"));
			expect(listenCallCount).toBe(2);

			// Attempt A rejects late
			rejectOrderA(new Error("Network failed"));
			await new Promise((r) => setTimeout(r, 20));

			// User clicks purchase (C) while B is still running
			fireEvent.click(screen.getByText("구매하기"));
			await new Promise((r) => setTimeout(r, 20));

			// C is rejected: orderPostCount remains 1
			expect(orderPostCount).toBe(1);

			// Resolve B's listener
			resolveListenB(() => {});

			await waitFor(() => {
				expect(orderPostCount).toBe(2);
			});

			await waitFor(() => {
				expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
			});
		});

		it("late URL open resolve: modal closed and reopened while openSteamUrl is pending does not transition to web_flow on late resolve", async () => {
			let resolveUrlA!: () => void;
			const urlPromiseA = new Promise<void>((res) => {
				resolveUrlA = res;
			});

			invokeMock.mockImplementation(async (cmd: string) => {
				if (cmd === "steam_open_url") {
					await urlPromiseA;
					return;
				}
			});

			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-web-1",
							status: "INITIATED",
							flow: "web",
							steamurl: "https://store.steampowered.com/checkout/approvetxn/12345",
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			// Start purchase (attempt A)
			fireEvent.click(screen.getByText("구매하기"));

			// Wait until steam_open_url is invoked
			await waitFor(() => {
				expect(invokeMock).toHaveBeenCalledWith("steam_open_url", {
					url: "https://store.steampowered.com/checkout/approvetxn/12345",
				});
			});

			// Close and reopen modal while steam_open_url is pending
			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			// Now resolve URL open late
			resolveUrlA();
			await new Promise((r) => setTimeout(r, 20));

			// Modal must remain on initial screen (idle), NOT transition to web_flow
			expect(screen.getByText("구매하기")).toBeDefined();
			expect(screen.queryByText("Steam 결제 페이지가 열렸습니다. 결제를 마친 후 아래 버튼을 눌러주세요.")).toBeNull();
		});

		it("late URL open reject: modal closed and reopened while openSteamUrl is pending does not transition to error on late reject", async () => {
			let rejectUrlA!: (err: any) => void;
			const urlPromiseA = new Promise<void>((_, rej) => {
				rejectUrlA = rej;
			});

			invokeMock.mockImplementation(async (cmd: string) => {
				if (cmd === "steam_open_url") {
					await urlPromiseA;
					return;
				}
			});

			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-web-2",
							status: "INITIATED",
							flow: "web",
							steamurl: "https://store.steampowered.com/checkout/approvetxn/12345",
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(invokeMock).toHaveBeenCalledWith("steam_open_url", {
					url: "https://store.steampowered.com/checkout/approvetxn/12345",
				});
			});

			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			// Now reject URL open late
			rejectUrlA(new Error("Failed to open browser"));
			await new Promise((r) => setTimeout(r, 20));

			// Modal must remain on initial screen, no error displayed
			expect(screen.getByText("구매하기")).toBeDefined();
			expect(screen.queryByText("Failed to open browser")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("finalize late success: modal rerendered false->true during finalize does not update state, call success callbacks, or dispatch events", async () => {
			let resolveFinalizeA!: (val: any) => void;
			const finalizePromiseA = new Promise<any>((res) => {
				resolveFinalizeA = res;
			});

			let finalizeCalled = false;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-finalize-1",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[0],
						}),
					};
				}
				if (urlStr.includes("/finalize")) {
					finalizeCalled = true;
					return {
						ok: true,
						status: 200,
						json: async () => finalizePromiseA,
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const onPurchaseSuccess = vi.fn();
			const onSuccess = vi.fn();
			let authReadyDispatched = false;
			const authReadyHandler = () => {
				authReadyDispatched = true;
			};
			window.addEventListener("naia_auth_ready", authReadyHandler);

			try {
				const { rerender } = render(
					<SteamPurchaseModal
						isOpen={true}
						gatewayUrl="https://api.naia.test"
						naiaKey="test-key"
						onClose={vi.fn()}
						onPurchaseSuccess={onPurchaseSuccess}
						onSuccess={onSuccess}
					/>,
				);

				await waitFor(() => {
					expect(screen.getByText("1000 크레딧")).toBeDefined();
				});

				fireEvent.click(screen.getByText("구매하기"));

				await waitFor(() => {
					expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
				});

				// Dispatch microtransaction authorization event to trigger handleFinalize
				const authHandler = eventListeners.get("steam_microtxn_authorization");
				expect(authHandler).toBeDefined();
				act(() => {
					authHandler!({
						payload: { app_id: 480, order_id: "order-finalize-1", authorized: true },
					});
				});

				await waitFor(() => {
					expect(screen.getByText("결제 확인 중…")).toBeDefined();
					expect(finalizeCalled).toBe(true);
				});

				// Rerender isOpen false then true as required for finalize testing
				rerender(
					<SteamPurchaseModal
						isOpen={false}
						gatewayUrl="https://api.naia.test"
						naiaKey="test-key"
						onClose={vi.fn()}
						onPurchaseSuccess={onPurchaseSuccess}
						onSuccess={onSuccess}
					/>,
				);
				rerender(
					<SteamPurchaseModal
						isOpen={true}
						gatewayUrl="https://api.naia.test"
						naiaKey="test-key"
						onClose={vi.fn()}
						onPurchaseSuccess={onPurchaseSuccess}
						onSuccess={onSuccess}
					/>,
				);

				await waitFor(() => {
					expect(screen.getByText("1000 크레딧")).toBeDefined();
				});

				// Late resolve of finalize
				resolveFinalizeA({ status: "GRANTED", granted_now: true });
				await new Promise((r) => setTimeout(r, 20));

				// Verifications:
				// 1. New modal state remains idle (not success)
				expect(screen.getByText("구매하기")).toBeDefined();
				expect(screen.queryByText("크레딧 충전이 완료되었습니다!")).toBeNull();
				// 2. No callbacks called
				expect(onPurchaseSuccess).not.toHaveBeenCalled();
				expect(onSuccess).not.toHaveBeenCalled();
				// 3. No naia_auth_ready dispatched
				expect(authReadyDispatched).toBe(false);
			} finally {
				window.removeEventListener("naia_auth_ready", authReadyHandler);
			}
		});

		it("finalize late failure: modal rerendered false->true during finalize does not update state to error on late rejection", async () => {
			let rejectFinalizeA!: (err: any) => void;
			const finalizePromiseA = new Promise<any>((_, rej) => {
				rejectFinalizeA = rej;
			});

			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-finalize-2",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[0],
						}),
					};
				}
				if (urlStr.includes("/finalize")) {
					return {
						ok: false,
						status: 409,
						json: async () => {
							await finalizePromiseA;
							return { detail: { error: "steam_failed" } };
						},
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
			});

			const authHandler = eventListeners.get("steam_microtxn_authorization");
			act(() => {
				authHandler!({
					payload: { app_id: 480, order_id: "order-finalize-2", authorized: true },
				});
			});

			await waitFor(() => {
				expect(screen.getByText("결제 확인 중…")).toBeDefined();
			});

			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			// Late rejection of finalize
			rejectFinalizeA(new Error("steam_failed"));
			await new Promise((r) => setTimeout(r, 20));

			// Modal must remain idle, not error
			expect(screen.getByText("구매하기")).toBeDefined();
			expect(screen.queryByText("Steam 결제가 취소되었습니다")).toBeNull();
		});

		it("authorizing completion button key retrieval late success and failure: does not trigger handleFinalize after modal reopen", async () => {
			let resolveKeyBtn!: (k: string) => void;
			const keyPromiseSuccess = new Promise<string>((res) => {
				resolveKeyBtn = res;
			});

			let keyCallCount = 0;
			vi.mocked(getNaiaKeySecure).mockImplementation(async () => {
				keyCallCount++;
				if (keyCallCount === 1) return "key-initial";
				return keyPromiseSuccess;
			});

			let finalizeCalled = false;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-auth-btn-1",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[0],
						}),
					};
				}
				if (urlStr.includes("/finalize")) {
					finalizeCalled = true;
					return { ok: true, status: 200, json: async () => ({ status: "GRANTED", granted_now: true }) };
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(screen.getByText("결제를 완료했어요")).toBeDefined();
			});

			fireEvent.click(screen.getByText("결제를 완료했어요"));
			expect(keyCallCount).toBe(2);

			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			resolveKeyBtn("key-btn-delayed");
			await new Promise((r) => setTimeout(r, 20));

			expect(finalizeCalled).toBe(false);
			expect(screen.getByText("구매하기")).toBeDefined();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("authorizing completion button key retrieval late failure: does not show error on reopened modal", async () => {
			let rejectKeyBtn!: (err: any) => void;
			const keyPromiseFail = new Promise<string>((_, rej) => {
				rejectKeyBtn = rej;
			});

			let keyCallCount = 0;
			vi.mocked(getNaiaKeySecure).mockImplementation(async () => {
				keyCallCount++;
				if (keyCallCount === 1) return "key-initial";
				return keyPromiseFail;
			});

			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-auth-btn-2",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(screen.getByText("결제를 완료했어요")).toBeDefined();
			});

			fireEvent.click(screen.getByText("결제를 완료했어요"));
			expect(keyCallCount).toBe(2);

			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			rejectKeyBtn(new Error("key lookup error"));
			await new Promise((r) => setTimeout(r, 20));

			expect(screen.getByText("구매하기")).toBeDefined();
			expect(screen.queryByText("key lookup error")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("web_flow completion button key retrieval late success: does not trigger handleFinalize or error on reopened modal", async () => {
			let resolveKeyBtn!: (k: string) => void;
			const keyPromise = new Promise<string>((res) => {
				resolveKeyBtn = res;
			});

			let keyCallCount = 0;
			vi.mocked(getNaiaKeySecure).mockImplementation(async () => {
				keyCallCount++;
				if (keyCallCount === 1) return "key-initial";
				return keyPromise;
			});

			invokeMock.mockResolvedValue(undefined);

			let finalizeCalled = false;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-web-btn-1",
							status: "INITIATED",
							flow: "web",
							steamurl: "https://store.steampowered.com/checkout/approvetxn/12345",
							pack: defaultPacks[0],
						}),
					};
				}
				if (urlStr.includes("/finalize")) {
					finalizeCalled = true;
					return { ok: true, status: 200, json: async () => ({ status: "GRANTED", granted_now: true }) };
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(screen.getByText("Steam 결제 페이지가 열렸습니다. 결제를 마친 후 아래 버튼을 눌러주세요.")).toBeDefined();
			});

			fireEvent.click(screen.getByText("결제를 완료했어요"));
			expect(keyCallCount).toBe(2);

			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			resolveKeyBtn("key-web-delayed");
			await new Promise((r) => setTimeout(r, 20));

			expect(finalizeCalled).toBe(false);
			expect(screen.getByText("구매하기")).toBeDefined();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("web_flow completion button key retrieval late failure: does not trigger handleFinalize or alter reopened modal", async () => {
			let rejectKeyBtn!: (err: any) => void;
			const keyPromiseFail = new Promise<string>((_, rej) => {
				rejectKeyBtn = rej;
			});

			let keyCallCount = 0;
			vi.mocked(getNaiaKeySecure).mockImplementation(async () => {
				keyCallCount++;
				if (keyCallCount === 1) return "key-initial";
				return keyPromiseFail;
			});

			invokeMock.mockResolvedValue(undefined);

			let finalizeCalled = false;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders") && !urlStr.includes("/finalize")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-web-btn-fail",
							status: "INITIATED",
							flow: "web",
							steamurl: "https://store.steampowered.com/checkout/approvetxn/12345",
							pack: defaultPacks[0],
						}),
					};
				}
				if (urlStr.includes("/finalize")) {
					finalizeCalled = true;
					return { ok: true, status: 200, json: async () => ({ status: "GRANTED", granted_now: true }) };
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(screen.getByText("Steam 결제 페이지가 열렸습니다. 결제를 마친 후 아래 버튼을 눌러주세요.")).toBeDefined();
			});

			fireEvent.click(screen.getByText("결제를 완료했어요"));
			expect(keyCallCount).toBe(2);

			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			rejectKeyBtn(new Error("key lookup error"));
			await new Promise((r) => setTimeout(r, 20));

			expect(finalizeCalled).toBe(false);
			expect(screen.getByText("구매하기")).toBeDefined();
			expect(screen.queryByText("key lookup error")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("reopenWebButton late success and failure: does not alter reopened modal state", async () => {
			let resolveReopen!: () => void;
			const reopenPromise = new Promise<void>((res) => {
				resolveReopen = res;
			});

			let reopenCount = 0;
			invokeMock.mockImplementation(async (cmd: string) => {
				if (cmd === "steam_open_url") {
					reopenCount++;
					if (reopenCount > 1) {
						await reopenPromise;
					}
					return;
				}
			});

			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-reopen-1",
							status: "INITIATED",
							flow: "web",
							steamurl: "https://store.steampowered.com/checkout/approvetxn/12345",
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(screen.getByText("Steam 결제 페이지 다시 열기")).toBeDefined();
			});

			// User clicks "Steam 결제 페이지 다시 열기"
			fireEvent.click(screen.getByText("Steam 결제 페이지 다시 열기"));
			expect(reopenCount).toBe(2);

			// Reopen modal while reopen is pending
			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			resolveReopen();
			await new Promise((r) => setTimeout(r, 20));

			expect(screen.getByText("구매하기")).toBeDefined();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("reopenWebButton late failure: does not show error on reopened modal", async () => {
			let rejectReopen!: (err: any) => void;
			const reopenPromise = new Promise<void>((_, rej) => {
				rejectReopen = rej;
			});

			let reopenCount = 0;
			invokeMock.mockImplementation(async (cmd: string) => {
				if (cmd === "steam_open_url") {
					reopenCount++;
					if (reopenCount > 1) {
						await reopenPromise;
					}
					return;
				}
			});

			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					return { ok: true, status: 200, json: async () => defaultPacks };
				}
				if (urlStr.includes("/v1/billing/steam/orders")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-reopen-2",
							status: "INITIATED",
							flow: "web",
							steamurl: "https://store.steampowered.com/checkout/approvetxn/12345",
							pack: defaultPacks[0],
						}),
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			fireEvent.click(screen.getByText("구매하기"));

			await waitFor(() => {
				expect(screen.getByText("Steam 결제 페이지 다시 열기")).toBeDefined();
			});

			fireEvent.click(screen.getByText("Steam 결제 페이지 다시 열기"));
			expect(reopenCount).toBe(2);

			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					naiaKey="test-key"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("1000 크레딧")).toBeDefined();
			});

			rejectReopen(new Error("reopen failed"));
			await new Promise((r) => setTimeout(r, 20));

			expect(screen.getByText("구매하기")).toBeDefined();
			expect(screen.queryByText("reopen failed")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("pack fetch late success: older generation fetch does not overwrite newer modal packs", async () => {
			let resolveGen1!: (val: any) => void;
			const gen1Promise = new Promise<any>((res) => {
				resolveGen1 = res;
			});

			const gen2Packs = [
				{ id: "pack-999", price_cents: 9999, currency: "USD", credits: 9999 },
			];

			let packFetchCount = 0;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					packFetchCount++;
					if (packFetchCount === 1) {
						return {
							ok: true,
							status: 200,
							json: async () => gen1Promise,
						};
					}
					return {
						ok: true,
						status: 200,
						json: async () => gen2Packs,
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			expect(packFetchCount).toBe(1);

			// Close and reopen modal to trigger generation 2
			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("9999 크레딧")).toBeDefined();
			});

			// Now generation 1 packs resolve late
			resolveGen1([
				{ id: "pack-111", price_cents: 1111, currency: "USD", credits: 1111 },
			]);
			await new Promise((r) => setTimeout(r, 20));

			// Modal must still show generation 2 packs (9999), NOT generation 1 (1111)
			expect(screen.getByText("9999 크레딧")).toBeDefined();
			expect(screen.queryByText("1111 크레딧")).toBeNull();
		});

		it("pack fetch late failure: older generation fetch failure does not show error on newer modal", async () => {
			let rejectGen1!: (err: any) => void;
			const gen1Promise = new Promise<any>((_, rej) => {
				rejectGen1 = rej;
			});

			const gen2Packs = [
				{ id: "pack-888", price_cents: 8888, currency: "USD", credits: 8888 },
			];

			let packFetchCount = 0;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					packFetchCount++;
					if (packFetchCount === 1) {
						return {
							ok: false,
							status: 500,
							json: async () => {
								await gen1Promise;
								return { detail: { error: "failed" } };
							},
						};
					}
					return {
						ok: true,
						status: 200,
						json: async () => gen2Packs,
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			expect(packFetchCount).toBe(1);

			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			await waitFor(() => {
				expect(screen.getByText("8888 크레딧")).toBeDefined();
			});

			rejectGen1(new Error("Gen 1 fetch error"));
			await new Promise((r) => setTimeout(r, 20));

			expect(screen.getByText("8888 크레딧")).toBeDefined();
			expect(screen.queryByText("Error: Failed to fetch Steam packs: HTTP 500")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("pack fetch late success during pending newer fetch: older generation finally does not prematurely clear loading state", async () => {
			let resolveGen1!: (val: any) => void;
			const gen1Promise = new Promise<any>((res) => {
				resolveGen1 = res;
			});

			let resolveGen2!: (val: any) => void;
			const gen2Promise = new Promise<any>((res) => {
				resolveGen2 = res;
			});

			const gen1Packs = [
				{ id: "pack-111", price_cents: 1111, currency: "USD", credits: 1111 },
			];
			const gen2Packs = [
				{ id: "pack-999", price_cents: 9999, currency: "USD", credits: 9999 },
			];

			let packFetchCount = 0;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					packFetchCount++;
					if (packFetchCount === 1) {
						return {
							ok: true,
							status: 200,
							json: async () => gen1Promise,
						};
					}
					return {
						ok: true,
						status: 200,
						json: async () => gen2Promise,
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			expect(packFetchCount).toBe(1);

			// Close and reopen modal to trigger generation 2 fetch while gen 1 is still pending
			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			expect(packFetchCount).toBe(2);

			// Generation 2 is pending: modal must show loading and disable buy button
			expect(screen.getByText("크레딧 팩 불러오는 중…")).toBeDefined();
			expect(screen.getByText("구매하기").closest("button")?.disabled).toBe(true);

			// While generation 2 is pending, generation 1 resolves
			resolveGen1(gen1Packs);
			await new Promise((r) => setTimeout(r, 20));

			// Gen 1's finally must NOT prematurely clear loading, nor show gen 1 packs
			expect(screen.getByText("크레딧 팩 불러오는 중…")).toBeDefined();
			expect(screen.getByText("구매하기").closest("button")?.disabled).toBe(true);
			expect(screen.queryByText("1111 크레딧")).toBeNull();

			// Now generation 2 resolves
			resolveGen2(gen2Packs);
			await waitFor(() => {
				expect(screen.getByText("9999 크레딧")).toBeDefined();
			});

			expect(screen.queryByText("크레딧 팩 불러오는 중…")).toBeNull();
			expect(screen.getByText("구매하기").closest("button")?.disabled).toBe(false);
		});

		it("pack fetch late failure during pending newer fetch: older generation finally does not prematurely clear loading state", async () => {
			let rejectGen1!: (err: any) => void;
			const gen1Promise = new Promise<any>((_, rej) => {
				rejectGen1 = rej;
			});

			let resolveGen2!: (val: any) => void;
			const gen2Promise = new Promise<any>((res) => {
				resolveGen2 = res;
			});

			const gen2Packs = [
				{ id: "pack-888", price_cents: 8888, currency: "USD", credits: 8888 },
			];

			let packFetchCount = 0;
			fetchMock.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === "string" ? url : url.toString();
				if (urlStr.includes("/v1/billing/steam/packs")) {
					packFetchCount++;
					if (packFetchCount === 1) {
						return {
							ok: false,
							status: 500,
							json: async () => {
								await gen1Promise;
								return { detail: { error: "failed" } };
							},
						};
					}
					return {
						ok: true,
						status: 200,
						json: async () => gen2Promise,
					};
				}
				return { ok: false, status: 404, json: async () => ({}) };
			});

			const { rerender } = render(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			expect(packFetchCount).toBe(1);

			// Close and reopen modal to trigger generation 2 fetch while gen 1 is still pending
			rerender(
				<SteamPurchaseModal
					isOpen={false}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);
			rerender(
				<SteamPurchaseModal
					isOpen={true}
					gatewayUrl="https://api.naia.test"
					onClose={vi.fn()}
				/>,
			);

			expect(packFetchCount).toBe(2);

			// Generation 2 is pending: modal must show loading and disable buy button
			expect(screen.getByText("크레딧 팩 불러오는 중…")).toBeDefined();
			expect(screen.getByText("구매하기").closest("button")?.disabled).toBe(true);

			// While generation 2 is pending, generation 1 rejects
			rejectGen1(new Error("Gen 1 fetch error"));
			await new Promise((r) => setTimeout(r, 20));

			// Gen 1's catch and finally must NOT clear loading state or show error
			expect(screen.getByText("크레딧 팩 불러오는 중…")).toBeDefined();
			expect(screen.getByText("구매하기").closest("button")?.disabled).toBe(true);
			expect(screen.queryByText("Error: Failed to fetch Steam packs: HTTP 500")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();

			// Now generation 2 resolves
			resolveGen2(gen2Packs);
			await waitFor(() => {
				expect(screen.getByText("8888 크레딧")).toBeDefined();
			});

			expect(screen.queryByText("크레딧 팩 불러오는 중…")).toBeNull();
			expect(screen.getByText("구매하기").closest("button")?.disabled).toBe(false);
			expect(screen.queryByText("Error: Failed to fetch Steam packs: HTTP 500")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
		});
	});
});
