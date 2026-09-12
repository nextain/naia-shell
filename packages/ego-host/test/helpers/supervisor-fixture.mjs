// #582 S2a — 감독자 + 클라이언트를 띄우고 끄는 공용 지그.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSupervisor } from "../../src/client/rpc-client.mjs";
import { createSupervisorServer } from "../../src/supervisor/rpc-server.mjs";
import { createFakeCdp } from "./fake-cdp.mjs";

const dirs = [];
const servers = [];
const clients = [];

/** 테스트가 실패해도 소켓·서버가 남지 않게 한다. 남으면 파일 전체가 종료하지 못하고 매달린다. */
export async function closeAll() {
  for (const client of clients.splice(0)) {
    try {
      client.close();
    } catch {}
  }
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {}
  }
  cleanupDirs();
}

/** 짧은 소켓 디렉터리. unix 소켓 경로 상한(104바이트) 때문에 길게 잡으면 bind 가 죽는다. */
export function shortDir(prefix = "ego-s2a-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function cleanupDirs() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function startSupervisor(options = {}) {
  const backend = options.backend ?? createFakeCdp();
  const server = createSupervisorServer({ backend, ...options });
  const socketPath = join(shortDir(), "s.sock");
  await server.listen(socketPath, { kind: "unix" });
  servers.push(server);
  return { server, backend, socketPath };
}

export async function connectClient(server, socketPath, { grant = { tier: "workspace-write" }, ...rest } = {}) {
  const token = server.issueToken({ grant });
  const client = await connectSupervisor({ socketPath, token, grant, unref: false, ...rest });
  clients.push(client);
  return client;
}
