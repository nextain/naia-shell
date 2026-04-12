import { invoke } from "@tauri-apps/api/core";

// === Agent Memory (reads from Agent's ~/.naia/memory/alpha-memory.json) ===

/** Agent's semantic Fact — matches agent/src/memory/types.ts Fact interface */
export interface AgentFact {
	id: string;
	content: string;
	entities: string[];
	topics: string[];
	createdAt: number;
	updatedAt: number;
	importance: number;
	recallCount: number;
	lastAccessed: number;
	strength: number;
	sourceEpisodes: string[];
}

export async function getAllAgentFacts(): Promise<AgentFact[]> {
	return invoke("memory_get_all_facts");
}

export async function deleteAgentFact(factId: string): Promise<boolean> {
	return invoke("memory_delete_fact", { factId });
}

/**
 * Export an encrypted memory backup via Tauri IPC → Agent → LocalAdapter.export().
 * Returns raw encrypted bytes.
 */
export async function exportMemoryBackup(password: string): Promise<Uint8Array> {
	const bytes = await invoke<number[]>("memory_export_backup", { password });
	return new Uint8Array(bytes);
}

/**
 * Import an encrypted memory backup via Tauri IPC → Agent → LocalAdapter.import().
 */
export async function importMemoryBackup(
	blob: Uint8Array,
	password: string,
): Promise<void> {
	return invoke("memory_import_backup", { blob: Array.from(blob), password });
}

// === Onboarding: API key validation ===

export async function validateApiKey(
	provider: string,
	apiKey: string,
): Promise<boolean> {
	return invoke("validate_api_key", { provider, apiKey });
}
