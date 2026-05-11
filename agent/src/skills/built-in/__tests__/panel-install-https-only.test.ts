/**
 * Test: actionInstall must reject non-HTTPS sources
 * (security regression — #257 panel_install RCE via file:// / http:// / bare path).
 *
 * Previously accepted: https://, http://, git@, file://, bare local paths
 * (the last 4 were RCE vectors via crafted git repo or zip).
 * Now: HTTPS-only.
 *
 * Run:
 *   pnpm exec vitest run src/skills/built-in/__tests__/panel-install-https-only.test.ts
 */
import { describe, expect, it } from "vitest";
import { actionInstall } from "../panel.js";

const NOOP_CTX = {
	writeLine: () => {},
	requestId: "test-install",
};

describe("actionInstall HTTPS-only gate (#257)", () => {
	it("rejects file:// URL with clear error and does NOT spawn git", async () => {
		const result = await actionInstall(
			"file:///tmp/evil-panel",
			NOOP_CTX as any,
		);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		expect(result.error).toMatch(/https:\/\//);
		expect(result.error?.toLowerCase()).toContain("blocked");
	});

	it("rejects http:// URL (downgrade / MITM risk)", async () => {
		const result = await actionInstall(
			"http://example.com/panel.git",
			NOOP_CTX as any,
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/https:\/\//);
	});

	it("rejects git@ SSH-style source (private repo bypass)", async () => {
		const result = await actionInstall(
			"git@github.com:evil/panel.git",
			NOOP_CTX as any,
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/https:\/\//);
	});

	it("rejects bare local path (used to fall through to unzip)", async () => {
		const result = await actionInstall("/tmp/evil-panel.zip", NOOP_CTX as any);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/https:\/\//);
	});

	it("rejects data: scheme", async () => {
		const result = await actionInstall(
			"data:application/zip;base64,UEsDBA==",
			NOOP_CTX as any,
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/https:\/\//);
	});

	it("rejects javascript: scheme", async () => {
		const result = await actionInstall(
			"javascript:alert(1)",
			NOOP_CTX as any,
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/https:\/\//);
	});

	it("rejects empty/undefined source", async () => {
		const undef = await actionInstall(undefined, NOOP_CTX as any);
		expect(undef.success).toBe(false);
		expect(undef.error).toMatch(/required/);

		const empty = await actionInstall("", NOOP_CTX as any);
		expect(empty.success).toBe(false);
		expect(empty.error).toMatch(/required/);
	});

	it("accepts https:// scheme (does not error at the scheme check)", async () => {
		// We use a host that will fail DNS / git clone, so the call still
		// returns success:false — but the error must be from `git clone`
		// failing, NOT from the scheme gate. Distinguishing by message lets us
		// confirm the scheme gate passed.
		const result = await actionInstall(
			"https://invalid-host-that-does-not-exist.example.test/panel.git",
			NOOP_CTX as any,
		);
		expect(result.success).toBe(false);
		// The error should not contain the "blocked" / "must use https://" text
		// from the scheme gate — it should be a git clone error instead.
		expect(result.error?.toLowerCase() ?? "").not.toContain("blocked");
		expect(result.error).toMatch(/Install failed|already installed/);
	}, 30000);
});
