// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { SteamPurchaseModal } from "../SteamPurchaseModal";
import { setLocale } from "../../lib/i18n";

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

	it("immediate GRANTED status finishes without authorization flow (#729 P1 지적 6)", async () => {
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
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		fireEvent.click(screen.getByText("1000 크레딧"));
		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(onPurchaseSuccess).toHaveBeenCalledTimes(1);
			expect(screen.getByText("크레딧 충전이 완료되었습니다!")).toBeDefined();
		});
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
			expect(screen.getByText("크레딧 충전이 완료되었습니다!")).toBeDefined();
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

		const onNavigateToSettings = vi.fn();
		const onClose = vi.fn();

		render(
			<SteamPurchaseModal
				isOpen={true}
				gatewayUrl="https://api.naia.test"
				naiaKey="test-key"
				onClose={onClose}
				onNavigateToSettings={onNavigateToSettings}
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
		expect(onNavigateToSettings).toHaveBeenCalled();
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
});
