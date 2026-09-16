import { create } from "zustand";

interface SkillsState {
	/** Bumped to trigger re-render after CLI or gesture config changes. */
	configVersion: number;

	bumpConfigVersion: () => void;
}

export const useSkillsStore = create<SkillsState>()((set, get) => ({
	configVersion: 0,

	bumpConfigVersion: () => set({ configVersion: get().configVersion + 1 }),
}));
