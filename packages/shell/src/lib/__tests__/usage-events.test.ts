import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageControlAliases } from "../usage-control-aliases";
import {
	USAGE_STATE_KEY,
	type UsageEvent,
	UsageEvents,
	parseUsageConnection,
	usageEnvelope,
} from "../usage-events";

function fixture(options: { configured?: boolean } = {}) {
	const map = new Map<string, string>();
	const storage = {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => {
			map.set(k, v);
		},
	};
	let serial = 0;
	let clock = 0;
	let online = true;
	let tail = Promise.resolve();
	const send = vi
		.fn<(events: UsageEvent[], signal: AbortSignal) => Promise<void>>()
		.mockResolvedValue(undefined);
	const env = {
		storage,
		uuid: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
		now: () => clock,
		online: () => online,
		send,
		configured: options.configured ?? true,
		version: "0.2.6",
		platform: "linux" as const,
		channel: "standard" as const,
		lock: <T>(fn: () => T | Promise<T>): Promise<T> => {
			const next = tail.then(fn);
			tail = next.then(() => undefined);
			return next;
		},
	};
	const usage = new UsageEvents(env);
	return {
		usage,
		env,
		map,
		send,
		drain: () => tail,
		time: (value: number) => {
			clock = value;
		},
		offline: () => {
			online = false;
		},
	};
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("usage consent and privacy boundary", () => {
	it("collects zero in memory/storage/network before consent and after decline", async () => {
		const f = fixture();
		f.usage.record("chat.message.send", "text");
		await f.usage.sync();
		await f.usage.flush();
		expect(f.usage.pending).toBe(0);
		expect(f.map.size).toBe(0);
		expect(f.send).not.toHaveBeenCalled();
		await f.usage.choose(false);
		f.usage.record("chat.message.send", "text");
		await f.usage.flush();
		expect(f.map.has(USAGE_STATE_KEY)).toBe(false);
		expect(f.send).not.toHaveBeenCalled();
	});
	it("starts at sequence one once, persists identity and sequence across restarts", async () => {
		const f = fixture();
		await f.usage.choose(true);
		await f.drain();
		await f.usage.flush();
		const first = f.send.mock.calls[0][0];
		expect(first[0].name).toBe("shell.start.observed");
		expect(first[0].sequence).toBe(1);
		f.usage.stop();
		const next = new UsageEvents(f.env);
		await next.sync();
		await next.flush();
		expect(f.send.mock.calls[1][0].map((e) => e.name)).toEqual([
			"shell.launch.start",
		]);
		expect(f.send.mock.calls[1][0][0].installation_id).toBe(
			first[0].installation_id,
		);
		expect(f.send.mock.calls[1][0][0].sequence).toBeGreaterThan(
			first.at(-1)?.sequence ?? 0,
		);
	});
	it("keeps send disabled without a build connection string", async () => {
		const f = fixture({ configured: false });
		await f.usage.choose(true);
		f.usage.record("chat.message.send", "text");
		await f.usage.flush();
		expect(f.usage.pending).toBe(0);
		expect(f.map.has(USAGE_STATE_KEY)).toBe(false);
		expect(f.send).not.toHaveBeenCalled();
	});
	it("rejects unknown names, screens, arbitrary fields and account values", async () => {
		const f = fixture();
		await f.usage.choose(true);
		await f.drain();
		await f.usage.flush();
		f.send.mockClear();
		f.usage.record("arbitrary.name", "text");
		f.usage.record("chat.message.send", "/private/path");
		f.usage.record("chat.message.send", "text", {
			email: "private@example.test",
		} as never);
		f.usage.record("login.browser.start", "intro", {
			attempt_id: "account-id",
		});
		await f.drain();
		await f.usage.flush();
		expect(f.send).not.toHaveBeenCalled();
		f.usage.record("chat.message.send", "text");
		await f.drain();
		await f.usage.flush();
		const event = f.send.mock.calls[0][0][0];
		expect(
			usageEnvelope(event, "synthetic-key").data.baseData.properties.sequence,
		).toBe(String(event.sequence));
		expect(Object.keys(event).sort()).toEqual(
			[
				"name",
				"screen",
				"installation_id",
				"event_id",
				"sequence",
				"occurred_at",
				"version",
				"platform",
				"channel",
			].sort(),
		);
		expect(JSON.stringify(usageEnvelope(event, "synthetic-key"))).not.toMatch(
			/email|userId|account|conversation|url|path|authorization|cookie/i,
		);
		expect(
			new TextEncoder().encode(
				JSON.stringify(usageEnvelope(event, "synthetic-key")),
			).length,
		).toBeLessThan(2048);
	});
	it("disables immediately, aborts inflight, clears queue and never replays old events", async () => {
		const f = fixture();
		await f.usage.choose(true);
		await f.drain();
		let signal: AbortSignal | undefined;
		f.send.mockImplementationOnce(async (_, s) => {
			signal = s;
			await new Promise<void>((_, reject) =>
				s.addEventListener("abort", () => reject(new Error("aborted"))),
			);
		});
		const pending = f.usage.flush();
		await Promise.resolve();
		await f.usage.choose(false);
		await pending;
		expect(signal?.aborted).toBe(true);
		expect(f.usage.pending).toBe(0);
		f.usage.record("chat.session.new", "chat");
		await f.drain();
		await f.usage.flush();
		expect(f.send).toHaveBeenCalledTimes(1);
		await f.usage.choose(true);
		await f.drain();
		await f.usage.flush();
		expect(
			f.send.mock.calls[1][0].every((e) => e.name !== "chat.session.new"),
		).toBe(true);
	});
	it("shares atomic sequence across windows and checks consent even before the storage callback", async () => {
		const f = fixture();
		await f.usage.choose(true);
		const other = new UsageEvents(f.env);
		await other.sync();
		for (let i = 0; i < 10; i++) {
			f.usage.record("chat.session.new", "chat");
			other.record("chat.session.new", "chat");
		}
		await f.drain();
		await f.usage.flush();
		await other.flush();
		const events = f.send.mock.calls.flatMap((c) => c[0]);
		expect(new Set(events.map((e) => e.sequence)).size).toBe(events.length);
		other.record("chat.session.new", "chat");
		await f.usage.choose(false);
		await f.drain();
		await other.flush();
		expect(other.pending).toBe(0);
		expect(f.send).toHaveBeenCalledTimes(2);
	});
	it("discards events queued for a previous consent epoch", async () => {
		const f = fixture();
		await f.usage.choose(true);
		const other = new UsageEvents(f.env);
		await other.sync();
		other.record("chat.session.new", "chat");
		await f.drain();
		await f.usage.choose(false);
		await f.usage.choose(true);
		await other.sync();
		await other.flush();
		expect(
			f.send.mock.calls
				.flatMap((c) => c[0])
				.some((e) => e.name === "chat.session.new"),
		).toBe(false);
	});
	it("fails closed on denied storage or atomic lock errors", async () => {
		const f = fixture();
		f.env.storage.setItem = () => {
			throw new Error("denied");
		};
		expect(await f.usage.choose(true)).toBe(false);
		expect(f.usage.pending).toBe(0);
		const g = fixture();
		g.env.lock = async () => {
			throw new Error("no lock");
		};
		await g.usage.choose(true);
		g.usage.record("chat.message.send", "text");
		await g.usage.flush();
		expect(g.send).not.toHaveBeenCalled();
	});
});

describe("bounded, ephemeral, best-effort batches", () => {
	it("bounds to 50 and drops oldest with local loss count", async () => {
		const f = fixture();
		await f.usage.choose(true);
		for (let i = 0; i < 60; i++) f.usage.record("chat.session.new", "chat");
		await f.drain();
		expect(f.usage.pending).toBe(50);
		expect(f.usage.lost).toBe(13);
		await f.usage.flush();
		expect(f.send.mock.calls[0][0][0].name).toBe("chat.session.new");
		expect(f.map.size).toBe(2);
	});
	it("retries once preserving ids, then drops; TTL and offline discard", async () => {
		const f = fixture();
		f.send.mockRejectedValue(new Error("network"));
		await f.usage.choose(true);
		await f.drain();
		await f.usage.flush();
		expect(f.usage.pending).toBe(3);
		await f.usage.flush();
		expect(f.usage.pending).toBe(0);
		expect(f.send.mock.calls[0][0]).toEqual(f.send.mock.calls[1][0]);
		f.usage.record("chat.session.new", "chat");
		await f.drain();
		f.time(600001);
		await f.usage.flush();
		expect(f.send).toHaveBeenCalledTimes(2);
		f.usage.record("chat.session.new", "chat");
		await f.drain();
		f.offline();
		await f.usage.flush();
		expect(f.usage.pending).toBe(0);
	});
	it("records only the first reply per installation across instances", async () => {
		const f = fixture();
		await f.usage.choose(true);
		f.usage.record("chat.reply.first", "text");
		f.usage.record("chat.reply.first", "voice");
		await f.drain();
		const other = new UsageEvents(f.env);
		await other.sync();
		other.record("chat.reply.first", "voice");
		await f.drain();
		await other.flush();
		await f.usage.flush();
		expect(
			f.send.mock.calls
				.flatMap((c) => c[0])
				.filter((e) => e.name === "chat.reply.first"),
		).toHaveLength(1);
	});
	it("drops queued data on exit and recreates no disk replay", async () => {
		const f = fixture();
		await f.usage.choose(true);
		await f.drain();
		f.usage.stop();
		expect(f.usage.pending).toBe(0);
		const other = new UsageEvents(f.env);
		await other.sync();
		await other.flush();
		expect(f.send.mock.calls[0][0].map((e) => e.name)).toEqual([
			"shell.launch.start",
		]);
	});
});

it("accepts only valid Azure connections, never arbitrary URLs or credentials", () => {
	const key = "00000000-0000-4000-8000-000000000001";
	expect(parseUsageConnection(undefined)).toBeNull();
	expect(parseUsageConnection("garbage")).toBeNull();
	expect(
		parseUsageConnection(
			`InstrumentationKey=${key};IngestionEndpoint=https://koreacentral.in.applicationinsights.azure.com/;`,
		)?.url,
	).toContain("/v2.1/track");
	for (const endpoint of [
		"http://dc.applicationinsights.azure.com",
		"https://evil.test",
		"https://user:pass@dc.applicationinsights.azure.com",
		"https://dc.applicationinsights.azure.com/?key=private",
	])
		expect(
			parseUsageConnection(
				`InstrumentationKey=${key};IngestionEndpoint=${endpoint}`,
			),
		).toBeNull();
});

it("validates every approved semantic alias and refuses input masquerading as a choice", async () => {
	const f = fixture();
	await f.usage.choose(true);
	await f.drain();
	await f.usage.flush();
	f.send.mockClear();
	for (const alias of Object.values(usageControlAliases)) {
		f.usage.record(
			alias.name,
			alias.screen,
			alias.choice ? { choice: alias.choice } : {},
		);
		await f.drain();
		await f.usage.flush();
		expect(f.send.mock.calls.at(-1)?.[0][0].name).toBe(alias.name);
	}
	f.send.mockClear();
	f.usage.record("intro.provider.choose", "provider", {
		choice: "private-input",
	});
	f.usage.record("toString", "text");
	await f.drain();
	await f.usage.flush();
	expect(f.send).not.toHaveBeenCalled();
});
