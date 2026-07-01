// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
const activatePanel = vi.fn();
const openFile = vi.fn();
const setActiveApp = vi.fn();

vi.mock("../lib/app-registry", () => ({
	appRegistry: {
		getApi: (id: string) =>
			id === "browser"
				? { navigate, activatePanel }
				: id === "workspace"
					? { openFile }
					: undefined,
	},
}));
vi.mock("../stores/app", () => ({
	useAppStore: { getState: () => ({ setActiveApp }) },
}));

import {
	isSafeSourcePath,
	openKnowledgeSource,
} from "../lib/knowledge-source-open";

beforeEach(() => vi.clearAllMocks());

describe("knowledge-source-open — 출처 열기 + 민감경로 가드(적대리뷰)", () => {
	describe("isSafeSourcePath", () => {
		it("일반 문서 허용(.md/.txt, 'secrets.md'·'my.env.notes.md' 같은 문서명도 통과)", () => {
			for (const p of [
				"/ws/docs/a.md",
				"C:/Users/x/docs/note.txt",
				"/home/u/secrets.md",
				"/home/u/my.env.notes.md", // .env 가 파일명 중간 → 정상 문서(오탐 방지)
				"/docs/dev.env.setup.md",
			])
				expect(isSafeSourcePath(p)).toBe(true);
		});
		it("키·인증서·env·ssh·UNC·널바이트 거부", () => {
			for (const p of [
				"/ws/naia-settings/.keys/k.dpapi",
				"/home/u/.ssh/id_rsa",
				"/app/.env",
				"/app/.env.production",
				"C:/certs/server.pem",
				"/x/key.p12",
				"\\\\attacker\\share\\x",
				"//evil/share/y",
				"a\0b",
			])
				expect(isSafeSourcePath(p)).toBe(false);
		});
	});

	it("URL 출처 → 브라우저 navigate + 패널 전환", () => {
		openKnowledgeSource("https://gov.kr/x");
		expect(navigate).toHaveBeenCalledWith("https://gov.kr/x");
		expect(setActiveApp).toHaveBeenCalledWith("browser");
		expect(openFile).not.toHaveBeenCalled();
	});

	it("안전 파일 출처 → workspace openFile(file:// 제거)", () => {
		openKnowledgeSource("file:///ws/docs/a.md");
		expect(openFile).toHaveBeenCalledWith("/ws/docs/a.md");
		expect(setActiveApp).toHaveBeenCalledWith("workspace");
	});

	it("민감 파일 출처(.dpapi 키) → 열지 않음(가드 — 시크릿 노출 차단)", () => {
		openKnowledgeSource("file:///ws/naia-settings/.keys/k.dpapi");
		expect(openFile).not.toHaveBeenCalled();
		expect(setActiveApp).not.toHaveBeenCalled();
	});
});
