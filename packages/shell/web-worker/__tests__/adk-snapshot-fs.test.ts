import { describe, expect, it, vi } from "vitest";
import rawIrPublicDeck from "../../src/lib/kiosk-demo/slides/ir-public.json";
import {
	type AdkSnapshot,
	type DirLike,
	EMPTY_ADK_SNAPSHOT,
	type FileLike,
	buildKioskSystemPromptFromSnapshot,
	extractActiveSlideFromChatRequest,
	makeSnapshotFs,
	readAdkSnapshot,
} from "../adk-snapshot-fs";
import { makeOpenAICompatProvider } from "../openai-compat-provider";

class MockNotFoundError extends DOMException {
	constructor(message = "Not found") {
		super(message, "NotFoundError");
	}
}

describe("adk-snapshot-fs", () => {
	describe("readAdkSnapshot", () => {
		it("reads full snapshot when all entries exist", async () => {
			const mockConfigFile: FileLike = {
				async getFile() {
					return {
						async text() {
							return JSON.stringify({ agentName: "루미" });
						},
					};
				},
			};

			const mockSettingsDir: DirLike = {
				async getDirectoryHandle() {
					throw new MockNotFoundError();
				},
				async getFileHandle(name: string) {
					if (name === "config.json") return mockConfigFile;
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const mockProjectsDir: DirLike = {
				async getDirectoryHandle() {
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {
					yield { kind: "directory", name: "naia-template-project" };
					yield { kind: "file", name: "README.md" };
				},
			};

			const mockAdkDir: DirLike = {
				async getDirectoryHandle(name: string) {
					if (name === "naia-settings") return mockSettingsDir;
					if (name === "projects") return mockProjectsDir;
					throw new MockNotFoundError();
				},
				async getFileHandle(name: string) {
					if (name === "AGENTS.md" || name === "CLAUDE.md") {
						return {
							async getFile() {
								return { async text() { return ""; } };
							},
						};
					}
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const mockRoot: DirLike = {
				async getDirectoryHandle(name: string) {
					if (name === "naia-adk") return mockAdkDir;
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const snapshot = await readAdkSnapshot(() => Promise.resolve(mockRoot));

			expect(snapshot.configText).toBe(JSON.stringify({ agentName: "루미" }));
			expect(snapshot.rootFiles.has("AGENTS.md")).toBe(true);
			expect(snapshot.rootFiles.has("CLAUDE.md")).toBe(true);
			expect(snapshot.projects).toEqual([
				{ name: "naia-template-project", isDir: true },
				{ name: "README.md", isDir: false },
			]);
		});

		it("returns EMPTY_ADK_SNAPSHOT when naia-adk directory does not exist", async () => {
			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const snapshot = await readAdkSnapshot(() => Promise.resolve(mockRoot));
			expect(snapshot).toEqual(EMPTY_ADK_SNAPSHOT);
		});

		it("returns null projects when projects directory does not exist", async () => {
			const mockAdkDir: DirLike = {
				async getDirectoryHandle(name: string) {
					if (name === "projects") throw new MockNotFoundError();
					if (name === "naia-settings") {
						return {
							async getDirectoryHandle() { throw new MockNotFoundError(); },
							async getFileHandle(f: string) {
								if (f === "config.json") {
									return { getFile: async () => ({ text: async () => "{}" }) };
								}
								throw new MockNotFoundError();
							},
							async *values() {},
						};
					}
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					return mockAdkDir;
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const snapshot = await readAdkSnapshot(() => Promise.resolve(mockRoot));
			expect(snapshot.projects).toBeNull();
			expect(snapshot.configText).toBe("{}");
		});

		it("returns null configText when config.json does not exist", async () => {
			const mockSettingsDir: DirLike = {
				async getDirectoryHandle() { throw new MockNotFoundError(); },
				async getFileHandle() { throw new MockNotFoundError(); },
				async *values() {},
			};

			const mockAdkDir: DirLike = {
				async getDirectoryHandle(name: string) {
					if (name === "naia-settings") return mockSettingsDir;
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					return mockAdkDir;
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const snapshot = await readAdkSnapshot(() => Promise.resolve(mockRoot));
			expect(snapshot.configText).toBeNull();
		});

		it("rethrows non-NotFoundError error", async () => {
			const diskError = new Error("Disk hardware failure");
			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					throw diskError;
				},
				async getFileHandle() {
					throw diskError;
				},
				async *values() {},
			};

			await expect(readAdkSnapshot(() => Promise.resolve(mockRoot))).rejects.toThrow(
				"Disk hardware failure",
			);
		});

		it("rejects readAdkSnapshot when error name is Error and message is NotFoundError", async () => {
			const genericError = new Error("NotFoundError");
			expect(genericError.name).toBe("Error");
			expect(genericError.message).toBe("NotFoundError");

			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					throw genericError;
				},
				async getFileHandle() {
					throw genericError;
				},
				async *values() {},
			};

			await expect(
				readAdkSnapshot(() => Promise.resolve(mockRoot)),
			).rejects.toThrow(genericError);
		});

		it("rejects readAdkSnapshot when error name is Error and message is TypeMismatchError", async () => {
			const genericError = new Error("TypeMismatchError");
			expect(genericError.name).toBe("Error");
			expect(genericError.message).toBe("TypeMismatchError");

			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					throw genericError;
				},
				async getFileHandle() {
					throw genericError;
				},
				async *values() {},
			};

			await expect(
				readAdkSnapshot(() => Promise.resolve(mockRoot)),
			).rejects.toThrow(genericError);
		});
	});

	describe("makeSnapshotFs", () => {
		const fullSnapshot: AdkSnapshot = {
			configText: '{"agentName":"루미"}',
			rootFiles: new Set(["AGENTS.md", "CLAUDE.md"]),
			projects: [
				{ name: "naia-template-project", isDir: true },
				{ name: "notes.txt", isDir: false },
			],
		};

		it("answers existsSync, readFileSync, readdirSync for known paths according to snapshot", () => {
			const fs = makeSnapshotFs(() => fullSnapshot);

			// config.json
			expect(fs.existsSync("opfs://naia-adk/naia-settings/config.json")).toBe(true);
			expect(fs.readFileSync("opfs://naia-adk/naia-settings/config.json", "utf8")).toBe(
				'{"agentName":"루미"}',
			);

			// AGENTS.md and CLAUDE.md
			expect(fs.existsSync("opfs://naia-adk/AGENTS.md")).toBe(true);
			expect(fs.existsSync("opfs://naia-adk/CLAUDE.md")).toBe(true);
			expect(() => fs.readFileSync("opfs://naia-adk/AGENTS.md", "utf8")).toThrow();
			expect(() => fs.readFileSync("opfs://naia-adk/CLAUDE.md", "utf8")).toThrow();

			// projects
			expect(fs.existsSync("opfs://naia-adk/projects")).toBe(true);
			const dirents = fs.readdirSync("opfs://naia-adk/projects", { withFileTypes: true });
			expect(dirents).toHaveLength(2);
			expect(dirents[0].name).toBe("naia-template-project");
			expect(dirents[0].isDirectory()).toBe(true);
			expect(dirents[1].name).toBe("notes.txt");
			expect(dirents[1].isDirectory()).toBe(false);
		});

		it("returns false for existsSync and throws for readFileSync/readdirSync on unknown paths", () => {
			const fs = makeSnapshotFs(() => fullSnapshot);

			expect(fs.existsSync("opfs://naia-adk/unknown.txt")).toBe(false);
			expect(fs.existsSync("opfs://naia-adk/other-dir")).toBe(false);
			expect(fs.existsSync("/local/path")).toBe(false);

			expect(() => fs.readFileSync("opfs://naia-adk/unknown.txt", "utf8")).toThrow("ENOENT");
			expect(() =>
				fs.readdirSync("opfs://naia-adk/unknown-dir", { withFileTypes: true }),
			).toThrow("ENOENT");
		});

		it("returns false for existsSync and throws on missing snapshot entries", () => {
			const emptyFs = makeSnapshotFs(() => EMPTY_ADK_SNAPSHOT);

			expect(emptyFs.existsSync("opfs://naia-adk/naia-settings/config.json")).toBe(false);
			expect(emptyFs.existsSync("opfs://naia-adk/AGENTS.md")).toBe(false);
			expect(emptyFs.existsSync("opfs://naia-adk/CLAUDE.md")).toBe(false);
			expect(emptyFs.existsSync("opfs://naia-adk/projects")).toBe(false);

			expect(() =>
				emptyFs.readFileSync("opfs://naia-adk/naia-settings/config.json", "utf8"),
			).toThrow("ENOENT");
			expect(() =>
				emptyFs.readdirSync("opfs://naia-adk/projects", { withFileTypes: true }),
			).toThrow("ENOENT");
		});

		it("builds kiosk system prompt in order: AGENTS.md rules -> character card persona -> response-rules -> knowledge", () => {
			const prompt = buildKioskSystemPromptFromSnapshot(
				{
					...EMPTY_ADK_SNAPSHOT,
					agentsText:
						"# AGENTS.md\n지금 캐릭터는 페르소나 설정(캐릭터 카드)을 따른다.",
					configText: JSON.stringify({
						agentName: "지나",
						persona: "[Character Roleplay Mode: 지나]\n고친 성격 지침",
						personaDisabled: false,
					}),
					rulesText: "# 응답 규칙",
				},
				"기본 접두사",
			);
			expect(prompt).toContain("기본 접두사");
			expect(prompt).toContain(
				"지금 캐릭터는 페르소나 설정(캐릭터 카드)을 따른다.",
			);
			expect(prompt).toContain("[Character Roleplay Mode: 지나]\n고친 성격 지침");
			expect(prompt).toContain("# 응답 규칙");
			expect(prompt).toContain("skill_knowledge_search");
			expect(prompt.indexOf("# AGENTS.md")).toBeLessThan(
				prompt.indexOf("[Character Roleplay Mode: 지나]"),
			);
			expect(
				prompt.indexOf("[Character Roleplay Mode: 지나]"),
			).toBeLessThan(prompt.indexOf("# 응답 규칙"));
		});

		it("injects active slide body, speaker script, and rules into the actual model messages for diverse slide questions while suppressing general KB search instructions", async () => {
			const slide2 = rawIrPublicDeck.slides[1]!;
			const buildSlidePrompt = (question: string) =>
				[
					`[현재 발표 중인 슬라이드: ${slide2.page}장 — ${slide2.title} (${slide2.subtitle})]`,
					`장 원고 파일: knowledge/${slide2.source}`,
					`장 본문 요점:\n${slide2.bullets.map((b) => `- ${b}`).join("\n")}`,
					`장 발표문:\n${slide2.script}`,
					`규칙:`,
					`1. 발표 중간 질문에는 반드시 지금 보고 있는 ${slide2.page}장('${slide2.title}')의 장 본문 요점과 장 발표문에 적힌 내용만으로 답하세요.`,
					`5. 근거 파일은 오직 knowledge/${slide2.source} 하나만 사용하세요.`,
					`사용자 질문: ${question}`,
				].join("\n");
			const questions = [
				"방금 장에서 핵심 지표가 뭐예요?",
				"이 장에서 노바는 뭐예요?",
				"방금 장 요약해 줘",
				"가격은 얼마예요?",
			];

			for (const question of questions) {
				const rawChatRequest = JSON.stringify({
					type: "chat_request",
					requestId: `req-${question}`,
					message: question,
					environmentSegments: [
						{
							kind: "app",
							entries: [
								{
									type: "Active IR Slide Context",
									data: {
										page: slide2.page,
										title: slide2.title,
										subtitle: slide2.subtitle,
										source: slide2.source,
										bullets: slide2.bullets,
										script: slide2.script,
										instructions: buildSlidePrompt(question),
									},
								},
							],
						},
					],
				});

				const activeSlide = extractActiveSlideFromChatRequest(rawChatRequest);
				expect(activeSlide).not.toBeNull();
				expect(activeSlide?.page).toBe(2);
				expect(activeSlide?.source).toBe("brand.md");
				expect(activeSlide?.bullets).toEqual(slide2.bullets);
				expect(activeSlide?.script).toBe(slide2.script);

				const systemPrompt = buildKioskSystemPromptFromSnapshot(
					{
						...EMPTY_ADK_SNAPSHOT,
						agentsText: "# AGENTS.md — 지나 ADK",
						personaText: "# 지나 페르소나",
						rulesText: "# 응답 규칙",
					},
					"기본 접두사",
					activeSlide,
				);

				expect(systemPrompt).toContain(
					"[현재 발표 중인 슬라이드: 2장 — 브랜드 체계: 나이아와 별자리 모델 이름 (Brand & Naming Universe)]",
				);
				expect(systemPrompt).toContain("장 원고 파일: knowledge/brand.md");
				expect(systemPrompt).toContain(
					"별자리 코드명: 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성)",
				);
				expect(systemPrompt).toContain(slide2.script);
				expect(systemPrompt).toContain(`사용자 질문: ${question}`);
				expect(systemPrompt).not.toContain("skill_knowledge_search");

				const capturedBodies: Array<{
					messages: Array<{ role: string; content: string }>;
				}> = [];
				const fetcher = vi.fn().mockImplementation(async (_url, init) => {
					const parsedBody = JSON.parse(init.body) as {
						messages: Array<{ role: string; content: string }>;
					};
					capturedBodies.push(parsedBody);
					const sys = parsedBody.messages[0]?.content ?? "";
					const usr = parsedBody.messages.at(-1)?.content ?? "";
					let replyText = "";
					if (usr.includes("핵심 지표") && !sys.includes("핵심 지표:")) {
						replyText =
							"게스트님, 이 장에는 핵심 지표가 없어요. 지금 보고 계신 2장 '브랜드 체계: 나이아와 별자리 모델 이름'에서는 물의 요정 나이아드에서 온 나이아(Naia)의 의미와 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성) 별자리 모델 체계를 안내하고 있어요.";
					} else if (usr.includes("노바")) {
						replyText =
							"이 장에서 노바(신성)는 나이아의 자체 별자리 모델 라인업(루나·테라·솔·스텔라·노바) 가운데 하나로, 용도와 추론 깊이에 따라 직관적인 천체 이름으로 구분한 모델 이름이에요.";
					} else if (usr.includes("요약")) {
						replyText =
							"방금 보신 2장 '브랜드 체계: 나이아와 별자리 모델 이름'은 물의 요정 나이아드에서 유래한 비주얼 에이전트 브랜드 '나이아(Naia)'와 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성)으로 이어지는 천체 기반 모델 이름 체계를 소개하는 장이에요.";
					} else if (usr.includes("가격")) {
						replyText =
							"게스트님, 이 장에는 가격 내용이 없어요. 지금 보고 계신 2장에서는 비주얼 에이전트 나이아(Naia) 브랜드 유래와 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성) 모델 이름 체계를 안내하고 있어요.";
					}
					const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: replyText } }] })}\n\ndata: [DONE]\n\n`;
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						body: new ReadableStream({
							start(c) {
								c.enqueue(new TextEncoder().encode(sse));
								c.close();
							},
						}),
					};
				});

				const provider = makeOpenAICompatProvider({
					baseUrl: "https://gateway.test/v1",
					apiKey: "test-key",
					auth: "x-anyllm",
					fetch: fetcher,
				});
				const chunks: string[] = [];
				for await (const chunk of provider.chat(
					{ provider: "nextain", model: "gpt-5.6-luna" },
					[{ role: "user", content: question }],
					{ systemPrompt },
				)) {
					if (chunk.kind === "text") chunks.push(chunk.text);
				}

				expect(capturedBodies).toHaveLength(1);
				const wireMessages = capturedBodies[0]!.messages;
				expect(wireMessages[0]?.role).toBe("system");
				expect(wireMessages[0]?.content).toContain(
					"별자리 코드명: 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성)",
				);
				expect(wireMessages[0]?.content).toContain(slide2.script);
				expect(wireMessages[0]?.content).toContain(
					"근거 파일은 오직 knowledge/brand.md 하나만 사용하세요.",
				);
				expect(wireMessages[1]).toEqual({ role: "user", content: question });

				const answer = chunks.join("");
				expect(answer).toContain("루나");
				expect(answer).toContain("노바");
				expect(answer).not.toContain("안드로메다");
				expect(answer).not.toContain("카시오페아");
				expect(answer).not.toContain("센타우루스");
			}
		});
	});
});
