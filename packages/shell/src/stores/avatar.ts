import { create } from "zustand";
import { isLegacyBundledVrmModel } from "../lib/avatar-presets";
import { loadConfig } from "../lib/config";
import type { EmotionName } from "../lib/vrm/expression";

export type BackgroundMediaType = "" | "image" | "video" | "iframe";

interface AvatarState {
	modelPath: string;
	backgroundImage: string;
	/** Asset URL (convertFileSrc) for background video. Empty = no video. */
	backgroundVideoUrl: string;
	backgroundMediaType: BackgroundMediaType;
	/** Asset URL (convertFileSrc) for BGM track. Empty = no BGM. */
	bgmTrackUrl: string;
	animationPath: string;
	isLoaded: boolean;
	loadProgress: number;
	currentEmotion: EmotionName;
	isSpeaking: boolean;
	pendingAudio: string | null;
	setLoaded: (loaded: boolean) => void;
	setLoadProgress: (progress: number) => void;
	setEmotion: (emotion: EmotionName) => void;
	setSpeaking: (speaking: boolean) => void;
	setPendingAudio: (data: string | null) => void;
	setModelPath: (path: string) => void;
	setBackgroundImage: (path: string) => void;
	setBackgroundVideoUrl: (url: string) => void;
	setBackgroundMediaType: (type: BackgroundMediaType) => void;
	setBgmTrackUrl: (url: string) => void;
}

function getInitialModelPath(): string {
	const config = loadConfig();
	const modelPath = config?.vrmModel ?? "";
	return isLegacyBundledVrmModel(modelPath) ? "" : modelPath;
}

function getInitialBgImage(): string {
	const config = loadConfig();
	return config?.backgroundImage || "";
}

export const useAvatarStore = create<AvatarState>((set) => ({
	modelPath: getInitialModelPath(),
	backgroundImage: getInitialBgImage(),
	backgroundVideoUrl: "",
	backgroundMediaType: "",
	bgmTrackUrl: "",
	animationPath: "/animations/idle_loop.vrma",
	isLoaded: false,
	loadProgress: 0,
	currentEmotion: "neutral",
	isSpeaking: false,
	pendingAudio: null,
	setLoaded: (loaded) => set({ isLoaded: loaded }),
	setLoadProgress: (progress) => set({ loadProgress: progress }),
	setEmotion: (emotion) => set({ currentEmotion: emotion }),
	setSpeaking: (speaking) => set({ isSpeaking: speaking }),
	setPendingAudio: (data) => set({ pendingAudio: data }),
	setModelPath: (path) =>
		set({ modelPath: path, isLoaded: false, loadProgress: 0 }),
	setBackgroundImage: (path) => set({ backgroundImage: path }),
	setBackgroundVideoUrl: (url) => set({ backgroundVideoUrl: url }),
	setBackgroundMediaType: (type) => set({ backgroundMediaType: type }),
	setBgmTrackUrl: (url) => set({ bgmTrackUrl: url }),
}));
