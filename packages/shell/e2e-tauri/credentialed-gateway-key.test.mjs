import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	buildCredsUpdateInvokeArgs,
	normalizeBoundAdkPath,
} from "./credentialed-gateway-key.mjs";

// #590 회귀: 하네스가 게이트웨이 키를 실어 보낼 때 스코프가 묶인 워크스페이스를
// 함께 넘겨야 한다. 넘기지 않으면 네이티브가 `startup message IPC requires an ADK
// path` 로 거절하고, 격리 ADK 는 하이드레이트되지 않는다.

test("creds_update invoke 인자는 묶인 ADK 워크스페이스를 실어 보낸다", () => {
	const adkPath = "/tmp/naia-shell-e2e-abc/adk";
	const args = buildCredsUpdateInvokeArgs({
		provider: "nextain",
		naiaKey: "secret-key",
		adkPath,
	});

	// 이것이 회귀의 핵심이다: adkPath 가 인자에 반드시 있어야 한다.
	// (`send_to_agent_command`, { message }) 로 되돌리면 여기서 무너진다.
	assert.equal(args.adkPath, adkPath);

	const message = JSON.parse(args.message);
	assert.equal(message.type, "creds_update");
	assert.equal(message.provider, "nextain");
	assert.equal(message.naiaKey, "secret-key");
});

test("윈도우식 경로(역슬래시·드라이브·끝 구분자)를 스코프 바인딩과 같게 정규화한다", () => {
	// setAdkPath 가 write_naia_path_cache 로 스코프를 묶을 때 끝의 슬래시·역슬래시를
	// 뗀다. 소스가 그 형태와 어긋나면 `stale ADK startup IPC rejected` 로 갈린다.
	const bound =
		"C:\\Users\\Default\\AppData\\Local\\Temp\\naia-shell-e2e-xyz\\adk";
	const args = buildCredsUpdateInvokeArgs({
		provider: "nextain",
		naiaKey: "k",
		adkPath: `${bound}\\`,
	});
	assert.equal(args.adkPath, bound);
	assert.equal(normalizeBoundAdkPath(`${bound}\\\\`), bound);
	assert.equal(normalizeBoundAdkPath("/tmp/adk///"), "/tmp/adk");
});

test("ADK 경로가 비면(=하이드레이트 안 됨) 던진다", () => {
	for (const adkPath of ["", "   ", null, undefined]) {
		assert.throws(
			() =>
				buildCredsUpdateInvokeArgs({
					provider: "nextain",
					naiaKey: "k",
					adkPath,
				}),
			/ADK path|hydrated/i,
			`expected throw for adkPath=${JSON.stringify(adkPath)}`,
		);
	}
});

test("provider 가 없으면 던진다", () => {
	assert.throws(
		() => buildCredsUpdateInvokeArgs({ naiaKey: "k", adkPath: "/tmp/adk" }),
		/provider/i,
	);
});
