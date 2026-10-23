import { type Locale, getLocale } from "../../lib/i18n";
import {
	LEGACY_TRANSLATIONS,
	PROJECT_BASE_ENGLISH_TRANSLATIONS,
	type ProjectTranslationKey,
	SESSION_SAVE_TRANSLATIONS,
	STAGE_TWO_TRANSLATIONS,
} from "./locales/projects";
import { PROJECT_AGENT_LOCALE_OVERRIDES } from "./project-agent-translations";

export const PROJECT_APP_TRANSLATIONS = Object.fromEntries(
	Object.entries(LEGACY_TRANSLATIONS).map(([locale, messages]) => [
		locale,
		{
			...PROJECT_BASE_ENGLISH_TRANSLATIONS,
			...messages,
			...STAGE_TWO_TRANSLATIONS[locale as Locale],
			...PROJECT_AGENT_LOCALE_OVERRIDES[locale as Locale],
			"projects.sessionSaveFailed": SESSION_SAVE_TRANSLATIONS[locale as Locale],
		},
	]),
) as Record<Locale, Record<ProjectTranslationKey, string>>;

export type { ProjectTranslationKey };

export function projectText(
	key: ProjectTranslationKey,
	params?: Readonly<Record<string, string | number>>,
): string {
	const value = PROJECT_APP_TRANSLATIONS[getLocale()][key];
	if (!params) return value;
	return value.replace(/\{(\w+)\}/g, (whole, name) =>
		Object.prototype.hasOwnProperty.call(params, name)
			? String(params[name])
			: whole,
	);
}
