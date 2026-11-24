import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// Contract: the oss-readiness internal-project-slug rule must keep blocking
// the maintainer-internal slug family while letting the public store product
// slug through. Literals are assembled from pieces so this tracked file never
// carries a contiguous slug token itself.
const HEAD = "cafe";
const TAIL = "lua";
const INTERNAL = HEAD + TAIL;
const PROD = INTERNAL + "-prod";
const DEV = INTERNAL + "-dev";
const DB = INTERNAL + "-db";
const HOST = INTERNAL + ".naia.land";
const PATH_SLUG = "/u/" + INTERNAL;
const PRODUCT = INTERNAL + "-tarot";
const PRODUCT_ID = "land.naia." + PRODUCT;

const GATE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../scripts/oss-readiness.mjs",
);

let fixture = "";

function gateExitFor(body: string): number {
	writeFileSync(join(fixture, "probe.txt"), body);
	try {
		execFileSync("node", [GATE, fixture], { stdio: "ignore" });
		return 0;
	} catch (err) {
		return (err as { status?: number }).status ?? 99;
	}
}

describe("oss-readiness internal slug guard", () => {
	beforeAll(() => {
		fixture = mkdtempSync(join(tmpdir(), "naia-slug-guard-"));
		const git = (args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", ...args], {
				cwd: fixture,
				stdio: "ignore",
			});
		git(["init"]);
		writeFileSync(join(fixture, "probe.txt"), "placeholder\n");
		git(["add", "."]);
		git(["commit", "-m", "fixture"]);
	});

	it("blocks the bare internal slug", () => {
		expect(gateExitFor(`slug ${INTERNAL}\n`)).toBe(1);
	}, 30_000);

	it("blocks the -prod variant", () => {
		expect(gateExitFor(`slug ${PROD}\n`)).toBe(1);
	}, 30_000);

	it("blocks the -dev variant", () => {
		expect(gateExitFor(`slug ${DEV}\n`)).toBe(1);
	}, 30_000);

	it("blocks the -db variant", () => {
		expect(gateExitFor(`slug ${DB}\n`)).toBe(1);
	}, 30_000);

	it("blocks the internal host", () => {
		expect(gateExitFor(`addr https://${HOST}/x\n`)).toBe(1);
	}, 30_000);

	it("blocks the slug in a /u/<slug> path", () => {
		expect(gateExitFor(`route ${PATH_SLUG}/auth/callback\n`)).toBe(1);
	}, 30_000);

	it("lets the public store product slug through", () => {
		expect(gateExitFor(`app ${PRODUCT}\n`)).toBe(0);
	}, 30_000);

	it("lets the public store product id through", () => {
		expect(gateExitFor(`id ${PRODUCT_ID}\n`)).toBe(0);
	}, 30_000);
});
