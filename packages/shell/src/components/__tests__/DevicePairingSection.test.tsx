// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listDeviceNodes = vi.fn();
const listDevicePairRequests = vi.fn();
const requestDevicePair = vi.fn();
const verifyDevicePair = vi.fn();
const approveDevicePair = vi.fn();
const rejectDevicePair = vi.fn();
const renameDeviceNode = vi.fn();
const rotateDeviceToken = vi.fn();
const revokeDeviceToken = vi.fn();
const describeDeviceNode = vi.fn();

vi.mock("../../lib/adk-store", () => ({
	isAdkInitialized: () => true,
}));

vi.mock("../../lib/device-store", () => ({
	listDeviceNodes: (...args: unknown[]) => listDeviceNodes(...args),
	listDevicePairRequests: (...args: unknown[]) => listDevicePairRequests(...args),
	requestDevicePair: (...args: unknown[]) => requestDevicePair(...args),
	verifyDevicePair: (...args: unknown[]) => verifyDevicePair(...args),
	approveDevicePair: (...args: unknown[]) => approveDevicePair(...args),
	rejectDevicePair: (...args: unknown[]) => rejectDevicePair(...args),
	renameDeviceNode: (...args: unknown[]) => renameDeviceNode(...args),
	rotateDeviceToken: (...args: unknown[]) => rotateDeviceToken(...args),
	revokeDeviceToken: (...args: unknown[]) => revokeDeviceToken(...args),
	describeDeviceNode: (...args: unknown[]) => describeDeviceNode(...args),
}));

vi.mock("../../lib/i18n", () => ({
	t: (key: string) => key,
}));

import { DevicePairingSection } from "../DevicePairingSection";

describe("DevicePairingSection", () => {
	afterEach(() => {
		cleanup();
	});

	beforeEach(() => {
		listDeviceNodes.mockResolvedValue([]);
		listDevicePairRequests.mockResolvedValue([]);
		requestDevicePair.mockReset();
		rotateDeviceToken.mockReset();
		revokeDeviceToken.mockReset();
	});

	it("renders the device section", async () => {
		render(<DevicePairingSection />);
		await waitFor(() => {
			expect(screen.getByTestId("device-section")).toBeTruthy();
		});
		expect(screen.getByText("settings.deviceEmpty")).toBeTruthy();
	});

	it("shows a one-time token after rotate", async () => {
		listDeviceNodes.mockResolvedValue([
			{
				nodeId: "n1",
				displayName: "desk",
				platform: "linux",
				createdAt: 1,
				updatedAt: 1,
				revoked: false,
				hasToken: true,
			},
		]);
		rotateDeviceToken.mockResolvedValue({
			node: { nodeId: "n1" },
			token: "ndt_rotated",
		});
		render(<DevicePairingSection />);
		await waitFor(() => screen.getByTestId("device-rotate"));
		fireEvent.click(screen.getByTestId("device-rotate"));
		await waitFor(() => {
			expect(screen.getByTestId("device-one-time-token").textContent).toBe(
				"ndt_rotated",
			);
		});
	});

	it("asks before revoke then calls revokeDeviceToken", async () => {
		listDeviceNodes.mockResolvedValue([
			{
				nodeId: "n1",
				displayName: "desk",
				platform: "linux",
				createdAt: 1,
				updatedAt: 1,
				revoked: false,
				hasToken: true,
			},
		]);
		revokeDeviceToken.mockResolvedValue(undefined);
		render(<DevicePairingSection />);
		await waitFor(() => screen.getByTestId("device-revoke"));
		fireEvent.click(screen.getByTestId("device-revoke"));
		expect(revokeDeviceToken).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId("device-revoke-confirm"));
		await waitFor(() => {
			expect(revokeDeviceToken).toHaveBeenCalledWith("n1");
		});
	});
});
