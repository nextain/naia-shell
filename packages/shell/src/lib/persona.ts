/** Default Naia persona — editable by user in settings */
export const DEFAULT_PERSONA = `You are Naia (낸), a friendly AI companion living inside Naia.

Personality:
- Warm, curious, slightly playful
- Speaks naturally in the user's preferred language
- Gives concise, helpful answers
- Shows genuine interest in the user's activities

Keep responses concise (1-3 sentences for casual chat, longer for complex topics).`;

/** Locales with a meaningful formal/informal speech distinction */
export const FORMALITY_LOCALES = new Set([
	"ko",
	"ja",
	"de",
	"fr",
	"es",
	"hi",
	"vi",
	"ru",
	"pt",
	"id",
	"ar",
]);

function localeToLanguage(locale: string): string {
	const map: Record<string, string> = {
		ko: "Korean",
		en: "English",
		ja: "Japanese",
		zh: "Chinese",
		fr: "French",
		de: "German",
		ru: "Russian",
		es: "Spanish",
		ar: "Arabic",
		hi: "Hindi",
		bn: "Bengali",
		pt: "Portuguese",
		id: "Indonesian",
		vi: "Vietnamese",
	};
	return map[locale] || "English";
}

/** Generate locale-appropriate speech style instruction for the system prompt */
function getSpeechStyleInstruction(locale: string, style: string): string {
	const lang = localeToLanguage(locale);
	const casual: Record<string, string> = {
		ko: "IMPORTANT: Speak casually in Korean (반말). Do NOT use 존댓말.",
		ja: "IMPORTANT: Speak casually in Japanese (タメ口). Do NOT use 敬語.",
		de: "IMPORTANT: Speak casually using 'du' in German. Do NOT use 'Sie'.",
		fr: "IMPORTANT: Speak casually using 'tu' in French. Do NOT use 'vous'.",
		es: "IMPORTANT: Speak casually using 'tú' in Spanish. Do NOT use 'usted'.",
		hi: "IMPORTANT: Speak casually using 'तुम' in Hindi. Do NOT use 'आप'.",
		vi: "IMPORTANT: Speak casually using informal pronouns in Vietnamese.",
		ru: "IMPORTANT: Speak casually using 'ты' in Russian. Do NOT use 'вы'.",
		pt: "IMPORTANT: Speak casually using 'tu/você' in Portuguese. Do NOT use 'senhor/senhora'.",
		id: "IMPORTANT: Speak casually using 'kamu' in Indonesian. Do NOT use 'Anda'.",
		ar: "IMPORTANT: Speak casually using 'أنت' in Arabic. Do NOT use 'حضرتك'.",
	};
	const formal: Record<string, string> = {
		ko: "IMPORTANT: Speak politely in Korean (존댓말). Do NOT use 반말.",
		ja: "IMPORTANT: Speak politely in Japanese (敬語/丁寧語). Do NOT use タメ口.",
		de: "IMPORTANT: Speak formally using 'Sie' in German. Do NOT use 'du'.",
		fr: "IMPORTANT: Speak formally using 'vous' in French. Do NOT use 'tu'.",
		es: "IMPORTANT: Speak formally using 'usted' in Spanish. Do NOT use 'tú'.",
		hi: "IMPORTANT: Speak formally using 'आप' in Hindi. Do NOT use 'तुम/तू'.",
		vi: "IMPORTANT: Speak formally using honorific pronouns in Vietnamese.",
		ru: "IMPORTANT: Speak formally using 'вы' in Russian. Do NOT use 'ты'.",
		pt: "IMPORTANT: Speak formally using 'senhor/senhora' in Portuguese.",
		id: "IMPORTANT: Speak formally using 'Anda' in Indonesian. Do NOT use 'kamu'.",
		ar: "IMPORTANT: Speak formally using 'حضرتك' in Arabic.",
	};
	if (style === "casual") {
		return casual[locale] ?? `IMPORTANT: Speak casually in ${lang}.`;
	}
	return formal[locale] ?? `IMPORTANT: Speak formally in ${lang}.`;
}

function getEmotionExample(locale?: string): string {
	const examples: Record<string, string> = {
		ko: "[HAPPY] 좋은 아침이에요! 오늘 뭘 하고 싶어요?",
		en: "[HAPPY] Good morning! What would you like to do today?",
		ja: "[HAPPY] おはようございます！今日は何をしたいですか？",
		zh: "[HAPPY] 早上好！今天想做什么？",
		fr: "[HAPPY] Bonjour ! Qu'est-ce que tu veux faire aujourd'hui ?",
		de: "[HAPPY] Guten Morgen! Was möchtest du heute machen?",
		ru: "[HAPPY] Доброе утро! Чем хотите заняться сегодня?",
		es: "[HAPPY] ¡Buenos días! ¿Qué quieres hacer hoy?",
		ar: "[HAPPY] صباح الخير! ماذا تريد أن تفعل اليوم؟",
		hi: "[HAPPY] सुप्रभात! आज आप क्या करना चाहेंगे?",
		bn: "[HAPPY] সুপ্রভাত! আজ কী করতে চান?",
		pt: "[HAPPY] Bom dia! O que você gostaria de fazer hoje?",
		id: "[HAPPY] Selamat pagi! Apa yang ingin kamu lakukan hari ini?",
		vi: "[HAPPY] Chào buổi sáng! Hôm nay bạn muốn làm gì?",
	};
	return examples[locale ?? "en"] ?? examples.en;
}

/** Fixed emotion tag instructions — appended to all personas.
 *  Discord/tool usage instructions are NOT here — they are injected by
 *  agent's buildToolStatusPrompt() which is conditional on available tools. */
function getEmotionInstructions(locale?: string): string {
	const example = getEmotionExample(locale);
	return `
Emotion tags (for Shell avatar only):
- Prepend EXACTLY ONE emotion tag at the start of each response
- Available tags: [HAPPY] [SAD] [ANGRY] [SURPRISED] [NEUTRAL] [THINK]
- Example: "${example}"
- Use [THINK] when reasoning through complex questions
- Use [NEUTRAL] for straightforward factual answers
- Default to [HAPPY] for greetings and positive interactions
- IMPORTANT: Emotion tags are for the Shell avatar's facial expression only. They are automatically stripped from Discord messages.`;
}

/** Memory context injected into system prompt.
 *  Note: User facts are now handled by Agent MemorySystem (sessionRecall),
 *  not by Shell. Shell only provides persona/locale/app context here. */
export interface MemoryContext {
	userName?: string;
	agentName?: string;
	honorific?: string;
	speechStyle?: string;
	locale?: string;
	/**
	 * App contexts pushed via NaiaContextBridge — the active (switchable)
	 * app plus any persistent contexts (e.g. bgm favorites). One block is
	 * rendered per entry. Assembled by `selectPromptAppContexts`.
	 */
	appContexts?: { type: string; data: Record<string, unknown> }[];
}

/** Build full system prompt from persona text + optional memory context */

/**
 * 페르소나를 끈 상태의 시스템 프롬프트.
 *
 * 성격에 해당하는 것(페르소나 본문·사용자 이름·호칭·말투)은 전부 빼고, 성격이
 * 아닌 것만 남긴다. 언어 지시가 없으면 모델이 영어로 답할 수 있고, 도구 문맥이
 * 없으면 스킬을 못 쓴다.
 */
function buildNonPersonaPrompt(context?: MemoryContext): string {
	if (!context) return "";
	const lines: string[] = [];

	if (context.locale) {
		const lang = localeToLanguage(context.locale);
		lines.push(`IMPORTANT: Respond in ${lang}. The user's preferred language is ${lang}.`);
	}


	if (context.appContexts?.length) {
		for (const pc of context.appContexts) {
			lines.push(`App [${pc.type}] context: ${JSON.stringify(pc.data)}`);
		}
	}

	return lines.join("\n");
}

export function buildSystemPrompt(
	persona?: string,
	context?: MemoryContext,
	personaDisabled?: boolean,
): string {
	// 성격이 가중치에 있는 모델에는 페르소나를 얹지 않는다. 얹으면 두 정의가
	// 부딪혀 답이 무너진다. 언어 지시와 도구·앱 문맥은 성격이 아니므로 남긴다.
	if (personaDisabled) return buildNonPersonaPrompt(context);

	let base = persona?.trim() || DEFAULT_PERSONA;

	// Replace "Naia (낸)" with the configured agent name directly in persona text
	if (context?.agentName) {
		base = base.replace(/Naia\s*\(낸\)/g, context.agentName);
		base = base.replace(/\bNan\b/g, context.agentName);
	}

	const parts = [base];

	if (context) {
		const contextLines: string[] = [];

		if (context.userName) {
			contextLines.push(
				`The user's name is "${context.userName}". Address them by name occasionally.`,
			);
		}

		if (
			context.honorific &&
			(!context.locale || FORMALITY_LOCALES.has(context.locale))
		) {
			const lang = context.locale
				? localeToLanguage(context.locale)
				: "the user's language";
			contextLines.push(
				`Address the user as "${context.honorific} ${context.userName || ""}" or "${context.userName || ""}${context.honorific}" as appropriate for ${lang}.`,
			);
		}

		if (context.locale) {
			const lang = localeToLanguage(context.locale);
			contextLines.push(
				`IMPORTANT: Respond in ${lang}. The user's preferred language is ${lang}.`,
			);
		}

		if (
			context.speechStyle &&
			(!context.locale || FORMALITY_LOCALES.has(context.locale))
		) {
			contextLines.push(
				getSpeechStyleInstruction(context.locale || "ko", context.speechStyle),
			);
		}


		if (context.appContexts?.length) {
			for (const pc of context.appContexts) {
				contextLines.push(
					`App [${pc.type}] context: ${JSON.stringify(pc.data)}`,
				);
			}
		}

		if (contextLines.length > 0) {
			parts.push(`\nContext:\n${contextLines.join("\n")}`);
		}
	}

	parts.push(getEmotionInstructions(context?.locale));
	return parts.join("\n");
}
