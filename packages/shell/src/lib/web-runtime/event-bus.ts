export type CallbackFn = (data: unknown) => void;

interface CallbackRecord {
	fn: CallbackFn;
	once: boolean;
}

interface ListenerRecord {
	event: string;
	eventId: number;
	handler: number;
}

const callbackRegistry = new Map<number, CallbackRecord>();
let nextCallbackId = 1;

export function registerCallback(fn: CallbackFn, once = false): number {
	const id = nextCallbackId++;
	callbackRegistry.set(id, { fn, once });
	return id;
}

export function unregisterCallback(id: number): void {
	callbackRegistry.delete(id);
}

export function invokeCallback(id: number, data: unknown): void {
	const entry = callbackRegistry.get(id);
	if (!entry) return;
	if (entry.once) {
		callbackRegistry.delete(id);
	}
	entry.fn(data);
}

let nextEventId = 1;
const listeners: ListenerRecord[] = [];

export function handleEventListen(args: {
	event: string;
	target?: unknown;
	handler: number;
}): number {
	const eventId = nextEventId++;
	listeners.push({ event: args.event, eventId, handler: args.handler });
	return eventId;
}

export function unregisterEventListener(event?: string, eventId?: number): void {
	if (eventId === undefined) return;
	const index = listeners.findIndex(
		(l) => (event ? l.event === event : true) && l.eventId === eventId,
	);
	if (index !== -1) {
		listeners.splice(index, 1);
	}
}

export function handleEventUnlisten(args: {
	event?: string;
	eventId?: number;
}): null {
	unregisterEventListener(args?.event, args?.eventId);
	return null;
}

export function emitWebEvent(event: string, payload: unknown): void {
	const targets = listeners.filter((l) => l.event === event);
	for (const l of targets) {
		invokeCallback(l.handler, {
			event: l.event,
			id: l.eventId,
			payload,
		});
	}
}

export function handleEventEmit(args: {
	event: string;
	payload: unknown;
}): null {
	emitWebEvent(args.event, args.payload);
	return null;
}

/** Reset bus state for isolated test execution */
export function resetEventBus(): void {
	listeners.length = 0;
	nextEventId = 1;
	callbackRegistry.clear();
	nextCallbackId = 1;
}
