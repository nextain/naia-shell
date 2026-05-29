/**
 * On-demand Pod retry logic per CLIENT-ONDEMAND-CONTRACT.md §3, §4, §7.
 *
 * Handles 503 pod-starting (exponential backoff, 5min cap),
 * 503 sold-out (immediate throw), and abandon (user cancel).
 */

const COLD_START_CAP_MS = 5 * 60 * 1000; // 5 min
const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export class SoldOutError extends Error {
	tierAHint: string;
	constructor(hint?: string) {
		super("sold-out");
		this.name = "SoldOutError";
		this.tierAHint = hint ?? "";
	}
}

export class ColdStartTimeoutError extends Error {
	constructor() {
		super("Cold start exceeded 5 minute cap");
		this.name = "ColdStartTimeoutError";
	}
}

export class ConsentRequiredError extends Error {
	branches: string[];
	constructor(branches?: string[]) {
		super("consent-required");
		this.name = "ConsentRequiredError";
		this.branches = branches ?? ["replace", "add"];
	}
}

export interface ColdStartProgress {
	elapsedSeconds: number;
	podState: string;
	retryAfterSeconds: number;
}

/**
 * Fetch with on-demand Pod retry (CONTRACT §7).
 * Returns Response on success (200). Throws on sold-out, timeout, auth, etc.
 */
export async function callWithRetry(
	url: string,
	init: RequestInit,
	onProgress?: (p: ColdStartProgress) => void,
	signal?: AbortSignal,
): Promise<Response> {
	const start = Date.now();
	let delay = INITIAL_RETRY_MS;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const resp = await fetch(url, { ...init, signal });

		if (resp.status !== 503) return resp;

		const body = await resp.json().catch(() => ({} as Record<string, unknown>));
		const error = (body as Record<string, unknown>).error as string | undefined;

		if (error === "sold-out") {
			throw new SoldOutError(
				(body as Record<string, unknown>).tier_a_hint as string | undefined,
			);
		}

		if (error === "pod-starting") {
			if (Date.now() - start > COLD_START_CAP_MS) {
				throw new ColdStartTimeoutError();
			}
			const hint =
				((body as Record<string, unknown>).retry_after_seconds as number) *
					1000 || delay;
			onProgress?.({
				elapsedSeconds:
					(body as Record<string, unknown>).elapsed_seconds as number ??
					Math.round((Date.now() - start) / 1000),
				podState:
					((body as Record<string, unknown>).pod_state as string) ?? "STARTING",
				retryAfterSeconds: Math.round(hint / 1000),
			});
			await sleep(Math.min(hint, MAX_RETRY_MS), signal);
			delay = Math.min(delay * 2, MAX_RETRY_MS);
			continue;
		}

		if (error === "capacity-exhausted") {
			throw new SoldOutError("capacity-exhausted");
		}

		throw new Error(error ?? `503: ${JSON.stringify(body)}`);
	}
}

/**
 * Abandon a starting Pod (CONTRACT §3.4).
 */
export async function abandonPod(
	gatewayUrl: string,
	instanceId: string,
	apiKey: string,
): Promise<void> {
	await fetch(`${gatewayUrl}/v1/pods/abandon`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ instance_id: instanceId }),
	}).catch(() => {});
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}
