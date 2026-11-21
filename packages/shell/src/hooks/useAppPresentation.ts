import { useEffect, useState } from "react";
import { isNewCore } from "../lib/chat-service";
import type { ThemeId } from "../lib/config";
import { Logger } from "../lib/logger";
import { useAvatarStore } from "../stores/avatar";

import {
	WEB_BACKGROUND_IMAGE_EXTS,
	WEB_BACKGROUND_VIDEO_EXTS,
	getWebBackgroundMediaType,
} from "../lib/web-runtime/web-settings-assets";

function hasExtension(url: string, extensions: Set<string>): boolean {
	const extension = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
	return extensions.has(extension);
}

/** 배경 미디어 종류 판정은 단일 계약(getWebBackgroundMediaType)을 쓴다. */
export function getBackgroundMediaType(path: string): "image" | "video" | "" {
	return getWebBackgroundMediaType(path);
}

export const PRESENTATION_VIDEO_EXTENSIONS = WEB_BACKGROUND_VIDEO_EXTS;
export const PRESENTATION_IMAGE_EXTENSIONS = WEB_BACKGROUND_IMAGE_EXTS;

export function applyTheme(theme: ThemeId) {
	const resolved =
		theme === "system"
			? window.matchMedia("(prefers-color-scheme: dark)").matches
				? "midnight"
				: "espresso"
			: theme;
	document.documentElement.setAttribute("data-theme", resolved);
}

export function useAppReady(
	showAdkSetup: boolean,
	showOnboarding: boolean,
	localeHydrated: boolean,
): boolean {
	const avatarLoaded = useAvatarStore((state) => state.isLoaded);
	const avatarModelPath = useAvatarStore((state) => state.modelPath);
	const [timedOut, setTimedOut] = useState(false);
	// 띄울 모델이 없으면 기다릴 것도 없다.
	//
	// 아바타 모델은 ADK 가 가진 자산이라 기본값이 빈 문자열이다
	// (`avatar-presets.ts` 의 DEFAULT_AVATAR_MODEL). 그래서 아직 캐릭터를
	// 고르지 않았거나 비디오 아바타를 쓰는 사용자는 `modelPath` 가 비어 있고,
	// `AvatarCanvas` 는 그 경우 아무것도 불러오지 않으므로 `isLoaded` 가
	// 영영 참이 되지 않는다. 예전에는 그때도 아래 5초 시한을 다 쓰고서야
	// 스플래시가 걷혔다 — 부팅마다 아무 진행 표시 없이 5초를 잃었고, 실측한
	// 첫 실행에서 스플래시는 8초를 머물렀다(#574).
	const skipAvatarWait =
		showAdkSetup || showOnboarding || isNewCore() || !avatarModelPath;

	useEffect(() => {
		if (skipAvatarWait || avatarLoaded) return;
		const timeout = setTimeout(() => {
			Logger.warn("App", "useAppReady: 5 s timeout — forcing splash dismiss");
			setTimedOut(true);
		}, 5000);
		return () => clearTimeout(timeout);
	}, [skipAvatarWait, avatarLoaded]);

	if (!localeHydrated) return false;
	if (skipAvatarWait) return true;
	return avatarLoaded || timedOut;
}

export function useShowAppWindow() {
	useEffect(() => {
		try {
			void getCurrentWindow()
				.show()
				.catch((error) =>
					Logger.warn("App", "failed to show window", { error: String(error) }),
				);
		} catch (error) {
			Logger.warn("App", "failed to show window (sync)", {
				error: String(error),
			});
		}
		Logger.debug("App", "window shown on first render");
	}, []);
}

export function useBackgroundFallback(
	url: string,
	mediaType: "iframe" | "image" | "video" | "",
) {
	const [fallback, setFallback] = useState<{
		url: string;
		type: "image" | "video";
	} | null>(null);

	useEffect(() => {
		if (!url || mediaType === "iframe") return;
		const type =
			mediaType === "video" || hasExtension(url, PRESENTATION_VIDEO_EXTENSIONS)
				? "video"
				: "image";
		setFallback({ url, type });
	}, [url, mediaType]);

	return fallback;
}
import { getCurrentWindow } from "@tauri-apps/api/window";
