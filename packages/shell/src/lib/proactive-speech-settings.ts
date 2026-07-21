export type ProactiveSpeechSettings = {
	profile: "disabled" | "personal_radio_dj" | "exhibition_intro";
	timezone: string;
	idleMs?: number;
	intervalMs?: number;
	bgmAutoPlay?: boolean;
	weatherConsented?: boolean;
	weatherLatitude?: number;
	weatherLongitude?: number;
	knowledgeScope?: string;
};

export type SpeechProfileCommandInput = {
	profile: ProactiveSpeechSettings["profile"];
	idleMs?: number;
	djIntervalMs?: number;
	introIntervalMs?: number;
	timezone: string;
	bgmAutoPlayOptIn?: boolean;
	weatherConsented: boolean;
	weatherLatitude?: number;
	weatherLongitude?: number;
	knowledgeScope?: string;
};

function validTimezone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
}

const finiteRange = (
	value: unknown,
	min: number,
	max: number,
): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= min &&
	value <= max;

export function normalizeProactiveSpeechSettings(
	input: ProactiveSpeechSettings,
): ProactiveSpeechSettings {
	const timezone = input.timezone.trim();
	const scope = input.knowledgeScope?.trim();
	const consented = input.weatherConsented === true;
	const hasLatitude = input.weatherLatitude !== undefined;
	const hasLongitude = input.weatherLongitude !== undefined;
	const coordinatesValid =
		!consented ||
		(hasLatitude &&
			hasLongitude &&
			finiteRange(input.weatherLatitude, -90, 90) &&
			finiteRange(input.weatherLongitude, -180, 180));
	const scopeValid = input.profile !== "exhibition_intro" || Boolean(scope);
	const valid = validTimezone(timezone) && coordinatesValid && scopeValid;
	if (!valid) {
		return {
			profile: "disabled",
			timezone: validTimezone(timezone) ? timezone : "UTC",
			weatherConsented: false,
			weatherLatitude: undefined,
			weatherLongitude: undefined,
			...(scope ? { knowledgeScope: scope } : {}),
		};
	}
	return {
		profile: input.profile,
		timezone,
		...(input.idleMs !== undefined
			? { idleMs: Math.max(0, Math.floor(input.idleMs)) }
			: {}),
		...(input.intervalMs !== undefined
			? { intervalMs: Math.max(0, Math.floor(input.intervalMs)) }
			: {}),
		...(input.bgmAutoPlay !== undefined
			? { bgmAutoPlay: input.bgmAutoPlay }
			: {}),
		weatherConsented: consented,
		...(consented
			? {
					weatherLatitude: input.weatherLatitude,
					weatherLongitude: input.weatherLongitude,
				}
			: {}),
		...(scope ? { knowledgeScope: scope } : {}),
	};
}

export function toSpeechProfileCommandInput(
	settings: ProactiveSpeechSettings,
): SpeechProfileCommandInput {
	return {
		profile: settings.profile,
		idleMs: settings.idleMs,
		djIntervalMs: settings.intervalMs,
		introIntervalMs: settings.intervalMs,
		timezone: settings.timezone,
		bgmAutoPlayOptIn: settings.bgmAutoPlay,
		weatherConsented: settings.weatherConsented === true,
		...(settings.weatherConsented
			? {
					weatherLatitude: settings.weatherLatitude,
					weatherLongitude: settings.weatherLongitude,
				}
			: {}),
		knowledgeScope: settings.knowledgeScope,
	};
}
