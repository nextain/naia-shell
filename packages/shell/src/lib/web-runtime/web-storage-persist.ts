import { Logger } from "../logger";

export type WebStoragePersistPhase =
	| "checking"
	| "persisted"
	| "denied"
	| "unsupported";

export interface WebStoragePersistState {
	phase: WebStoragePersistPhase;
	usageBytes: number | null;
	quotaBytes: number | null;
}

export interface StorageManagerLike {
	persisted?: () => Promise<boolean>;
	persist?: () => Promise<boolean>;
	estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

const INITIAL_STATE: WebStoragePersistState = {
	phase: "checking",
	usageBytes: null,
	quotaBytes: null,
};

let currentState: WebStoragePersistState = { ...INITIAL_STATE };
const listeners = new Set<() => void>();

function setState(next: WebStoragePersistState): WebStoragePersistState {
	currentState = next;
	for (const listener of listeners) {
		listener();
	}
	return currentState;
}

export function getWebStoragePersistState(): WebStoragePersistState {
	return currentState;
}

export function subscribeWebStoragePersistState(
	listener: () => void,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function resetWebStoragePersistStateForTests(
	override?: Partial<WebStoragePersistState>,
): void {
	currentState = { ...INITIAL_STATE, ...(override ?? {}) };
	for (const listener of listeners) {
		listener();
	}
}

export function formatStorageBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1)} MB`;
	const gb = mb / 1024;
	return `${gb.toFixed(2)} GB`;
}

export function formatWebStorageSummaryLine(
	state: WebStoragePersistState,
): string {
	const usagePart =
		state.usageBytes !== null &&
		state.quotaBytes !== null &&
		state.quotaBytes > 0
			? `사용량 ${formatStorageBytes(state.usageBytes)} / ${formatStorageBytes(state.quotaBytes)}`
			: state.usageBytes !== null
				? `사용량 ${formatStorageBytes(state.usageBytes)}`
				: "";

	if (state.phase === "denied") {
		return usagePart
			? `브라우저가 저장소 보존을 허용하지 않음 · ${usagePart}`
			: "브라우저가 저장소 보존을 허용하지 않음";
	}
	if (state.phase === "persisted") {
		return usagePart ? `영구 보존 허용됨 · ${usagePart}` : "영구 보존 허용됨";
	}
	if (state.phase === "unsupported") {
		return usagePart
			? `브라우저가 저장소 보존을 지원하지 않음 · ${usagePart}`
			: "브라우저가 저장소 보존을 지원하지 않음";
	}
	return usagePart
		? `저장소 보존 확인 중… · ${usagePart}`
		: "저장소 보존 확인 중…";
}

async function readEstimate(
	mgr: StorageManagerLike,
): Promise<{ usageBytes: number | null; quotaBytes: number | null }> {
	if (typeof mgr.estimate !== "function") {
		return { usageBytes: null, quotaBytes: null };
	}
	try {
		const est = await mgr.estimate();
		return {
			usageBytes:
				typeof est?.usage === "number" && Number.isFinite(est.usage)
					? est.usage
					: null,
			quotaBytes:
				typeof est?.quota === "number" && Number.isFinite(est.quota)
					? est.quota
					: null,
		};
	} catch {
		return { usageBytes: null, quotaBytes: null };
	}
}

/**
 * 웹판 시작 시 `navigator.storage.persisted()` 를 먼저 확인해 이미 허용이면
 * `persist()` 호출을 건너뛰고, 아직 허용되지 않았을 때만 `navigator.storage.persist()` 를 요청한다.
 * 함께 `navigator.storage.estimate()` 로 현재 사용량을 읽는다.
 */
export async function requestWebPersistentStorage(
	storageManager?: StorageManagerLike | null,
): Promise<WebStoragePersistState> {
	const mgr: StorageManagerLike | null =
		storageManager !== undefined
			? storageManager
			: typeof navigator !== "undefined" && navigator.storage
				? (navigator.storage as StorageManagerLike)
				: null;

	if (
		!mgr ||
		(typeof mgr.persisted !== "function" && typeof mgr.persist !== "function")
	) {
		return setState({
			phase: "unsupported",
			usageBytes: null,
			quotaBytes: null,
		});
	}

	let granted = false;
	try {
		const alreadyPersisted =
			typeof mgr.persisted === "function" ? await mgr.persisted() : false;
		if (alreadyPersisted) {
			granted = true;
		} else if (typeof mgr.persist === "function") {
			granted = await mgr.persist();
		}
	} catch (err) {
		Logger.warn("WebRuntime", "storage.persist() failed", {
			error: String(err),
		});
		granted = false;
	}

	const { usageBytes, quotaBytes } = await readEstimate(mgr);
	return setState({
		phase: granted ? "persisted" : "denied",
		usageBytes,
		quotaBytes,
	});
}
