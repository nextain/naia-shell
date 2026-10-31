// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AppCenterProps } from "../../../lib/app-registry";
import { setWebAssetsModeForTests } from "../../../lib/web-runtime/web-assets";
import { DeferredHerdrWorkspaceCenterArea } from "../index";

describe("web workspace path", () => {
	afterEach(() => {
		cleanup();
		localStorage.removeItem("naia-adk-path");
		setWebAssetsModeForTests(null);
	});

	it("shows the configured browser workspace path", () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem("naia-adk-path", "opfs://naia-adk");
		render(<DeferredHerdrWorkspaceCenterArea {...({} as AppCenterProps)} />);
		expect(screen.getByTestId("web-workspace-path")).toHaveTextContent("opfs://naia-adk");
	});

	it("does not display a stale native path as a browser workspace", () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem("naia-adk-path", "/native/stale");
		render(<DeferredHerdrWorkspaceCenterArea {...({} as AppCenterProps)} />);
		expect(screen.queryByTestId("web-workspace-path")).toBeNull();
	});
});
