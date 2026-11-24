import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// check-file-anchors RED (tmp/f-g5.txt) 핀: 스캔 대상인데
// module-manifest.json 에 없는 5파일. 선언(게이트가 지시한 경로)으로만 GREEN.
const MANIFEST = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../.agents/context/module-manifest.json",
);

const MISSING = [
	"packages/shell/src/lib/web-runtime/__tests__/web-stage1-features.test.tsx",
	"packages/shell/src/lib/web-runtime/web-app-install-link.ts",
	"packages/shell/src/lib/web-runtime/web-login-prompt.ts",
	"packages/shell/src/lib/web-runtime/web-settings-assets.ts",
	"packages/shell/src/lib/web-runtime/web-slug-guard.ts",
];

const LAYERS = ["domain", "ports", "app", "adapters", "composition"];

describe("file-anchors manifest coverage", () => {
	it("registers every scanned web-runtime module with layer/uc/contract", () => {
		const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
		expect(Object.keys(manifest.files ?? {}).length).toBeGreaterThan(0);
		for (const file of MISSING) {
			const anchor = manifest.files?.[file];
			expect(anchor, file).toBeDefined();
			expect(LAYERS, file).toContain(anchor.layer);
			expect(anchor.uc, file).toBeTruthy();
			expect(anchor.contract, file).toBeTruthy();
		}
	});
});
