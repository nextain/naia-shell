export interface AvatarPreset {
	filename: string;
	label: string;
	gender: AvatarGender;
}

export const DEFAULT_AVATAR_MODEL = "/avatars/Naia.vrm";

/**
 * 비디오 아바타(NVA) 기본 번들 이름(bare name). 비디오 아바타를 켰는데 nvaModel 이
 * 비어 있으면 이 값으로 채운다. 지금은 alpha-real-video, 추후 전용 기본 아바타로 교체 예정.
 */
export const DEFAULT_NVA_MODEL = "alpha-real-video";

export type AvatarGender = "female" | "male";

export const AVATAR_PRESETS: AvatarPreset[] = [
	{
		filename: "Naia.vrm",
		label: "Naia",
		gender: "female",
	},
	{
		filename: "Naia-Base.vrm",
		label: "Naia Base",
		gender: "female",
	},
	{
		filename: "Naia-Hair.vrm",
		label: "Naia Hair",
		gender: "female",
	},
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
