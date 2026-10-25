import { Logger } from "../../lib/logger";
import type {
	NormalizedCharacterCard,
	NormalizedLorebookEntry,
} from "./card-parser";
import { charCardText } from "./locales/messages";

const TAG = "CharCardPromptBuilder";

export const DEFAULT_PROMPT_CHAR_BUDGET = 24_000;

export interface BuildRoleplayPromptOptions {
	userName?: string;
	selectedGreeting?: string;
	locale?: string;
	maxChars?: number;
}

export type TruncatedPart =
	| "lorebook_triggered"
	| "lorebook_constant"
	| "mes_example"
	| "long_fields";

export interface RoleplayContextPayload {
	type: "charcard";
	data: {
		roleplay: string;
		character: string;
		user: string;
		greeting: string;
		specVersion: string;
		truncated: boolean;
		truncatedParts: TruncatedPart[];
	};
}

export interface BuildRoleplayPromptResult {
	context: RoleplayContextPayload;
	roleplay: string;
	character: string;
	user: string;
	greeting: string;
	truncated: boolean;
	truncatedParts: TruncatedPart[];
}

export function replaceCardMacros(
	text: string,
	charName: string,
	userName: string,
): string {
	if (!text) return "";
	return text
		.replace(/\{\{\s*char\s*\}\}/gi, charName)
		.replace(/<\s*bot\s*>/gi, charName)
		.replace(/\{\{\s*user\s*\}\}/gi, userName)
		.replace(/<\s*user\s*>/gi, userName);
}

export function splitMesExamples(
	mesExample: string,
	charName: string,
	userName: string,
): string[] {
	const replaced = replaceCardMacros(mesExample, charName, userName).trim();
	if (!replaced) return [];
	return replaced
		.split(/<\s*START\s*>/gi)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

export function sortActiveLorebookEntries(
	entries: readonly NormalizedLorebookEntry[],
): {
	constantEntries: NormalizedLorebookEntry[];
	triggeredEntries: NormalizedLorebookEntry[];
} {
	const enabled = entries.filter(
		(entry) => entry.enabled && entry.content.trim().length > 0,
	);
	const compareOrder = (
		a: NormalizedLorebookEntry,
		b: NormalizedLorebookEntry,
	): number => {
		if (a.insertion_order !== b.insertion_order) {
			return a.insertion_order - b.insertion_order;
		}
		if (a.priority !== b.priority) {
			return b.priority - a.priority;
		}
		return 0;
	};
	const constantEntries = enabled
		.filter((entry) => entry.constant)
		.sort(compareOrder);
	const triggeredEntries = enabled
		.filter((entry) => !entry.constant)
		.sort(compareOrder);
	return { constantEntries, triggeredEntries };
}

function buildCoreBody(
	description: string,
	personality: string,
	scenario: string,
): string {
	const blocks: string[] = [];
	if (description.trim()) {
		blocks.push(`[Character Description]\n${description.trim()}`);
	}
	if (personality.trim()) {
		blocks.push(`[Personality]\n${personality.trim()}`);
	}
	if (scenario.trim()) {
		blocks.push(`[Scenario]\n${scenario.trim()}`);
	}
	return blocks.join("\n\n");
}

function formatConstantLoreEntry(
	entry: NormalizedLorebookEntry,
	charName: string,
	userName: string,
): string {
	const title = entry.name.trim() || entry.comment.trim();
	const content = replaceCardMacros(entry.content.trim(), charName, userName);
	return title ? `- (${title}) ${content}` : `- ${content}`;
}

function formatTriggeredLoreEntry(
	entry: NormalizedLorebookEntry,
	charName: string,
	userName: string,
): string {
	const allKeys = [...entry.keys, ...entry.secondary_keys]
		.map((k) => replaceCardMacros(k.trim(), charName, userName))
		.filter((k) => k.length > 0);
	const keyLabel =
		allKeys.length > 0 ? allKeys.join(", ") : entry.name || "keyword";
	const content = replaceCardMacros(entry.content.trim(), charName, userName);
	return `- Keywords [${keyLabel}]: ${content}`;
}

function clipText(value: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (value.length <= maxLen) return value;
	if (maxLen <= 1) return value.slice(0, maxLen);
	return `${value.slice(0, maxLen - 1)}…`;
}

export function buildRoleplayPrompt(
	card: NormalizedCharacterCard,
	options: BuildRoleplayPromptOptions = {},
): BuildRoleplayPromptResult {
	const maxChars = Math.max(
		512,
		options.maxChars ?? DEFAULT_PROMPT_CHAR_BUDGET,
	);
	const charName = card.name.trim() || "Character";
	const defaultUser = charCardText(
		"charcard.defaultUserName",
		undefined,
		options.locale ?? "ko",
	);
	const userName = (options.userName ?? "").trim() || defaultUser;

	Logger.debug(TAG, "building roleplay prompt", {
		character: charName,
		maxChars,
	});

	let description = replaceCardMacros(
		card.description,
		charName,
		userName,
	).trim();
	let personality = replaceCardMacros(
		card.personality,
		charName,
		userName,
	).trim();
	let scenario = replaceCardMacros(card.scenario, charName, userName).trim();
	let systemPromptRaw = replaceCardMacros(
		card.system_prompt,
		charName,
		userName,
	).trim();
	let postHistory = replaceCardMacros(
		card.post_history_instructions,
		charName,
		userName,
	).trim();

	const rawGreeting =
		options.selectedGreeting !== undefined
			? options.selectedGreeting
			: card.first_mes;
	let greeting = replaceCardMacros(rawGreeting, charName, userName).trim();

	const examples = splitMesExamples(card.mes_example, charName, userName);

	const { constantEntries, triggeredEntries } = sortActiveLorebookEntries(
		card.character_book.entries,
	);
	const constantLoreLines = constantEntries.map((entry) =>
		formatConstantLoreEntry(entry, charName, userName),
	);
	const triggeredLoreLines = triggeredEntries.map((entry) =>
		formatTriggeredLoreEntry(entry, charName, userName),
	);

	const truncatedParts: TruncatedPart[] = [];
	const markTruncated = (part: TruncatedPart) => {
		if (!truncatedParts.includes(part)) {
			truncatedParts.push(part);
		}
	};

	const roleplayHeader = [
		`[Character Roleplay Mode: ${charName}]`,
		`Until the user ends roleplay in this app, you are roleplaying as "${charName}".`,
		`Stay in character as "${charName}", follow the character's name, speech style, personality, and world settings, and do NOT introduce yourself as Naia.`,
		`The user's name in this roleplay is "${userName}".`,
	].join("\n");

	const assemblePrompt = (): string => {
		const sections: string[] = [roleplayHeader];
		const coreBody = buildCoreBody(description, personality, scenario);

		if (systemPromptRaw) {
			if (/\{\{\s*original\s*\}\}/i.test(systemPromptRaw)) {
				const merged = systemPromptRaw.replace(
					/\{\{\s*original\s*\}\}/gi,
					coreBody,
				);
				sections.push(`[System Prompt]\n${merged.trim()}`);
			} else {
				sections.push(`[System Prompt]\n${systemPromptRaw}`);
				if (coreBody) {
					sections.push(coreBody);
				}
			}
		} else if (coreBody) {
			sections.push(coreBody);
		}

		if (constantLoreLines.length > 0) {
			sections.push(
				`[World Info — Always Active]\n${constantLoreLines.join("\n")}`,
			);
		}

		if (triggeredLoreLines.length > 0) {
			sections.push(
				`[World Info — Keyword Triggered (apply when these keywords appear in conversation)]\n${triggeredLoreLines.join("\n")}`,
			);
		}

		if (examples.length > 0) {
			const formattedExamples = examples
				.map((ex, idx) => `Example ${idx + 1}:\n${ex}`)
				.join("\n\n");
			sections.push(`[Dialogue Examples]\n${formattedExamples}`);
		}

		if (greeting) {
			sections.push(
				`[Opening Greeting — You have already started the conversation with this message]\n${greeting}`,
			);
		}

		if (postHistory) {
			sections.push(
				`[Post-History Instructions — Always follow when replying]\n${postHistory}`,
			);
		}

		return sections.join("\n\n");
	};

	let prompt = assemblePrompt();

	// 1. Trim non-constant (triggered) lorebook entries from the end
	while (prompt.length > maxChars && triggeredLoreLines.length > 0) {
		triggeredLoreLines.pop();
		markTruncated("lorebook_triggered");
		prompt = assemblePrompt();
	}

	// 1b. If still over budget and constant lorebook entries exist, trim from the end
	while (prompt.length > maxChars && constantLoreLines.length > 0) {
		constantLoreLines.pop();
		markTruncated("lorebook_constant");
		prompt = assemblePrompt();
	}

	// 2. Trim dialogue examples from the end
	while (prompt.length > maxChars && examples.length > 0) {
		examples.pop();
		markTruncated("mes_example");
		prompt = assemblePrompt();
	}

	// 3. Trim long fields (description, scenario, personality, systemPromptRaw, greeting, postHistory)
	if (prompt.length > maxChars) {
		markTruncated("long_fields");
		const fields = [
			{
				get: () => description,
				set: (v: string) => {
					description = v;
				},
			},
			{
				get: () => scenario,
				set: (v: string) => {
					scenario = v;
				},
			},
			{
				get: () => personality,
				set: (v: string) => {
					personality = v;
				},
			},
			{
				get: () => systemPromptRaw,
				set: (v: string) => {
					systemPromptRaw = v;
				},
			},
			{
				get: () => greeting,
				set: (v: string) => {
					greeting = v;
				},
			},
			{
				get: () => postHistory,
				set: (v: string) => {
					postHistory = v;
				},
			},
		];

		// Iteratively shorten the longest field until within budget
		for (let guard = 0; guard < 24 && prompt.length > maxChars; guard++) {
			const excess = prompt.length - maxChars;
			let longest = fields[0];
			for (const f of fields) {
				if (f.get().length > longest.get().length) {
					longest = f;
				}
			}
			const currentVal = longest.get();
			if (currentVal.length <= 64) break;
			const targetLen = Math.max(64, currentVal.length - excess - 16);
			longest.set(clipText(currentVal, targetLen));
			prompt = assemblePrompt();
		}

		if (prompt.length > maxChars) {
			prompt = clipText(prompt, maxChars);
		}
	}

	const truncated = truncatedParts.length > 0;
	const context: RoleplayContextPayload = {
		type: "charcard",
		data: {
			roleplay: prompt,
			character: charName,
			user: userName,
			greeting,
			specVersion: card.specVersion,
			truncated,
			truncatedParts,
		},
	};

	return {
		context,
		roleplay: prompt,
		character: charName,
		user: userName,
		greeting,
		truncated,
		truncatedParts,
	};
}
