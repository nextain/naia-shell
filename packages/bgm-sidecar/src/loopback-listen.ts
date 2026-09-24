/**
 * BGM 서버를 루프백에만 연다 (#716).
 *
 * 호스트 없이 `listen(port)` 하면 모든 인터페이스에서 받는다. Windows 는 첫 실행마다
 * 방화벽 창을 띄우고, "허용" 하면 같은 네트워크의 다른 기기가 인증 없는 이 서버에
 * 닿는다. macOS 에서 `localhost` 가 `::1` 로 풀리는 문제는 두 루프백 주소를 모두
 * 여는 것으로 충분하다 — 셸·Rust 건강 확인·포트 회수는 `127.0.0.1` 로 붙는다.
 */
import { createServer, type RequestListener, type Server } from "node:http";

export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

/** IPv6 가 꺼진 기계에서 `::1` 을 열 때 나는 오류. 이때는 IPv4 만으로 계속한다. */
const IPV6_UNAVAILABLE = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

export function listenOnLoopback(
	handler: RequestListener,
	port: number,
	onFatal: (err: NodeJS.ErrnoException, host: string) => void,
	log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Server[] {
	return LOOPBACK_HOSTS.map((host) => {
		const server = createServer(handler);
		server.on("error", (err: NodeJS.ErrnoException) => {
			if (host === "::1" && err.code && IPV6_UNAVAILABLE.has(err.code)) {
				log(`[youtube-server] ${host} unavailable (${err.code}) — IPv4 loopback only`);
				server.close();
				return;
			}
			onFatal(err, host);
		});
		server.listen(port, host, () => {
			log(`[youtube-server] listening on ${host}:${port}`);
		});
		return server;
	});
}
