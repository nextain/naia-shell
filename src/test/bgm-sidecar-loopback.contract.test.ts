// #716 — BGM 사이드카는 루프백에서만 받는다. 모든 인터페이스에서 받으면 Windows 가
// 첫 실행마다 방화벽 창을 띄우고, 허용하면 같은 네트워크의 기기가 인증 없는 서버에 닿는다.
import { createServer, request, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPBACK_HOSTS, listenOnLoopback } from "../../packages/bgm-sidecar/src/loopback-listen.js";

let servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.map((s) => new Promise((done) => s.close(() => done(null)))));
	servers = [];
});

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

function reaches(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const req = request({ host, port, path: "/health", timeout: 1000 }, (res) => {
			res.resume();
			resolve(res.statusCode === 200);
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

function listening(list: Server[]): Promise<void> {
	return Promise.all(
		list.map(
			(s) =>
				new Promise<void>((resolve) => {
					if (s.listening) resolve();
					else {
						s.once("listening", () => resolve());
						s.once("close", () => resolve());
					}
				}),
		),
	).then(() => undefined);
}

/** 이 기계의 루프백이 아닌 IPv4 주소 하나. 없으면 그 단정은 건너뛴다. */
function lanAddress(): string | undefined {
	for (const list of Object.values(networkInterfaces())) {
		for (const a of list ?? []) {
			if (a.family === "IPv4" && !a.internal) return a.address;
		}
	}
	return undefined;
}

describe("BGM 사이드카 수신 주소 (#716)", () => {
	it("두 루프백 주소만 연다", () => {
		expect([...LOOPBACK_HOSTS]).toEqual(["127.0.0.1", "::1"]);
	});

	it("127.0.0.1 로 닿고, 루프백이 아닌 주소로는 닿지 않는다", async () => {
		const port = await freePort();
		const fatal: string[] = [];
		servers = listenOnLoopback(
			(_req, res) => {
				res.writeHead(200);
				res.end("ok");
			},
			port,
			(err, host) => fatal.push(`${host} ${err.code}`),
			() => {},
		);
		await listening(servers);
		expect(fatal).toEqual([]);
		expect(await reaches("127.0.0.1", port)).toBe(true);
		const lan = lanAddress();
		if (lan) expect(await reaches(lan, port)).toBe(false);
	});

	it("IPv6 루프백이 있으면 ::1 로도 닿는다", async () => {
		const port = await freePort();
		servers = listenOnLoopback(
			(_req, res) => {
				res.writeHead(200);
				res.end("ok");
			},
			port,
			() => {},
			() => {},
		);
		await listening(servers);
		const v6 = servers.find((s) => s.listening && (s.address() as { family?: string })?.family === "IPv6");
		if (v6) expect(await reaches("::1", port)).toBe(true);
	});

	it("포트를 이미 누가 쥐고 있으면 치명 오류로 넘긴다", async () => {
		const holder = createServer();
		const port = await new Promise<number>((resolve) =>
			holder.listen(0, "127.0.0.1", () => resolve((holder.address() as { port: number }).port)),
		);
		const fatal: string[] = [];
		servers = listenOnLoopback(
			() => {},
			port,
			(err, host) => fatal.push(`${host} ${err.code}`),
			() => {},
		);
		await new Promise((r) => setTimeout(r, 200));
		servers.push(holder);
		expect(fatal).toContain("127.0.0.1 EADDRINUSE");
	});
});
