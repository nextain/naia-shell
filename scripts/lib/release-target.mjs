/**
 * 이번 배포가 어느 운영체제로 나가는가, 그리고 그 운영체제에서 도는 스펙과
 * 기계는 무엇인가를 정하는 한 곳.
 *
 * 왜 이 파일이 있는가. 배포 전 회귀는 명단의 활성 기계 전부가 스펙 전부를
 * 나눠 맡는 것으로 판정했다. 그래서 윈도우 설치본만 내보내는 배포(0.2.3)도
 * 리눅스 기계의 몫이 비면 붉어졌고, 리눅스에서만 도는 스펙(PipeWire 마이크,
 * 리눅스 음성 프로필)까지 윈도우 배포의 조건이 되었다. 나가지 않는 운영체제의
 * 결과로 나가는 것을 막는 것은 판정이 아니라 잡음이다.
 *
 * 무엇을 정하는가.
 *   - 배포 대상: `releases/v<셸 버전>.yaml` 의 `targets:`. 적혀 있지 않으면
 *     대상을 좁히지 않는다(옛 동작 그대로 — 모든 운영체제).
 *   - 스펙의 운영체제: 스펙 파일의 `// platforms: linux` 한 줄. 인벤토리가
 *     `platforms` 로 옮긴다. 적혀 있지 않은 스펙은 어디서나 돈다.
 *   - 기계의 운영체제: 명단(`docs/regression-runs/machines.json`)의 `os`.
 *
 * 좁혀서 빠진 것은 조용히 사라지지 않는다. 게이트와 러너가 그 목록을 그대로
 * 출력한다 — 빠진 것을 통과로 세지 않고, 빠졌다는 사실과 이유를 남긴다.
 *
 * 러너(`scripts/run-regression.mjs`)와 게이트(`scripts/check-regression-complete.mjs`)가
 * 둘 다 여기서 계산한다. 같은 식을 두 곳에 적으면 한쪽만 고쳐진다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 명단과 매니페스트가 쓰는 이름. `process.platform` 과는 다르다. */
export const KNOWN_OS = Object.freeze(["windows", "linux", "darwin"]);

/** `process.platform` → 명단의 운영체제 이름. */
export function osOfPlatform(platform) {
	return platform === "win32" ? "windows" : platform;
}

/**
 * `targets:` 한 줄 또는 목록 블록을 읽는다.
 *
 * 매니페스트는 YAML 이지만 이 저장소에는 YAML 파서가 뿌리 의존성에 없다.
 * 필요한 것은 문자열 목록 하나이므로 두 형태만 받는다.
 *   targets: [windows, linux]
 *   targets:
 *     - windows
 * 그 밖의 형태는 모른다고 말한다 — 읽지 못한 것을 "대상 없음" 으로 넘기면
 * 좁히지 않은 채로 돈다고 착각하게 된다.
 */
export function parseTargets(yamlText) {
	const lines = yamlText.split(/\r?\n/);
	const at = lines.findIndex((line) => /^targets\s*:/.test(line));
	if (at < 0) return null;
	const rest = lines[at].replace(/^targets\s*:\s*/, "").replace(/\s+#.*$/, "").trim();
	let items;
	if (rest.startsWith("[")) {
		if (!rest.endsWith("]")) throw new Error(`targets 를 읽을 수 없다: ${lines[at]}`);
		items = rest
			.slice(1, -1)
			.split(",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	} else if (rest === "") {
		items = [];
		for (const line of lines.slice(at + 1)) {
			const m = /^\s+-\s*["']?([A-Za-z0-9_-]+)["']?\s*(?:#.*)?$/.exec(line);
			if (!m) break;
			items.push(m[1]);
		}
	} else {
		throw new Error(`targets 를 읽을 수 없다: ${lines[at]}`);
	}
	const unknown = items.filter((os) => !KNOWN_OS.includes(os));
	if (unknown.length) {
		throw new Error(`알 수 없는 배포 대상: ${unknown.join(", ")} (쓸 수 있는 것: ${KNOWN_OS.join(", ")})`);
	}
	if (items.length === 0) throw new Error("targets 가 비어 있다 — 대상을 적거나 줄을 지워라");
	return [...new Set(items)];
}

/**
 * 이번 배포의 대상 운영체제. `null` 이면 좁히지 않는다.
 *
 * `--platform=windows[,linux]` 가 있으면 그것이 우선한다 — 사람이 한 대상만
 * 따로 확인할 때 쓴다. 없으면 셸 버전의 매니페스트를 읽는다.
 */
export function releaseTargets({ root = ".", argv = process.argv.slice(2) } = {}) {
	const flag = argv.find((a) => a.startsWith("--platform="));
	if (flag) {
		const items = flag
			.slice("--platform=".length)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const unknown = items.filter((os) => !KNOWN_OS.includes(os));
		if (unknown.length || items.length === 0) {
			throw new Error(`--platform 을 읽을 수 없다: ${flag} (쓸 수 있는 것: ${KNOWN_OS.join(", ")})`);
		}
		return { targets: [...new Set(items)], source: "--platform" };
	}
	const pkgPath = join(root, "packages", "shell", "package.json");
	if (!existsSync(pkgPath)) return { targets: null, source: null };
	const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
	const manifest = join(root, "releases", `v${version}.yaml`);
	if (!existsSync(manifest)) return { targets: null, source: null };
	return {
		targets: parseTargets(readFileSync(manifest, "utf8")),
		source: manifest.replaceAll("\\", "/"),
	};
}

/** 이 스펙이 그 운영체제에서 도는가. `platforms` 가 없으면 어디서나 돈다. */
export function specRunsOn(spec, os) {
	return !Array.isArray(spec.platforms) || spec.platforms.includes(os);
}

/** 대상 중 하나에서라도 도는가. 대상이 없으면(좁히지 않으면) 언제나 참. */
export function specInTargets(spec, targets) {
	return !targets || targets.some((os) => specRunsOn(spec, os));
}

/** 대상 운영체제의 기계인가. 대상이 없으면 언제나 참. */
export function machineInTargets(machine, targets) {
	return !targets || targets.includes(machine.os);
}
