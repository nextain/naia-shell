import {
	type TtsAutoMode,
	type TtsMode,
	type TtsProvider,
	convertTts,
	disableTts,
	enableTts,
	getTtsProviders,
	getTtsStatus,
	setTtsAutoMode,
	setTtsOutputMode,
	setTtsProvider,
} from "../../gateway/tts-proxy.js";
import { synthesizeEdgeSpeech } from "../../tts/edge-tts.js";
import { synthesizeElevenLabsSpeech } from "../../tts/elevenlabs-tts.js";
import { synthesizeSpeech as synthesizeGoogleSpeech } from "../../tts/google-tts.js";
import { synthesizeNextainSpeech } from "../../tts/nextain-tts.js";
import { synthesizeOpenAISpeech } from "../../tts/openai-tts.js";
import { ttsDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

export function createTtsSkill(): SkillDefinition {
	return {
		name: `skill_${ttsDescriptor.name}`,
		description: ttsDescriptor.description,
		parameters: ttsDescriptor.inputSchema,
		tier: 0,
		requiresGateway: false,
		source: "built-in",
		execute: async (args, ctx): Promise<SkillResult> => {
			const action = args.action as string;
			const gateway = ctx.gateway;

			// preview action works without Gateway
			if (action !== "preview" && !gateway?.isConnected()) {
				return {
					success: false,
					output: "",
					error:
						"Gateway not connected. TTS management requires a running Gateway.",
				};
			}

			switch (action) {
				case "status": {
					const result = await getTtsStatus(gateway!);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "providers": {
					const result = await getTtsProviders(gateway!);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "set_provider": {
					const provider = args.provider as string;
					if (!provider) {
						return {
							success: false,
							output: "",
							error: "provider is required for set_provider action",
						};
					}
					const result = await setTtsProvider(
						gateway!,
						provider as TtsProvider,
					);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "set_auto": {
					const auto = args.auto as TtsAutoMode | undefined;
					if (!auto) {
						return {
							success: false,
							output: "",
							error: "auto is required for set_auto action",
						};
					}
					const result = await setTtsAutoMode(gateway!, auto);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "set_mode": {
					const mode = args.mode as TtsMode | undefined;
					if (!mode) {
						return {
							success: false,
							output: "",
							error: "mode is required for set_mode action",
						};
					}
					const result = await setTtsOutputMode(gateway!, mode);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "enable": {
					const result = await enableTts(gateway!);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "disable": {
					const result = await disableTts(gateway!);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "preview": {
					const text = args.text as string;
					const provider = args.provider as string;
					if (!text) {
						return {
							success: false,
							output: "",
							error: "text is required for preview action",
						};
					}
					let ttsResult:
						| import("../../tts/types.js").TtsSynthesizeResult
						| null = null;
					if (provider === "openai") {
						const key = args.apiKey as string;
						if (!key) {
							return {
								success: false,
								output: "",
								error: "apiKey is required for OpenAI preview",
							};
						}
						ttsResult = await synthesizeOpenAISpeech(
							text,
							key,
							args.voice as string | undefined,
						);
					} else if (provider === "elevenlabs") {
						const key = args.apiKey as string;
						if (!key) {
							return {
								success: false,
								output: "",
								error: "apiKey is required for ElevenLabs preview",
							};
						}
						ttsResult = await synthesizeElevenLabsSpeech(
							text,
							key,
							args.voice as string | undefined,
						);
					} else if (provider === "google") {
						const key = args.apiKey as string;
						if (!key) {
							return {
								success: false,
								output: "",
								error: "apiKey is required for Google Cloud TTS preview",
							};
						}
						ttsResult = await synthesizeGoogleSpeech(
							text,
							key,
							args.voice as string | undefined,
						);
					} else if (provider === "nextain") {
						const nKey = args.naiaKey as string;
						if (!nKey) {
							return {
								success: false,
								output: "",
								error:
									"Naia account login is required for Naia Cloud TTS preview",
							};
						}
						ttsResult = await synthesizeNextainSpeech(
							text,
							nKey,
							args.voice as string | undefined,
						);
					} else {
						// Default: Edge TTS (free)
						ttsResult = await synthesizeEdgeSpeech(
							text,
							args.voice as string | undefined,
						);
					}
					if (ttsResult) {
						return {
							success: true,
							output: JSON.stringify({ audio: ttsResult.audio, format: "mp3" }),
						};
					}
					return {
						success: false,
						output: "",
						error: `${provider || "edge"} TTS 미리듣기에 실패했습니다.`,
					};
				}

				case "convert": {
					const text = args.text as string;
					if (!text) {
						return {
							success: false,
							output: "",
							error: "text is required for convert action",
						};
					}
					// Try Gateway first, fall back to direct edge-tts if no audio
					const result = await convertTts(gateway!, text, {
						voice: args.voice as string | undefined,
					});
					if (result.audio) {
						return {
							success: true,
							output: JSON.stringify(result),
						};
					}
					// Gateway returned no audio — use msedge-tts directly
					const edgeResult = await synthesizeEdgeSpeech(
						text,
						args.voice as string | undefined,
					);
					if (edgeResult) {
						return {
							success: true,
							output: JSON.stringify({
								audio: edgeResult.audio,
								format: "mp3",
							}),
						};
					}
					return {
						success: false,
						output: "",
						error: "TTS 변환에 실패했습니다.",
					};
				}

				default:
					return {
						success: false,
						output: "",
						error: `Unknown action: ${action}`,
					};
			}
		},
	};
}
