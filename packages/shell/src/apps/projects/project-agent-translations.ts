import { Logger } from "../../lib/logger";
import {
	PROJECT_AGENT_ENGLISH_TRANSLATIONS,
	PROJECT_AGENT_KOREAN_TRANSLATIONS,
	PROJECT_AGENT_LOCALE_OVERRIDES,
	type ProjectAgentTranslationKey,
} from "./locales/project-agent";

Logger.debug("ProjectAgentTranslations", "loading fixed project app messages");

export {
	PROJECT_AGENT_ENGLISH_TRANSLATIONS,
	PROJECT_AGENT_KOREAN_TRANSLATIONS,
	PROJECT_AGENT_LOCALE_OVERRIDES,
	type ProjectAgentTranslationKey,
};
