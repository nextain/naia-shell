export interface OllamaThinkingUnsupportedStatus {
	readonly host: string;
	readonly model: string;
}

type StatusListener = () => void;

let currentStatus: OllamaThinkingUnsupportedStatus | null = null;
const listeners = new Set<StatusListener>();

export function getOllamaThinkingUnsupportedStatus(): OllamaThinkingUnsupportedStatus | null {
	return currentStatus;
}

export function matchesOllamaThinkingUnsupportedStatus(
	status: OllamaThinkingUnsupportedStatus | null,
	host: string,
	model: string,
): boolean {
	return status?.host === host && status.model === model;
}

export function subscribeOllamaThinkingUnsupportedStatus(
	listener: StatusListener,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function parseOllamaThinkingUnsupportedMessage(
	message: unknown,
): OllamaThinkingUnsupportedStatus | null {
	if (typeof message !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(message);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"host" in parsed &&
			typeof parsed.host === "string" &&
			parsed.host.length > 0 &&
			"model" in parsed &&
			typeof parsed.model === "string" &&
			parsed.model.length > 0
		) {
			return { host: parsed.host, model: parsed.model };
		}
	} catch {
		return null;
	}
	return null;
}

export function recordOllamaThinkingUnsupportedStatus(
	status: OllamaThinkingUnsupportedStatus,
): void {
	if (
		currentStatus?.host === status.host &&
		currentStatus.model === status.model
	) {
		return;
	}
	currentStatus = status;
	for (const listener of listeners) listener();
}
