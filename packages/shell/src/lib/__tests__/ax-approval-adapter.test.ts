import { describe, expect, it, vi } from "vitest";
import {
	makeAxApprovalAdapter,
	type AxApprovalCard,
} from "../ax-approval-adapter";
vi.mock("../logger", () => ({ Logger: { debug: vi.fn() } }));
const card: AxApprovalCard = {
	proposalId: "p1",
	requestId: "r1",
	callId: "t1",
	mode: "conversation",
	preview: "send document",
	expiresAt: 123,
};
function setup() {
	const token = Object.freeze({});
	const evidence = Object.freeze({});
	const host = {
		displayed: vi.fn(() => true),
		beginInput: vi.fn((e) => (e === evidence ? token : undefined)),
		submit: vi.fn(() => true),
		invalidate: vi.fn(),
		dispose: vi.fn(),
	};
	return { host, evidence, token, adapter: makeAxApprovalAdapter(host) };
}
describe("UC-B2C-026-R7 AX host adapter draft", () => {
	it("requires presentation ACK then authenticated capture; cannot elevate JSON origin", () => {
		const { adapter, host, evidence } = setup();
		expect(adapter.beginInput(evidence)).toBe(false);
		adapter.present(card);
		expect(adapter.beginInput(evidence)).toBe(false);
		expect(adapter.displayed("old")).toBe(false);
		expect(adapter.displayed("p1")).toBe(true);
		expect(adapter.beginInput({ origin: "human-text" })).toBe(false);
		expect(adapter.submit("응")).toBe(false);
		expect(host.submit).not.toHaveBeenCalled();
	});
	it("consumes before callback and never replays or forwards rejected input", () => {
		const { adapter, host, evidence, token } = setup();
		adapter.present(card);
		adapter.displayed("p1");
		adapter.beginInput(evidence);
		host.submit.mockImplementation(() => {
			expect(adapter.submit("응")).toBe(false);
			return false;
		});
		expect(adapter.submit("응")).toBe(false);
		expect(adapter.submit("응")).toBe(false);
		expect(host.submit).toHaveBeenCalledExactlyOnceWith(token, {
			text: "응",
			final: true,
		});
	});
	it.each(["workspace", "provider", "policy", "cancel", "new-intent"])(
		"invalidates capture on %s change",
		() => {
			const { adapter, host, evidence } = setup();
			adapter.present(card);
			adapter.displayed("p1");
			adapter.beginInput(evidence);
			adapter.invalidate();
			expect(adapter.submit("응")).toBe(false);
			expect(host.invalidate).toHaveBeenCalledOnce();
		},
	);
	it("replacement cannot inherit capture or invalidate the new host proposal", () => {
		const { adapter, host, evidence } = setup();
		adapter.present(card);
		adapter.displayed("p1");
		adapter.beginInput(evidence);
		adapter.present({ ...card, proposalId: "p2" });
		expect(adapter.submit("응")).toBe(false);
		expect(adapter.displayed("p1")).toBe(false);
		expect(host.invalidate).not.toHaveBeenCalled();
		adapter.displayed("p2");
		adapter.beginInput(evidence);
		expect(adapter.submit("응")).toBe(true);
	});
	it("failed render ACK, disconnected host and restart cannot keep grants", () => {
		const { adapter, host, evidence } = setup();
		host.displayed.mockReturnValue(false);
		adapter.present(card);
		expect(adapter.displayed("p1")).toBe(false);
		expect(adapter.beginInput(evidence)).toBe(false);
		adapter.dispose();
		adapter.dispose();
		expect(host.dispose).toHaveBeenCalledOnce();
		expect(adapter.present(card)).toBe(false);
		expect(adapter.displayed("p1")).toBe(false);
		const restarted = makeAxApprovalAdapter(host);
		expect(restarted.submit("응")).toBe(false);
	});
});

describe("UC-B2C-026-R10 host failures", () => {
	it.each(["displayed", "beginInput", "submit"] as const)(
		"contains %s exceptions and consumes input",
		(method) => {
			const { adapter, host, evidence } = setup();
			adapter.present(card);
			if (method === "displayed")
				host.displayed.mockImplementation(() => {
					throw new Error("private host details");
				});
			expect(adapter.displayed("p1")).toBe(method !== "displayed");
			if (method === "beginInput")
				host.beginInput.mockImplementation(() => {
					throw new Error("private capture details");
				});
			expect(adapter.beginInput(evidence)).toBe(method === "submit");
			if (method === "submit")
				host.submit.mockImplementation(() => {
					throw new Error("private submit details");
				});
			expect(adapter.submit("보내")).toBe(false);
			expect(adapter.submit("보내")).toBe(false);
			expect(host.submit).toHaveBeenCalledTimes(method === "submit" ? 1 : 0);
		},
	);
});

it.each(["invalidate", "dispose"] as const)(
	"retires local capture even if host %s throws",
	(method) => {
		const { adapter, host, evidence } = setup();
		adapter.present(card);
		adapter.displayed("p1");
		adapter.beginInput(evidence);
		host[method].mockImplementation(() => {
			throw new Error("host disconnected");
		});
		expect(() => adapter[method]()).not.toThrow();
		expect(adapter.submit("보내")).toBe(false);
		expect(host.submit).not.toHaveBeenCalled();
	},
);
