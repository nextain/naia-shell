import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	STORE_FILE,
	authenticate,
	describeNode,
	pairApprove,
	pairRequest,
	pairVerify,
	renameNode,
	revokeToken,
	rotateToken,
} from "../device-pairing";

function storePath(): string {
	return join(mkdtempSync(join(tmpdir(), "naia-device-")), STORE_FILE);
}

describe("device pairing store", () => {
	it("invalidates the previous token after rotate", () => {
		const path = storePath();
		const created = pairRequest(path, "kitchen", "windows");
		pairVerify(path, created.request.requestId, created.code);
		const approved = pairApprove(path, created.request.requestId);
		expect(authenticate(path, approved.node.nodeId, approved.token)).toBe(true);

		const rotated = rotateToken(path, approved.node.nodeId);
		expect(rotated).not.toBe(approved.token);
		expect(authenticate(path, approved.node.nodeId, approved.token)).toBe(false);
		expect(authenticate(path, approved.node.nodeId, rotated)).toBe(true);
	});

	it("revoke stops the current token", () => {
		const path = storePath();
		const created = pairRequest(path, "desk", "linux");
		pairVerify(path, created.request.requestId, created.code);
		const approved = pairApprove(path, created.request.requestId);
		revokeToken(path, approved.node.nodeId);
		expect(authenticate(path, approved.node.nodeId, approved.token)).toBe(false);
	});

	it("rename and describe change the visible name", () => {
		const path = storePath();
		const created = pairRequest(path, "old-name", "windows");
		pairVerify(path, created.request.requestId, created.code);
		const approved = pairApprove(path, created.request.requestId);
		renameNode(path, approved.node.nodeId, "e2e-node");
		expect(describeNode(path, approved.node.nodeId).displayName).toBe("e2e-node");
	});

	it("rejects a wrong pair code and requires verify before approve", () => {
		const path = storePath();
		const created = pairRequest(path, "phone", "android");
		expect(() => pairVerify(path, created.request.requestId, "ffffff")).toThrow(
			"code_mismatch",
		);
		expect(() => pairApprove(path, created.request.requestId)).toThrow(
			"request_not_verified",
		);
		pairVerify(path, created.request.requestId, created.code);
		pairApprove(path, created.request.requestId);
	});

	it("never writes plaintext secrets", () => {
		const path = storePath();
		const created = pairRequest(path, "lab", "linux");
		pairVerify(path, created.request.requestId, created.code);
		const approved = pairApprove(path, created.request.requestId);
		const raw = readFileSync(path, "utf8");
		expect(raw).not.toContain(created.code);
		expect(raw).not.toContain(approved.token);
		expect(raw).toContain("tokenHash");
		expect(raw).toContain("codeHash");
	});
});
