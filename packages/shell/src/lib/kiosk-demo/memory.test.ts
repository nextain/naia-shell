import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeCommand } from "../web-runtime/router";
import {
	type WebFsDirectoryHandle,
	createOpfsWebFs,
	setWebFsForTests,
} from "../web-runtime/web-fs";
import { isKioskDemo } from "./flag";
import {
	KIOSK_GUEST_MEMORY_MD_PATH,
	createKioskMemory,
	handleKioskMemoryCommand,
	resetKioskMemory,
} from "./memory";

// Existing WebFs OPFS harness pattern: handles survive new filesystem/agent instances.
function storage() {
	const files = new Map<string, string>();
	const dirs = new Set([""]);
	function dir(path: string): WebFsDirectoryHandle {
		return {
			async getDirectoryHandle(name, opts) {
				const p = `${path}${name}/`;
				if (!dirs.has(p) && !opts?.create)
					throw new DOMException("missing", "NotFoundError");
				dirs.add(p);
				return dir(p);
			},
			async getFileHandle(name, opts) {
				const p = path + name;
				if (!files.has(p) && !opts?.create)
					throw new DOMException("missing", "NotFoundError");
				return {
					async getFile() {
						return {
							async text() {
								return files.get(p) ?? "";
							},
						};
					},
					async createWritable() {
						let pending = "";
						return {
							async write(data) {
								pending = typeof data === "string" ? data : await data.text();
							},
							async close() {
								files.set(p, pending);
							},
						};
					},
				};
			},
			async removeEntry(name) {
				files.delete(path + name);
			},
		};
	}
	return { reopen: () => createOpfsWebFs(async () => dir("")), files };
}

beforeEach(() => {
	vi.stubEnv("MODE", "web");
	vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
});
afterEach(() => {
	setWebFsForTests(null);
	vi.unstubAllEnvs();
});

describe("S2 kiosk browser memory", () => {
	it("persists guest honorific, explicit facts only, and conversation episodes across OPFS reload without writing UUIDs to markdown", async () => {
		const disk = storage();
		const first = createKioskMemory(disk.reopen());
		expect((await first.recall("안녕")).facts).toEqual([
			"사용자 호칭은 게스트님이다.",
		]);
		await first.save(
			"저는 로봇에 관심이 있어요",
			"사용자는 부산에 살아요 (추측)",
		);
		await first.save(
			"내 이름은 김민호야 기억해 줘",
			"네, 김민호님으로 기억하겠습니다.",
		);
		const reloaded = createKioskMemory(disk.reopen());
		const recalled = await reloaded.recall("제 관심사와 이름이 뭐였죠?");
		expect(recalled.facts).toEqual([
			"사용자 호칭은 게스트님이다.",
			"내 이름은 김민호야",
		]);
		expect(recalled.facts).not.toContain("저는 로봇에 관심이 있어요");
		expect(recalled.facts.join("\n")).not.toContain("부산");
		expect(recalled.episodes).toEqual([
			expect.objectContaining({
				role: "user",
				content: "저는 로봇에 관심이 있어요",
			}),
			expect.objectContaining({
				role: "assistant",
				content: "사용자는 부산에 살아요 (추측)",
			}),
			expect.objectContaining({
				role: "user",
				content: "내 이름은 김민호야 기억해 줘",
			}),
			expect.objectContaining({
				role: "assistant",
				content: "네, 김민호님으로 기억하겠습니다.",
			}),
		]);
		const md = disk.files.get(KIOSK_GUEST_MEMORY_MD_PATH) ?? "";
		expect(md).toContain("- 사용자 호칭은 게스트님이다.");
		expect(md).toContain("- 내 이름은 김민호야");
		expect(md).not.toMatch(/- \[[^\]]+\]/);
	});

	it("opens all four commands only in kiosk, encrypts backups and rejects wrong passwords/tampering atomically", async () => {
		const fs = storage().reopen();
		setWebFsForTests(fs);
		const memory = createKioskMemory(fs);
		await memory.save("저는 개발자예요 기억해 줘", "확인");
		const facts = (await routeCommand("memory_get_all_facts")) as {
			id: string;
			content: string;
		}[];
		const blob = (await routeCommand("memory_export_backup", {
			password: "test-only-password",
		})) as number[];
		expect(new TextDecoder().decode(new Uint8Array(blob))).not.toContain(
			"개발자",
		);
		expect(blob.slice(0, 5)).toEqual([78, 65, 73, 65, 1]);
		const id = facts.find((f) => f.content.includes("개발자"))?.id;
		expect(await routeCommand("memory_delete_fact", { factId: id })).toBe(true);
		expect(JSON.stringify(await memory.recall("직업"))).not.toContain("개발자");
		await routeCommand("memory_import_backup", {
			blob,
			password: "test-only-password",
		});
		expect(
			JSON.stringify(await createKioskMemory(fs).recall("직업")),
		).toContain("개발자");
		const before = await routeCommand("memory_get_all_facts");
		await expect(
			routeCommand("memory_import_backup", { blob, password: "wrong" }),
		).rejects.toThrow();
		const corrupt = [...blob];
		corrupt[corrupt.length - 1] ^= 1;
		await expect(
			routeCommand("memory_import_backup", {
				blob: corrupt,
				password: "test-only-password",
			}),
		).rejects.toThrow();
		expect(await routeCommand("memory_get_all_facts")).toEqual(before);
		await expect(
			routeCommand("memory_export_backup", { password: "" }),
		).rejects.toThrow("Password");
	});

	it("reset leaves only guest and fences a previous visitor's delayed save", async () => {
		const disk = storage();
		const fs = disk.reopen();
		const old = createKioskMemory(fs);
		await old.recall("첫 투자자");
		await old.save("저는 로봇 투자자예요 기억해 줘", "확인");
		await resetKioskMemory(disk.reopen());
		await old.save("내 이름은 이전방문자야 기억해 줘", "확인");
		const next = createKioskMemory(disk.reopen());
		expect((await next.recall("안녕")).facts).toEqual([
			"사용자 호칭은 게스트님이다.",
		]);
		await next.save("내 이름은 새방문자야", "확인");
		expect((await next.recall("새 방문자")).facts).toContain(
			"내 이름은 새방문자야",
		);
	});

	it("serializes concurrent saves without lost updates", async () => {
		const fs = storage().reopen();
		const memory = createKioskMemory(fs);
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				memory.save(`사용자 사실 ${i} 기억해 줘`, "답"),
			),
		);
		expect(
			await handleKioskMemoryCommand("memory_get_all_facts", undefined, fs),
		).toHaveLength(11);
	});

	it("flag off preserves all desktop-only errors and reset performs no writes", async () => {
		const disk = storage();
		const fs = disk.reopen();
		setWebFsForTests(fs);
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		for (const cmd of [
			"memory_get_all_facts",
			"memory_export_backup",
			"memory_import_backup",
			"memory_delete_fact",
		]) {
			await expect(routeCommand(cmd)).rejects.toThrow(`desktop_only:${cmd}`);
		}
		await resetKioskMemory(fs);
		await expect(createKioskMemory(fs).save("저장 금지", "답")).rejects.toThrow(
			"kiosk_memory_disabled",
		);
		expect(disk.files.size).toBe(0);
	});

	it.runIf(Boolean(process.env.NAIA_WEB_AGENT_DIR))(
		"actual desktop handler saves a turn and injects recalled facts after reload",
		async () => {
			const agentDir = process.env.NAIA_WEB_AGENT_DIR;
			const { wireAgentUC1 } = await import(
				/* @vite-ignore */ `${agentDir}/src/main/composition/uc1-wiring.ts`
			);
			const disk = storage();
			const prompts: string[] = [];
			const provider = {
				async *chat(
					_config: unknown,
					_messages: unknown,
					opts: { systemPrompt?: string },
				) {
					prompts.push(opts.systemPrompt ?? "");
					yield { kind: "text", text: "알겠습니다, 게스트님." };
					yield { kind: "finish" };
				},
			};
			function freshAgent() {
				return wireAgentUC1({
					provider,
					memory: createKioskMemory(disk.reopen()),
					diag: { log() {} },
					egress: { emit() {} },
				});
			}
			await freshAgent().handler.onChatRequest({
				kind: "chat",
				requestId: "first",
				provider: { provider: "ollama", model: "test" },
				messages: [{ role: "user", content: "저는 로봇에 투자합니다 기억해 줘" }],
				enableTools: false,
			});
			await freshAgent().handler.onChatRequest({
				kind: "chat",
				requestId: "after-reload",
				provider: { provider: "ollama", model: "test" },
				messages: [{ role: "user", content: "저에 대해 기억하나요?" }],
				enableTools: false,
			});
			expect(prompts).toHaveLength(2);
			expect(prompts[1]).toContain("게스트님");
			expect(prompts[1]).toContain("저는 로봇에 투자합니다");
			expect(prompts[1]).toContain("회상된 참고 정보");
		},
	);

	it("desktop mode never enables kiosk even when env flag is 1", () => {
		vi.stubEnv("MODE", "development");
		expect(isKioskDemo()).toBe(false);
	});
});
