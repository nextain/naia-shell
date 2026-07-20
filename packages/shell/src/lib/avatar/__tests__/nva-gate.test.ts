import { describe, expect, it } from "vitest";
import {
	canUseVideoAvatarFromConfig,
	effectiveAvatarProviderFromConfig,
	hasExplicitLocalAvatarProfile,
} from "../nva-gate";

describe("NVA login/local gate", () => {
	it("downgrades stale logged-out remote NVA config to VRM", () => {
		const config = {
			avatarProvider: "naia-video-avatar" as const,
			localGpuTier: "auto" as const,
			naiaKey: "",
		};

		expect(hasExplicitLocalAvatarProfile(config)).toBe(false);
		expect(canUseVideoAvatarFromConfig(config)).toBe(false);
		expect(effectiveAvatarProviderFromConfig(config)).toBe("vrm");
	});

	it("allows logged-out NVA only for an explicit local avatar-capable profile", () => {
		const config = {
			avatarProvider: "naia-video-avatar" as const,
			localGpuTier: "laptop-4060-8g" as const,
			naiaKey: "",
		};

		expect(hasExplicitLocalAvatarProfile(config)).toBe(true);
		expect(canUseVideoAvatarFromConfig(config)).toBe(true);
		expect(effectiveAvatarProviderFromConfig(config)).toBe("naia-video-avatar");
	});

	it("keeps legacy auto/off profiles from unlocking logged-out NVA", () => {
		for (const localGpuTier of ["auto", "off"] as const) {
			const config = {
				avatarProvider: "naia-video-avatar" as const,
				localGpuTier,
				naiaKey: "",
			};

			expect(hasExplicitLocalAvatarProfile(config)).toBe(false);
			expect(canUseVideoAvatarFromConfig(config)).toBe(false);
			expect(effectiveAvatarProviderFromConfig(config)).toBe("vrm");
		}
	});

	it("allows logged-in remote NVA without a local profile", () => {
		const config = {
			avatarProvider: "naia-video-avatar" as const,
			localGpuTier: "off" as const,
			naiaKey: "naia_test_key",
		};

		expect(hasExplicitLocalAvatarProfile(config)).toBe(false);
		expect(canUseVideoAvatarFromConfig(config)).toBe(true);
		expect(effectiveAvatarProviderFromConfig(config)).toBe("naia-video-avatar");
	});
});