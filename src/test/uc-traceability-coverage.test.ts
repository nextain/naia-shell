import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// check-uc-traceability RED (tmp/f-g7.txt, base-g7.txt) 핀: 62개 UC에
// 게이트 판독용 `| UC-X | ... |` 행이 없다. 행 추가가 정식 경로(게이트 메시지).
const SCENARIOS = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../docs/user-scenarios.md",
);

const UCS = [
	"UC-KIOSK-KNOWLEDGE-S1",
	"UC-KIOSK-MEMORY-S2",
	"UC-WEB-A-R1",
	"UC-WEB-A-R11",
	"UC-WEB-A-R12",
	"UC-WEB-A-R2",
	"UC-WEB-A-R28",
	"UC-WEB-A-R5",
	"UC-WEB-A-R6",
	"UC-WEB-A-R8",
	"UC-WEB-APP-CATALOG",
	"UC-WEB-APP-TOOLS-20261114",
	"UC-WEB-AVATAR-CLIP",
	"UC-WEB-BGM-CATALOG-TRUTH",
	"UC-WEB-BGM-LOCAL-IMPORT",
	"UC-WEB-BGM-NOWPLAYING",
	"UC-WEB-BGM-TOPBAR-PLAY",
	"UC-WEB-BOOT-RUNTIME-SEPARATION",
	"UC-WEB-CHARCARD",
	"UC-WEB-CHARCARD-STORAGE-COPY",
	"UC-WEB-CHAT-MODEL-ERROR",
	"UC-WEB-CHAT-MODEL-SUMMARY",
	"UC-WEB-CHAT-START",
	"UC-WEB-CREDIT-CONTEXT",
	"UC-WEB-CREDIT-FORMAT",
	"UC-WEB-HOSTED-APPS",
	"UC-WEB-KIOSK-ADK-LOCAL",
	"UC-WEB-KIOSK-APP-STORE",
	"UC-WEB-KIOSK-FIX",
	"UC-WEB-KIOSK-FIX7B",
	"UC-WEB-KIOSK-FIX7C",
	"UC-WEB-KIOSK-FIX7D",
	"UC-WEB-KIOSK-FIX7F",
	"UC-WEB-KIOSK-FIX7G",
	"UC-WEB-KIOSK-FIX7J",
	"UC-WEB-KIOSK-MOBILE-FIX",
	"UC-WEB-KIOSK-PW",
	"UC-WEB-KIOSK-R12",
	"UC-WEB-KIOSK-R13-KL",
	"UC-WEB-KIOSK-R3",
	"UC-WEB-KIOSK-S3",
	"UC-WEB-KIOSK-S4",
	"UC-WEB-KIOSK-S5",
	"UC-WEB-KIOSK-S6",
	"UC-WEB-KIOSK-STUDIO-NVA",
	"UC-WEB-MAC-SAFARI-CHROME",
	"UC-WEB-MAIN-MODEL-AUTH",
	"UC-WEB-MAIN-MODEL-LIVE",
	"UC-WEB-REF-AUDIO-UPLOAD",
	"UC-WEB-SETTINGS-FILES",
	"UC-WEB-SETTINGS-MUSIC",
	"UC-WEB-SETTINGS-TABS-THINKING",
	"UC-WEB-SLIDES-PPTX",
	"UC-WEB-STUDIO-VOICE-APPLY",
	"UC-WEB-USAGE-COST",
	"UC-WEB-VISUAL-AGENT-SLUG",
	"UC-WEB-VOICE-LANG-GROUP",
	"UC-WEB-VOICE-MIC-ERROR",
	"UC-WEB-VRM-HUB",
	"UC-WEB-VRM-LIP-SYNC",
	"UC-WEB-WORKSPACE-IMPORT",
	"UC-WEBGPU-MODEL-DEFAULTS-20261124",
];

const PLACEHOLDER = /^(TODO|TBD|미정|추후|N\/A|없음|\?+)$/i;

describe("uc traceability coverage rows", () => {
	it("every listed UC has a UC-first-cell row with files and a description", () => {
		expect(UCS).toHaveLength(62);
		const doc = readFileSync(SCENARIOS, "utf8");
		for (const uc of UCS) {
			const row = new RegExp(`^\\|\\s*${uc}\\s*\\|(.*)$`, "m").exec(doc);
			expect(row, uc).not.toBeNull();
			const cells = row![1]
				.split("|")
				.map((cell) => cell.trim())
				.filter((cell) => cell.length > 0 && cell !== "—" && cell !== "-");
			expect(
				cells.some((cell) => /`[^`]+`/.test(cell)),
				`${uc} file refs`,
			).toBe(true);
			expect(
				cells.some(
					(cell) => !/`[^`]+`/.test(cell) && !PLACEHOLDER.test(cell),
				),
				`${uc} description`,
			).toBe(true);
		}
	});
});
