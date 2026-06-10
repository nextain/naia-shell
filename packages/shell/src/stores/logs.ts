import { create } from "zustand";
import type { LogEntry } from "../lib/types";

const MAX_LOG_ENTRIES = 500;

interface LogsStore {
	entries: LogEntry[];
	isTailing: boolean;
	addEntry: (entry: LogEntry) => void;
	setTailing: (tailing: boolean) => void;
	clear: () => void;
}

export const useLogsStore = create<LogsStore>((set) => ({
	entries: [],
	isTailing: false,
	addEntry: (entry) =>
		set((state) => ({
			entries: [...state.entries, entry].slice(-MAX_LOG_ENTRIES),
		})),
	setTailing: (tailing) => set({ isTailing: tailing }),
	clear: () => set({ entries: [] }),
}));

// Expose for Playwright screenshot capture & dev tools
if (typeof window !== "undefined") (window as any).useLogsStore = useLogsStore;
