export interface AvatarPreset {
	filename: string;
	label: string;
	gender: AvatarGender;
}

export const DEFAULT_AVATAR_MODEL = "/avatars/01-Sendagaya-Shino-uniform.vrm";

export type AvatarGender = "female" | "male";

export const AVATAR_PRESETS: AvatarPreset[] = [
	{
		filename: "01-Sendagaya-Shino-uniform.vrm",
		label: "Shino",
		gender: "female",
	},
	{
		filename: "02-Sakurada-Fumiriya.vrm",
		label: "Sakurada Fumiriya",
		gender: "male",
	},
	{ filename: "03-OL_Woman.vrm", label: "Girl", gender: "female" },
	{ filename: "04-Hood_Boy.vrm", label: "Boy", gender: "male" },
];

const VOICE_DEFAULTS: Record<AvatarGender, string> = {
	female: "Kore",
	male: "Puck",
};

const TTS_VOICE_DEFAULTS: Record<string, Record<AvatarGender, string>> = {
	edge: { female: "ko-KR-SunHiNeural", male: "ko-KR-InJoonNeural" },
	google: { female: "ko-KR-Neural2-A", male: "ko-KR-Neural2-C" },
};

/** Resolves the VRM avatar's gender from its path (matches by filename). */
export function getAvatarGender(vrmPath?: string): AvatarGender {
	const resolved = vrmPath || DEFAULT_AVATAR_MODEL;
	const filename = resolved.split(/[/\\]/).pop() ?? "";
	const preset = AVATAR_PRESETS.find((p) => filename === p.filename);
	return preset?.gender ?? "female";
}

export function getDefaultVoiceForAvatar(vrmPath?: string): string {
	return VOICE_DEFAULTS[getAvatarGender(vrmPath)];
}

export function getDefaultTtsVoiceForAvatar(
	provider: string,
	vrmPath?: string,
): string {
	const gender = getAvatarGender(vrmPath);
	return (
		TTS_VOICE_DEFAULTS[provider]?.[gender] ?? TTS_VOICE_DEFAULTS.edge[gender]
	);
}
