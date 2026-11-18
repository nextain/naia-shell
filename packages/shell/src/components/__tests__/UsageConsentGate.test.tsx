// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let choice: { enabled: boolean; epoch: number } | null = null;
vi.mock("../../lib/usage-runtime", () => ({
	usageAvailable: true,
	installUsageListeners: vi.fn(),
	usage: {
		choice: () => choice,
		sync: vi.fn().mockResolvedValue(undefined),
		choose: vi.fn(),
		stop: vi.fn(),
	},
}));

import { UsageConsentGate } from "../UsageConsentGate";

afterEach(() => {
	cleanup();
	choice = null;
});

describe("UsageConsentGate", () => {
	it("closes when another window records a choice", () => {
		render(
			<UsageConsentGate>
				<p>app</p>
			</UsageConsentGate>,
		);
		expect(screen.queryByText("app")).toBeNull();
		act(() => {
			window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
		});
		expect(screen.queryByText("app")).toBeNull();
		choice = { enabled: false, epoch: 1 };
		act(() => {
			window.dispatchEvent(new StorageEvent("storage"));
		});
		expect(screen.getByText("app")).toBeTruthy();
	});
});
