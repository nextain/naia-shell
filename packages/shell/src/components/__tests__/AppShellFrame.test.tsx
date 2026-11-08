// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ startResizeDragging: vi.fn() }),
}));
vi.mock("../AppMainContent", () => ({ AppMainContent: () => null }));
vi.mock("../SplashScreen", () => ({ SplashScreen: () => null }));

import { AppShellFrame } from "../AppShellFrame";

const EMBED = "https://www.youtube-nocookie.com/embed/first?autoplay=1";

function frame(backgroundVideoUrl: string, backgroundMediaType: "" | "image") {
	return (
		<AppShellFrame
			appReady
			bootComplete
			backgroundFallback={null}
			backgroundMediaType={backgroundMediaType}
			backgroundVideoUrl={backgroundVideoUrl}
			bgmVideoUrl={EMBED}
			mainContent={{ uiMode: "workspace", naiaWidth: 400 } as never}
			onSplashDone={() => {}}
			setNaiaWidth={() => {}}
		/>
	);
}

describe("AppShellFrame YouTube BGM layer", () => {
	it("keeps the same player iframe when the user changes the background", () => {
		const { container, rerender } = render(frame("", ""));
		const before = container.querySelector(".app-bg-iframe");
		expect(before).toHaveAttribute("src", EMBED);

		rerender(frame("blob:new-background.png", "image"));

		const after = container.querySelector(".app-bg-iframe");
		expect(after).toBe(before);
		expect(container.querySelector(".app-bg-image")).toHaveAttribute(
			"src",
			"blob:new-background.png",
		);
	});
});
