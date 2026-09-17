import { create } from "zustand";
import type { SkillManifestInfo } from "../lib/types";

interface SkillsState {
	skills: SkillManifestInfo[];
	isLoading: boolean;
	searchQuery: string;
	/** Bumped to trigger re-render after config changes (e.g. toggle) */
	configVersion: number;

	setSkills: (skills: SkillManifestInfo[]) => void;
	setLoading: (loading: boolean) => void;
	setSearchQuery: (query: string) => void;
	bumpConfigVersion: () => void;
}

export const useSkillsStore = create<SkillsState>()((set, get) => ({
	skills: [],
	isLoading: false,
	searchQuery: "",
	configVersion: 0,

	setSkills: (skills) => set({ skills }),
	setLoading: (loading) => set({ isLoading: loading }),
	setSearchQuery: (query) => set({ searchQuery: query }),
	bumpConfigVersion: () => set({ configVersion: get().configVersion + 1 }),
}));
