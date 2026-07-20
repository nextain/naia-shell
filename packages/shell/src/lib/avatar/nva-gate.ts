import {
	normalizeLocal8gFocus,
	normalizeTierSetting,
	resolveActiveTier,
	resolveLocalCapabilities,
} from "../capabilities/vram-tiers";
import type { AppConfig } from "../config";

type AvatarProvider = "vrm" | "naia-video-avatar";

type VideoAvatarGateConfig = Pick<
	AppConfig,
	| "avatarProvider"
	| "local8gFocus"
	| "localAvatarVoiceFocus"
	| "localGpuTier"
	| "naiaKey"
>;

export function hasExplicitLocalAvatarProfile(
	config: VideoAvatarGateConfig | null | undefined,
): boolean {
	const setting = normalizeTierSetting(config?.localGpuTier);
	if (setting === "off" || setting === "auto") return false;
	const tier = resolveActiveTier(setting, null);
	return resolveLocalCapabilities(
		tier,
		normalizeLocal8gFocus(
			config?.local8gFocus ?? config?.localAvatarVoiceFocus,
		),
	).includes("avatar");
}

export function canUseVideoAvatarFromConfig(
	config: VideoAvatarGateConfig | null | undefined,
): boolean {
	return !!config?.naiaKey || hasExplicitLocalAvatarProfile(config);
}

export function effectiveAvatarProviderFromConfig(
	config: VideoAvatarGateConfig | null | undefined,
): AvatarProvider {
	const provider = config?.avatarProvider ?? "vrm";
	if (provider !== "naia-video-avatar") return "vrm";
	return canUseVideoAvatarFromConfig(config) ? "naia-video-avatar" : "vrm";
}