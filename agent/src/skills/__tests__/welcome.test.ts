import { describe, expect, it } from "vitest";
import { welcomeDescriptor } from "@naia-adk/skills-builtin";
import { createWelcomeSkill } from "../built-in/welcome.js";

describe("welcome skill (ported from OpenClaw via #274)", () => {
	const skill = createWelcomeSkill();

	it("registers as skill_welcome with tier 0", () => {
		expect(skill.name).toBe(`skill_${welcomeDescriptor.name}`);
		expect(skill.name).toBe("skill_welcome");
		expect(skill.tier).toBe(0);
		expect(skill.requiresGateway).toBe(false);
		expect(skill.source).toBe("built-in");
	});

	it("uses descriptor.description + inputSchema (no inline drift)", () => {
		expect(skill.description).toBe(welcomeDescriptor.description);
		expect(skill.parameters).toBe(welcomeDescriptor.inputSchema);
	});

	it("returns a structured template with KO defaults", async () => {
		const r = await skill.execute({}, { requestId: "t1", writeLine: () => {} });
		expect(r.success).toBe(true);
		const payload = JSON.parse(r.output);
		expect(payload.locale).toBe("ko");
		expect(payload.channel).toBe("generic");
		expect(payload.greeting).toMatch(/안녕|새|채널/);
		expect(payload.ask).toBeTruthy();
		expect(Array.isArray(payload.capability_ladder)).toBe(true);
		expect(payload.capability_ladder.length).toBe(8);
		expect(payload.note).toMatch(/TEMPLATE/);
	});

	it("switches to EN ladder for english locale", async () => {
		const r = await skill.execute(
			{ locale: "en-US", channel: "slack" },
			{ requestId: "t2", writeLine: () => {} },
		);
		expect(r.success).toBe(true);
		const payload = JSON.parse(r.output);
		expect(payload.locale).toBe("en-US");
		expect(payload.channel).toBe("slack");
		expect(payload.greeting).toMatch(/Hi|hello|connected/i);
		expect(payload.capability_ladder[0].title).toMatch(/Memory/i);
	});

	it("capability ladder order matches OpenClaw original drip-feed sequence", async () => {
		// Per OpenClaw container/skills/welcome/SKILL.md the order is:
		// 1. Memory  2. Persistent agents  3. Scheduled tasks  4. Research/Web
		// 5. Code  6. Interactive UI  7. Files & artifacts  8. Self-customization
		const r = await skill.execute(
			{ locale: "en" },
			{ requestId: "t3", writeLine: () => {} },
		);
		const payload = JSON.parse(r.output);
		const titles: string[] = payload.capability_ladder.map((c: { title: string }) => c.title.toLowerCase());
		expect(titles[0]).toMatch(/memory/);
		expect(titles[1]).toMatch(/agent|create_agent/);
		expect(titles[2]).toMatch(/scheduled|background/);
		expect(titles[3]).toMatch(/research|web/);
		expect(titles[4]).toMatch(/code|building/);
		expect(titles[5]).toMatch(/interactive|ui/);
		expect(titles[6]).toMatch(/files|artifacts/);
		expect(titles[7]).toMatch(/self.?custom/);
	});
});
