import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { getLocale, setLocale, t, type Locale, type TranslationKey } from "../i18n";

const prefix = "hardkoG1a.";
// Keep source order so interchanging two valid keys fails as well as deleting
// a call. Parameter names check the binding supplied by the component.
const expectedCalls: Record<string, readonly string[]> = {
	AdkSetupScreen: [
		"adk.verificationPending",
		"adk.pickFolder",
	],
	AiControlBar: [
		"layout.switchLandscape",
		"layout.switchPortrait",
		"layout.switchLandscape",
		"layout.switchPortrait",
	],
	AppBar: [
		"appBar.removeFailed: error",
		"appBar.removeFailed: error",
		"appBar.webStoreNotice",
		"close",
		"appBar.deleteMode: name",
		"appBar.changeIcon: name",
		"appBar.deleteShortcut",
		"appBar.editDone",
		"appBar.edit",
		"appBar.shortcutIconPlaceholder",
	],
	AppInstallDialog: [
		"install.success: name,id,path",
		"install.addApp",
		"install.zipNotice",
		"install.zipTab",
		"settings.cancel",
		"install.installing",
		"install.install",
		"install.add",
	],
	AppMainContent: [
		"layout.resizeAvatar",
		"layout.resizeAvatar",
		"layout.resizeWorkspace",
		"layout.closeChat",
		"layout.openChat",
		"layout.resizeAvatarChat",
		"layout.leftCompact",
		"layout.leftFill",
		"layout.expandRail",
		"layout.collapseRail",
		"layout.expandRail",
		"layout.collapseRail",
	],
	AtMentionPopover: [
		"mention.loading",
		"mention.noWorkspace",
		"mention.noMatches",
	],
	BgmPlayer: [
		"bgm.youtubePlayingAria",
		"bgm.youtubePlaying: channel",
	],
	CharacterThemeSettings: [
		"card.restored",
		"card.modified",
		"card.modifiedCount: count",
		"card.restore",
		"card.name",
		"card.description",
		"card.personality",
		"card.scenario",
		"card.greeting",
		"card.chooseGreeting",
		"card.customGreeting",
		"card.defaultGreeting: preview",
		"card.alternateGreeting: index,preview",
		"card.alternateGreetingList",
		"card.exampleDialogue",
		"card.lorebookEntries: count",
		"card.newEntryName: index",
		"card.newEntryKeyword",
		"card.newEntryContent",
		"card.addEntry",
		"card.noEntries",
		"card.enableEntry: index",
		"card.entryKeywords: index",
		"card.keywordsPlaceholder",
		"card.entryContent: index",
		"card.systemPrompt",
		"card.postHistory",
		"card.creator",
		"card.notes",
		"card.tags",
		"card.kioskThemeName",
	],
	ChatArea: [
		"chat.webGpuFallback",
		"chat.webGpuFallback",
		"chat.replyRetry",
		"chat.youtubeFailed",
		"chat.youtubeStopped",
		"chat.youtubeResumed: track",
		"chat.youtubeChanged: track",
		"chat.youtubeStarted: track",
		"chat.localRecording: duration",
		"chat.answerSourceAria",
		"chat.answerSource",
		"chat.serverAnswerTitle",
		"chat.serverAnswer",
		"chat.localAnswerAria",
		"chat.localAnswerTitle",
		"chat.localAnswer",
		"chat.localAnswerLive",
		"chat.localAnswerUnavailable",
		"chat.localAnswerActive",
		"chat.localAnswerRequirement",
		"chat.localDownloadAria",
		"chat.localDownloadPrompt",
		"chat.localDownloadConfirm",
		"settings.cancel",
		"chat.dismissNotice",
		"chat.bgmServerFailed",
		"chat.localReply",
		"chat.evidence",
		"chat.voiceSpeaking",
		"chat.voicePreparing",
		"chat.voiceListening",
	],
	DiagnosticsTab: [
		"diagnostics.restart",
		"diagnostics.openNewWindow",
		"diagnostics.viewDetails",
		"close",
	],
	KnowledgeGraphOverlay: [
		"graph.title",
		"graph.summary: nodes,edges,communities",
		"graph.close",
		"graph.nodeDetail: type,count",
		"graph.entity",
		"graph.sources",
		"graph.noSources",
	],
	KnowledgeGraphView: [
		"graph.summary: nodes,edges,communities",
		"graph.nodeHint",
		"graph.show3d",
		"graph.show2d",
	],
	KnowledgeSettingsTab: [
		"graph.manuscripts: count",
		"graph.markdownPreview",
		"graph.open: count",
	],
	OnboardingWizard: [
		"onboarding.personaPlaceholder",
		"onboard.complete.greeting: name",
		"onboarding.guest",
	],
	SkillsTab: [
		"nameKey = skills.knowledge",
		"descriptionKey = skills.knowledgeDescription",
		"nameKey = skills.weather",
		"descriptionKey = skills.weatherDescription",
		"badgeKey = skills.comingSoon",
		"skills.webNotice",
		"skills.desktopNotice",
	],
	TitleBar: [
		"titleBar.hideChat",
		"titleBar.showChat",
		"titleBar.minimize",
		"titleBar.maximize",
		"close",
	],
};

const existingKeys: Readonly<Record<string, readonly string[]>> = {
	AppInstallDialog: ["settings.cancel"],
	ChatArea: ["settings.cancel"],
	DiagnosticsTab: ["diagnostics.restart"],
	OnboardingWizard: ["onboard.complete.greeting"],
};

function parse(relative: string) {
	const url = new URL(relative, import.meta.url);
	return ts.createSourceFile(url.pathname, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
	visit(node);
	node.forEachChild((child) => walk(child, visit));
}

function isTranslationCall(node: ts.Node): node is ts.CallExpression {
	return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t";
}

const hangul = /[가-힣]/;

describe("G1a component translations", () => {
	for (const [component, expected] of Object.entries(expectedCalls)) {
		it(`${component} binds the intended keys in application code`, () => {
			const source = parse(`../../components/${component}.tsx`);
			const actual: string[] = [];
			const koreanLiterals: string[] = [];
			walk(source, (node) => {
				if (
					(ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateLiteralToken(node)) &&
					hangul.test(node.text)
				) {
					koreanLiterals.push(node.text.trim());
				}
				if (isTranslationCall(node)) {
					const [key, params] = node.arguments;
					if (!key || !ts.isStringLiteral(key)) return;
					if (!key.text.startsWith(prefix) && !existingKeys[component]?.includes(key.text)) return;
					const args = params && ts.isObjectLiteralExpression(params)
						? `: ${params.properties.map((prop) => prop.name?.getText(source)).join(",")}`
						: "";
					actual.push(key.text.replace(prefix, "") + args);
				}
				if (
					component === "SkillsTab" &&
					ts.isPropertyAssignment(node) &&
					ts.isStringLiteral(node.initializer) &&
					node.initializer.text.startsWith(prefix)
				) {
					actual.push(`${node.name.getText(source)} = ${node.initializer.text.slice(prefix.length)}`);
				}
			});
			expect(actual).toEqual(expected);
			expect(koreanLiterals).toEqual([]);
		});
	}

	it("resolves built-in skill names, descriptions and badges during render", () => {
		const source = parse("../../components/SkillsTab.tsx");
		const actual: string[] = [];
		walk(source, (node) => {
			if (!ts.isJsxExpression(node) || !node.expression || !isTranslationCall(node.expression)) return;
			const arg = node.expression.arguments[0]?.getText(source);
			if (arg?.startsWith("skill.")) actual.push(arg);
		});
		expect(actual).toEqual(["skill.nameKey", "skill.descriptionKey", 'skill.badgeKey ?? "skills.builtIn"']);
	});

	it("reads the bundled Korean card from fixed data", () => {
		const source = parse("../character-theme.ts");
		const fixedReads: string[] = [];
		walk(source, (node) => {
			if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "JINA_CARD_KO") {
				fixedReads.push(node.name.text);
			}
		});
		expect(fixedReads).toEqual([
			"name", "description", "personality", "scenario", "alternateGreeting",
			"exampleDialogue", "systemPrompt", "postHistory", "creatorNotes", "name",
			"lorebookName", "lorebookDescription", "loreEntryName", "loreEntryComment",
			"name", "guestKeyword", "loreEntryContent", "name", "themeName",
		]);
	});
});

const locales: readonly Locale[] = ["ko", "en", "ja", "zh", "fr", "de", "ru", "es", "ar", "hi", "bn", "pt", "id", "vi"];
const placeholders = (value: string) => Array.from(value.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort();
const keys = [...new Set(Object.values(expectedCalls).flatMap((calls) => calls
	.map((call) => call.split(" = ").at(-1)?.split(": ")[0])
	.filter((key): key is string => Boolean(key && !Object.values(existingKeys).flat().includes(key)))
	.map((key) => `${prefix}${key}` as TranslationKey)))];

describe("G1a locale tables", () => {
	const initialLocale = getLocale();
	afterEach(() => setLocale(initialLocale));

	it("resolves each card key in all 14 locales with the same interpolation parameters", async () => {
		await setLocale("en");
		const english = keys.map((key) => t(key));
		for (const locale of locales) {
			await setLocale(locale);
			for (const [index, key] of keys.entries()) {
				const value = t(key);
				expect(value.trim(), `${locale}: ${key}`).not.toBe("");
				expect(value, `${locale}: ${key}`).not.toBe(key);
				expect(placeholders(value), `${locale}: ${key}`).toEqual(placeholders(english[index]));
			}
		}
	});
});
