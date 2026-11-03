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
	peakIntermediateChars: number;
}

const MACRO_PATTERN_SOURCE =
	"\\{\\{\\s*char\\s*\\}\\}|<\\s*bot\\s*>|\\{\\{\\s*user\\s*\\}\\}|<\\s*user\\s*>";
const ORIGINAL_MACRO_SOURCE = "\\{\\{\\s*original\\s*\\}\\}";

function clipText(value: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (value.length <= maxLen) return value;
	if (maxLen <= 1) return value.slice(0, maxLen);
	return `${value.slice(0, maxLen - 1)}…`;
}

export function replaceCardMacros(
	text: string,
	charName: string,
	userName: string,
	maxOutputChars = MAX_FIELD_INPUT_CHARS,
): string {
	if (!text || maxOutputChars <= 0) return "";
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

	const re = new RegExp(MACRO_PATTERN_SOURCE, "gi");
	let out = "";
	let lastIndex = 0;

	for (;;) {
		const match = re.exec(boundedInput);
		if (!match) break;
		const prefix = boundedInput.slice(lastIndex, match.index);
		const remBeforePrefix = maxOutputChars - out.length;
		if (remBeforePrefix <= 0) {
			lastIndex = boundedInput.length;
			break;
		}
		if (prefix.length >= remBeforePrefix) {
			out += prefix.slice(0, remBeforePrefix);
			lastIndex = boundedInput.length;
			break;
		}
		out += prefix;

		const lower = match[0].toLowerCase();
		const replacement =
			lower.includes("char") || lower.includes("bot") ? safeChar : safeUser;
		const remForMacro = maxOutputChars - out.length;
		if (remForMacro <= 0) {
			lastIndex = boundedInput.length;
			break;
		}
		if (replacement.length >= remForMacro) {
			out += replacement.slice(0, remForMacro);
			lastIndex = boundedInput.length;
			break;
		}
		out += replacement;
		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < boundedInput.length && out.length < maxOutputChars) {
		const tail = boundedInput.slice(lastIndex);
		const rem = maxOutputChars - out.length;
		out += tail.length > rem ? tail.slice(0, rem) : tail;
	}

	return out;
}

export interface ExpandOriginalResult {
	text: string;
	truncated: boolean;
	expandedCount: number;
	peakLength: number;
}

export function expandOriginalWithBudget(
	systemPrompt: string,
	coreBody: string,
	maxOutputChars: number,
): ExpandOriginalResult {
	if (!systemPrompt || maxOutputChars <= 0) {
		return { text: "", truncated: false, expandedCount: 0, peakLength: 0 };
	}
	const re = new RegExp(ORIGINAL_MACRO_SOURCE, "gi");
	let out = "";
	let lastIndex = 0;
	let truncated = false;
	let expandedCount = 0;
	let peakLength = 0;

	for (;;) {
		const match = re.exec(systemPrompt);
		if (!match) break;
		const prefix = systemPrompt.slice(lastIndex, match.index);
		const remBeforePrefix = maxOutputChars - out.length;
		if (remBeforePrefix <= 0) {
			truncated = true;
			lastIndex = systemPrompt.length;
			break;
		}
		if (prefix.length >= remBeforePrefix) {
			out += clipText(prefix, remBeforePrefix);
			peakLength = Math.max(peakLength, out.length);
			truncated = true;
			lastIndex = systemPrompt.length;
			break;
		}
		out += prefix;
		peakLength = Math.max(peakLength, out.length);

		const remForBody = maxOutputChars - out.length;
		if (remForBody <= 0) {
			truncated = true;
			lastIndex = systemPrompt.length;
			break;
		}
		expandedCount++;
		if (coreBody.length > remForBody) {
			out += clipText(coreBody, remForBody);
			peakLength = Math.max(peakLength, out.length);
			truncated = true;
			lastIndex = systemPrompt.length;
			break;
		}
		out += coreBody;
		peakLength = Math.max(peakLength, out.length);
		lastIndex = match.index + match[0].length;
	}

	if (!truncated && lastIndex < systemPrompt.length) {
		const tail = systemPrompt.slice(lastIndex);
		const rem = maxOutputChars - out.length;
		if (rem <= 0) {
			truncated = true;
		} else if (tail.length > rem) {
			out += clipText(tail, rem);
			peakLength = Math.max(peakLength, out.length);
			truncated = true;
		} else {
			out += tail;
			peakLength = Math.max(peakLength, out.length);
		}
	}

	return {
		text: out.trim(),
		truncated,
		expandedCount,
		peakLength,
	};
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
	maxOutputChars = MAX_FIELD_INPUT_CHARS,
): string[] {
	const replaced = replaceCardMacros(
		mesExample,
		charName,
		userName,
		maxOutputChars,
	).trim();
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
	maxEntryChars: number,
): string {
	const title = entry.name.trim() || entry.comment.trim();
	const content = replaceCardMacros(
		entry.content.trim(),
		charName,
		userName,
		maxEntryChars,
	);
	return title ? `- (${title}) ${content}` : `- ${content}`;
}

function formatTriggeredLoreEntry(
	entry: NormalizedLorebookEntry,
	charName: string,
	userName: string,
	maxEntryChars: number,
): string {
	const allKeys = [...entry.keys, ...entry.secondary_keys]
		.map((k) => replaceCardMacros(k.trim(), charName, userName, MAX_NAME_CHARS))
		.filter((k) => k.length > 0);
	const keyLabel =
		allKeys.length > 0 ? allKeys.join(", ") : entry.name || "keyword";
	const content = replaceCardMacros(
		entry.content.trim(),
		charName,
		userName,
		maxEntryChars,
	);
	return `- Keywords [${keyLabel}]: ${content}`;
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
	let peakIntermediateChars = 0;
	const recordPeak = (len: number) => {
		if (len > peakIntermediateChars) {
			peakIntermediateChars = len;
		}
	};

	const truncatedParts: TruncatedPart[] = [];
	const markTruncated = (part: TruncatedPart) => {
		if (!truncatedParts.includes(part)) {
			truncatedParts.push(part);
		}
	};

	let description = replaceCardMacros(
		card.description,
		charName,
		userName,
		fieldCap,
	).trim();
	recordPeak(description.length);

	let personality = replaceCardMacros(
		card.personality,
		charName,
		userName,
		fieldCap,
	).trim();
	recordPeak(personality.length);

	let scenario = replaceCardMacros(
		card.scenario,
		charName,
		userName,
		fieldCap,
	).trim();
	recordPeak(scenario.length);

	let systemPromptRaw = replaceCardMacros(
		card.system_prompt,
		charName,
		userName,
		fieldCap,
	).trim();
	recordPeak(systemPromptRaw.length);

	let postHistory = replaceCardMacros(
		card.post_history_instructions,
		charName,
		userName,
		fieldCap,
	).trim();
	recordPeak(postHistory.length);

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
	recordPeak(greeting.length);

	if (
		card.description.length > fieldCap ||
		card.personality.length > fieldCap ||
		card.scenario.length > fieldCap ||
		card.system_prompt.length > fieldCap ||
		card.post_history_instructions.length > fieldCap ||
		rawGreeting.length > fieldCap
	) {
		markTruncated("long_fields");
	}

	const rawExamples = splitMesExamples(
		card.mes_example,
		charName,
		userName,
		fieldCap,
	);
	if (card.mes_example.length > fieldCap) {
		markTruncated("mes_example");
	}
	const examples: string[] = [];
	let examplesChars = 0;
	for (let i = 0; i < rawExamples.length; i++) {
		const formatted = `Example ${i + 1}:\n${rawExamples[i]}`;
		const addedLen = (examples.length > 0 ? 2 : 0) + formatted.length;
		if (examplesChars + addedLen > maxChars) {
			markTruncated("mes_example");
			break;
		}
		examples.push(rawExamples[i]);
		examplesChars += addedLen;
	}

	const { constantEntries, triggeredEntries } = sortActiveLorebookEntries(
		card.character_book.entries,
	);

	const constantLoreLines: string[] = [];
	let constantChars = 0;
	for (const entry of constantEntries) {
		const line = formatConstantLoreEntry(entry, charName, userName, fieldCap);
		const addedLen = (constantLoreLines.length > 0 ? 1 : 0) + line.length;
		if (constantChars + addedLen > maxChars) {
			markTruncated("lorebook_constant");
			break;
		}
		constantLoreLines.push(line);
		constantChars += addedLen;
	}

	const triggeredLoreLines: string[] = [];
	let triggeredChars = 0;
	for (const entry of triggeredEntries) {
		const line = formatTriggeredLoreEntry(entry, charName, userName, fieldCap);
		const addedLen = (triggeredLoreLines.length > 0 ? 1 : 0) + line.length;
		if (triggeredChars + addedLen > maxChars) {
			markTruncated("lorebook_triggered");
			break;
		}
		triggeredLoreLines.push(line);
		triggeredChars += addedLen;
	}

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

	const buildLeadSections = (): { sections: string[]; rawLen: number } => {
		const sections: string[] = [];
		const coreBody = buildCoreBody(description, personality, scenario);
		const sysHeaderPrefix = "[System Prompt]\n";

		if (systemPromptRaw) {
			if (new RegExp(ORIGINAL_MACRO_SOURCE, "i").test(systemPromptRaw)) {
				const sysBudget = Math.max(64, maxChars - sysHeaderPrefix.length);
				const expanded = expandOriginalWithBudget(
					systemPromptRaw,
					coreBody,
					sysBudget,
				);
				recordPeak(expanded.peakLength);
				if (expanded.truncated) {
					markTruncated("long_fields");
				}
				sections.push(`${sysHeaderPrefix}${expanded.text}`);
				sections.push(roleplayHeader);
			} else {
				sections.push(`${sysHeaderPrefix}${systemPromptRaw}`);
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

		let rawLen = 0;
		for (let i = 0; i < sections.length; i++) {
			rawLen += (i > 0 ? 2 : 0) + sections[i].length;
		}
		return { sections, rawLen };
	};

	const computeTotalLengthWithLead = (leadLen: number): number => {
		let total = leadLen;
		const addSecLen = (secLen: number) => {
			if (secLen <= 0) return;
			total += (total > 0 ? 2 : 0) + secLen;
		};
		if (constantLoreLines.length > 0) {
			const linesLen =
				constantLoreLines.reduce((sum, l) => sum + l.length, 0) +
				(constantLoreLines.length - 1);
			addSecLen("[World Info — Always Active]\n".length + linesLen);
		}
		if (triggeredLoreLines.length > 0) {
			const linesLen =
				triggeredLoreLines.reduce((sum, l) => sum + l.length, 0) +
				(triggeredLoreLines.length - 1);
			addSecLen(
				"[World Info — Keyword Triggered (apply when these keywords appear in conversation)]\n"
					.length + linesLen,
			);
		}
		if (examples.length > 0) {
			let exLen = "[Dialogue Examples]\n".length;
			for (let i = 0; i < examples.length; i++) {
				exLen += (i > 0 ? 2 : 0) + `Example ${i + 1}:\n${examples[i]}`.length;
			}
			addSecLen(exLen);
		}
		if (greeting) {
			addSecLen(
				"[Opening Greeting — You have already started the conversation with this message]\n"
					.length + greeting.length,
			);
		}
		if (postHistory) {
			addSecLen(
				"[Post-History Instructions — Always follow when replying]\n".length +
					postHistory.length,
			);
		}
		addSecLen(safetyFooter.length);
		return total;
	};

	const initialLeadLen = buildLeadSections().rawLen;

	// 1. Trim non-constant (triggered) lorebook entries from the end
	while (
		computeTotalLengthWithLead(initialLeadLen) > maxChars &&
		triggeredLoreLines.length > 0
	) {
		triggeredLoreLines.pop();
		markTruncated("lorebook_triggered");
	}

	// 1b. If still over budget and constant lorebook entries exist, trim from the end
	while (
		computeTotalLengthWithLead(initialLeadLen) > maxChars &&
		constantLoreLines.length > 0
	) {
		constantLoreLines.pop();
		markTruncated("lorebook_constant");
	}

	// 2. Trim dialogue examples from the end
	while (
		computeTotalLengthWithLead(initialLeadLen) > maxChars &&
		examples.length > 0
	) {
		examples.pop();
		markTruncated("mes_example");
	}

	// 3. Trim long fields (description, scenario, personality, systemPromptRaw, greeting, postHistory)
	if (computeTotalLengthWithLead(initialLeadLen) > maxChars) {
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

		for (let guard = 0; guard < 24; guard++) {
			const totalLen = computeTotalLengthWithLead(buildLeadSections().rawLen);
			if (totalLen <= maxChars) break;
			const excess = totalLen - maxChars;
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
		}
	}

	// Budget-stopping assembly: appends sections in D81 §10 order and stops immediately when budget is reached, preserving safetyFooter at the end
	const assembleBoundedPrompt = (targetMax: number): string => {
		const footerBlock = `\n\n${safetyFooter}`;
		const bodyBudget = Math.max(0, targetMax - footerBlock.length);
		const { sections: leadSections } = buildLeadSections();
		const bodySections: string[] = [...leadSections];

		if (constantLoreLines.length > 0) {
			bodySections.push(
				`[World Info — Always Active]\n${constantLoreLines.join("\n")}`,
			);
		}
		if (triggeredLoreLines.length > 0) {
			bodySections.push(
				`[World Info — Keyword Triggered (apply when these keywords appear in conversation)]\n${triggeredLoreLines.join("\n")}`,
			);
		}
		if (examples.length > 0) {
			const formattedExamples = examples
				.map((ex, idx) => `Example ${idx + 1}:\n${ex}`)
				.join("\n\n");
			bodySections.push(`[Dialogue Examples]\n${formattedExamples}`);
		}
		if (greeting) {
			bodySections.push(
				`[Opening Greeting — You have already started the conversation with this message]\n${greeting}`,
			);
		}
		if (postHistory) {
			bodySections.push(
				`[Post-History Instructions — Always follow when replying]\n${postHistory}`,
			);
		}

		if (bodyBudget <= 32) {
			const minOut = clipText(
				`${bodySections[0] ?? ""}${footerBlock}`,
				targetMax,
			);
			recordPeak(minOut.length);
			return minOut;
		}

		let bodyOut = "";
		for (let i = 0; i < bodySections.length; i++) {
			const sep = i > 0 ? "\n\n" : "";
			const rem = bodyBudget - bodyOut.length;
			if (rem <= sep.length) {
				markTruncated("long_fields");
				break;
			}
			const candidate = sep + bodySections[i];
			if (candidate.length > rem) {
				bodyOut += sep + clipText(bodySections[i], rem - sep.length);
				recordPeak(bodyOut.length);
				markTruncated("long_fields");
				break;
			}
			bodyOut += candidate;
			recordPeak(bodyOut.length);
		}

		const finalPrompt = `${bodyOut}${footerBlock}`;
		recordPeak(finalPrompt.length);
		return finalPrompt;
	};

	let prompt = assembleBoundedPrompt(maxChars);

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
		prompt = assembleBoundedPrompt(nextMax);
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
		peakIntermediateChars,
	};
}
