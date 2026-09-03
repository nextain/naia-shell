import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../ChatArea.tsx", import.meta.url), "utf8");

describe("ChatArea optional panel bundle contract", () => {
	it("keeps optional panels behind module-scoped lazy imports", () => {
		for (const panel of [
			"AgentsTab",
			"ChannelsTab",
			"CostDashboard",
			"DiagnosticsTab",
			"HistoryTab",
		]) {
			expect(source).toContain(`import("./${panel}")`);
			expect(source).not.toMatch(
				new RegExp(`import\\s*\\{[^}]*${panel}[^}]*\\}\\s*from\\s*["']\\./${panel}["']`),
			);
			expect(source).toContain(`const Lazy${panel} = lazy(load${panel});`);
		}
	});

	it("renders every optional panel through the shared isolation boundary", () => {
		expect(source.match(/<LazyPanel/g)).toHaveLength(5);
		expect(source).toContain('activeTab === "history"');
		expect(source).toContain('activeTab === "channels"');
		expect(source).toContain("showCostDashboard && activeTab === \"chat\"");
	});
});
