import { cleanup, render, waitFor } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const channel = vi.hoisted(() => ({ value: "steam" }));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) =>
		cmd === "get_distribution_channel" ? channel.value : undefined,
	),
	convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

import { resetDistributionChannelForTests } from "../../lib/distribution";
import { AboutSection } from "../SettingsTab";

// #727: the GitHub Sponsors link is a web payment path and must not render on
// the Steam build (nor while the channel is unknown).
const SPONSOR = ".settings-about__link--sponsor";

describe("AboutSection sponsor link (#727)", () => {
	beforeEach(() => resetDistributionChannelForTests());
	afterEach(cleanup);

	it("is hidden on the Steam channel", async () => {
		channel.value = "steam";
		const { container } = render(<AboutSection />);
		await new Promise((r) => setTimeout(r, 20));
		expect(container.querySelector(SPONSOR)).toBeNull();
	});

	it("is hidden when the channel is unknown (fail closed)", async () => {
		channel.value = "bogus";
		const { container } = render(<AboutSection />);
		await new Promise((r) => setTimeout(r, 20));
		expect(container.querySelector(SPONSOR)).toBeNull();
	});

	it("is shown on the standard channel", async () => {
		channel.value = "standard";
		const { container } = render(<AboutSection />);
		await waitFor(() =>
			expect(container.querySelector(SPONSOR)).not.toBeNull(),
		);
	});
});
