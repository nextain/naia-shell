import { Logger } from "../../lib/logger";
import type {
	NormalizedCharacterCard,
	NormalizedLorebookEntry,
} from "./card-parser";
import { charCardText } from "./locales/messages";

const TAG = "CharCardPromptBuilder";

export const DEFAULT_PROMPT_CHAR_BUDGET = 24_000;
export const MAX_SERIALIZED_CONTEXT_CHARS = 32_000;
export const MAX_NAME_CHARS = 200;
export const MAX_FIELD_INPUT_CHARS = 48_000;

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

const MACRO_PATTERN =
	/\{\{\s*char\s*\}\}|<\s*bot\s*>|\{\{\s*user\s*\}\}|<\s*user\s*>/gi;

export function replaceCardMacros(
	text: string,
	charName: string,
	userName: string,
	maxOutputChars = MAX_FIELD_INPUT_CHARS,
): string {
	if (!text) return "";
	const boundedInput =
		text.length > maxOutputChars ? text.slice(0, maxOutputChars) : text;
	const safeChar =
		charName.length > MAX_NAME_CHARS
			? charName.slice(0, MAX_NAME_CHARS)
			: charName;
	const safeUser =
		userName.length > MAX_NAME_CHARS
			? userName.slice(0, MAX_NAME_CHARS)
			: userName;
	const replaced = boundedInput.replace(MACRO_PATTERN, (match) => {
		const lower = match.toLowerCase();
		if (lower.includes("char") || lower.includes("bot")) {
			return safeChar;
		}
		return safeUser;
	});
	return replaced.length > maxOutputChars
		? replaced.slice(0, maxOutputChars)
		: replaced;
}

export function measureSerializedContextLength(
	context: RoleplayContextPayload,
): number {
	return JSON.stringify({ type: context.type, data: context.data }).length;
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
	const rawCharName = card.name.trim() || "Character";
	const charName = clipText(rawCharName, MAX_NAME_CHARS);
	const defaultUser = charCardText(
		"charcard.defaultUserName",
		undefined,
		options.locale ?? "ko",
	);
	const rawUserName = (options.userName ?? "").trim() || defaultUser;
	const userName = clipText(rawUserName, MAX_NAME_CHARS);

	Logger.debug(TAG, "building roleplay prompt", {
		character: charName,
		maxChars,
	});

	const fieldCap = Math.min(MAX_FIELD_INPUT_CHARS, maxChars);

	let description = replaceCardMacros(
		card.description,
		charName,
		userName,
		fieldCap,
	).trim();
	let personality = replaceCardMacros(
		card.personality,
		charName,
		userName,
		fieldCap,
	).trim();
	let scenario = replaceCardMacros(
		card.scenario,
		charName,
		userName,
		fieldCap,
	).trim();
	let systemPromptRaw = replaceCardMacros(
		card.system_prompt,
		charName,
		userName,
		fieldCap,
	).trim();
	let postHistory = replaceCardMacros(
		card.post_history_instructions,
		charName,
		userName,
		fieldCap,
	).trim();

	const rawGreeting =
		options.selectedGreeting !== undefined
			? options.selectedGreeting
			: card.first_mes;
	let greeting = replaceCardMacros(
		rawGreeting,
		charName,
		userName,
		fieldCap,
	).trim();

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

	const safetyFooter = charCardText(
		"charcard.promptSafetyFooter",
		{ name: charName },
		options.locale ?? "ko",
	);

	const assemblePrompt = (): string => {
		const sections: string[] = [];
		const coreBody = buildCoreBody(description, personality, scenario);

		if (systemPromptRaw) {
			if (/\{\{\s*original\s*\}\}/i.test(systemPromptRaw)) {
				const merged = clipText(
					systemPromptRaw.replace(/\{\{\s*original\s*\}\}/gi, () => coreBody),
					maxChars,
				);
				sections.push(`[System Prompt]\n${merged.trim()}`);
				sections.push(roleplayHeader);
			} else {
				sections.push(`[System Prompt]\n${systemPromptRaw}`);
				sections.push(roleplayHeader);
				if (coreBody) {
					sections.push(coreBody);
				}
			}
		} else {
			sections.push(roleplayHeader);
			if (coreBody) {
				sections.push(coreBody);
			}
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

		sections.push(safetyFooter);

		return sections.join("\n\n");
	};

	const clipPromptPreservingSafetyFooter = (
		fullPrompt: string,
		targetMax: number,
	): string => {
		if (fullPrompt.length <= targetMax) return fullPrompt;
		const footerBlock = `\n\n${safetyFooter}`;
		if (targetMax <= footerBlock.length + 32) {
			return clipText(fullPrompt, targetMax);
		}
		const bodyWithoutFooter = fullPrompt.endsWith(footerBlock)
			? fullPrompt.slice(0, fullPrompt.length - footerBlock.length)
			: fullPrompt;
		const clippedBody = clipText(
			bodyWithoutFooter,
			targetMax - footerBlock.length,
		);
		return `${clippedBody}${footerBlock}`;
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
			prompt = clipPromptPreservingSafetyFooter(prompt, maxChars);
		}
	}

	const buildContextPayload = (
		roleplayText: string,
	): RoleplayContextPayload => ({
		type: "charcard",
		data: {
			roleplay: roleplayText,
			character: charName,
			user: userName,
			specVersion: card.specVersion,
			truncated: truncatedParts.length > 0,
			truncatedParts: [...truncatedParts],
		},
	});

	let context = buildContextPayload(prompt);
	let guard = 0;
	while (
		measureSerializedContextLength(context) > MAX_SERIALIZED_CONTEXT_CHARS &&
		guard < 16
	) {
		guard++;
		markTruncated("long_fields");
		const overage =
			measureSerializedContextLength(context) - MAX_SERIALIZED_CONTEXT_CHARS;
		const nextMax = Math.max(
			512,
			prompt.length - Math.max(256, Math.ceil(overage * 0.6)),
		);
		prompt = clipPromptPreservingSafetyFooter(prompt, nextMax);
		context = buildContextPayload(prompt);
	}

	const truncated = truncatedParts.length > 0;

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
