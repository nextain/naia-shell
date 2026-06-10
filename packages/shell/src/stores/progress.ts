import { create } from "zustand";
import type { AuditEvent, AuditStats } from "../lib/types";

interface ProgressState {
	events: AuditEvent[];
	stats: AuditStats | null;
	isLoading: boolean;

	setEvents: (events: AuditEvent[]) => void;
	setStats: (stats: AuditStats) => void;
	setLoading: (loading: boolean) => void;
}

export const useProgressStore = create<ProgressState>()((set) => ({
	events: [],
	stats: null,
	isLoading: false,

	setEvents: (events) => set({ events }),
	setStats: (stats) => set({ stats }),
	setLoading: (loading) => set({ isLoading: loading }),
}));

// Expose for Playwright screenshot capture & dev tools
if (typeof window !== "undefined")
	(window as any).useProgressStore = useProgressStore;
