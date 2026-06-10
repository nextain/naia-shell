/**
 * @deprecated Use `./voice/index` instead.
 * This file is kept for backwards compatibility.
 */
export type {
	VoiceSession,
	LiveProviderConfig as VoiceSessionConfig,
} from "./voice/types";
export type { ToolDeclaration } from "./voice/types";
export { createGeminiLiveSession as createVoiceSession } from "./voice/gemini-live";
