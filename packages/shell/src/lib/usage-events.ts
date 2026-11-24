import { usageControls } from "./usage-inventory";

export const USAGE_CONSENT_KEY = "naia-usage-consent-v1";
export const USAGE_STATE_KEY = "naia-usage-state-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const intro = [
	"welcome",
	"agentName",
	"userName",
	"speechStyle",
	"character",
	"background",
	"provider",
	"voice",
	"complete",
];
const apps = [
	"home",
	"browser",
	"workspace",
	"app-store",
	"settings",
	"projects",
	"sample-note",
	"other",
];
const tabs = [
	"profile",
	"brain",
	"voice",
	"avatar",
	"persona",
	"memory",
	"knowledge",
	"skills",
	"general",
];
const semantic: Record<string, readonly string[]> = {
	"shell.start.observed": ["shell"],
	"shell.launch.start": ["shell"],
	"intro.screen.view": intro,
	"intro.navigation.click": intro,
	"intro.provider.choose": ["provider"],
	"intro.welcome.link": ["welcome"],
	"intro.speech.select": ["speechStyle"],
	"intro.character.select": ["character"],
	"intro.background.select": ["background"],
	"intro.voice.select": ["voice"],
	"intro.voice.preview": ["voice"],
	"home.menu.open": ["home"],
	"home.shortcut.click": ["home"],
	"settings.option.click": ["settings"],
	"settings.voice.click": ["voice"],
	"settings.save.click": ["settings"],
	"settings.update.check": ["settings"],
	"intro.finish.saved": ["manual", "start"],
	"login.browser.start": ["intro", "settings"],
	"login.credentials.saved": ["intro", "settings"],
	"login.credentials.restored": ["intro", "settings"],
	"login.attempt.fail": ["intro", "settings"],
	"app.screen.view": apps,
	"settings.tab.open": tabs,
	"chat.message.send": ["text", "voice"],
	"chat.voice.toggle": ["chat"],
	"chat.voice.cancel": ["chat"],
	"chat.session.new": ["chat"],
	"chat.reply.first": ["text", "voice"],
	"privacy.choice.select": ["allow", "enable"],
};
const choices: Record<string, readonly string[]> = {
	"intro.navigation.click": ["back", "next", "start"],
	"intro.provider.choose": ["naia_start", "manual", "later"],
	"intro.welcome.link": ["github", "discord", "donate"],
	"intro.speech.select": ["select"],
	"intro.character.select": ["vrm", "nva"],
	"intro.background.select": ["select"],
	"intro.voice.select": ["enable", "disable", "host", "local"],
	"intro.voice.preview": ["host"],
	"home.menu.open": ["home", "browser", "workspace", "app-store", "settings"],
	"home.shortcut.click": ["open", "add", "edit", "remove"],
	"settings.option.click": ["select", "import", "remove", "reset"],
	"settings.voice.click": ["preview", "microphone", "test"],
};
type Fields = { attempt_id?: string; failure?: string; choice?: string };
const failures = ["cancel", "browser_open", "timeout", "validation", "storage"];
export interface UsageEvent {
	name: string;
	screen: string;
	installation_id: string;
	event_id: string;
	sequence: number;
	occurred_at: string;
	version: string;
	platform: "windows" | "macos" | "linux" | "unknown";
	channel: "standard" | "steam" | "unknown";
	attempt_id?: string;
	failure?: string;
	choice?: string;
}
type State = { id: string; sequence: number; firstReply: boolean };
type Consent = { enabled: boolean; epoch: string };
type Queued = { event: UsageEvent; born: number; retries: number };
export interface UsageEnvironment {
	storage: Pick<Storage, "getItem" | "setItem">;
	lock: <T>(fn: () => T | Promise<T>) => Promise<T>;
	uuid: () => string;
	now: () => number;
	online: () => boolean;
	send: (events: UsageEvent[], signal: AbortSignal) => Promise<void>;
	onDisable?: () => void;
	configured: boolean;
	version: string;
	platform: UsageEvent["platform"];
	channel: UsageEvent["channel"];
}

/** Deliberately no SDK auto-collection, disk queue, cookies or account context. */
export class UsageEvents {
	private queue: Queued[] = [];
	private controller: AbortController | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private started = false;
	private generation = 0;
	private blocked = false;
	private enabledEpoch: string | null = null;
	lost = 0;
	constructor(private env: UsageEnvironment) {}
	choice(): Consent | null {
		try {
			const value = JSON.parse(
				this.env.storage.getItem(USAGE_CONSENT_KEY) ?? "null",
			);
			return typeof value?.enabled === "boolean" &&
				typeof value.epoch === "string"
				? value
				: null;
		} catch {
			return null;
		}
	}
	private enabled(): boolean {
		return (
			!this.blocked && this.env.configured && this.choice()?.enabled === true
		);
	}
	async choose(enabled: boolean): Promise<boolean> {
		// Disable locally before waiting for any lock, then notify peers via storage.
		if (!enabled) {
			this.suspend();
			this.env.onDisable?.();
		}
		try {
			this.env.storage.setItem(
				USAGE_CONSENT_KEY,
				JSON.stringify({ enabled, epoch: this.env.uuid() }),
			);
			this.blocked = false;
			await this.sync();
			if (enabled) this.record("privacy.choice.select", "enable");
			return true;
		} catch {
			this.blocked = true;
			this.stop();
			return false;
		}
	}
	suspend(): void {
		this.blocked = true;
		this.stop();
	}
	async refreshConsent(): Promise<void> {
		this.blocked = false;
		await this.sync();
	}
	async sync(): Promise<void> {
		if (!this.enabled()) {
			this.stop();
			return;
		}
		const epoch = this.choice()?.epoch ?? null;
		if (epoch !== this.enabledEpoch) {
			this.stop();
			this.enabledEpoch = epoch;
		}
		if (this.started) return;
		this.started = true;
		await this.enqueue("shell.launch.start", "shell", {}, true);
	}
	stop(): void {
		this.generation++;
		this.started = false;
		this.enabledEpoch = null;
		this.queue.length = 0;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.controller?.abort();
	}
	get pending(): number {
		return this.queue.length;
	}
	record(name: string, screen: string, fields: Fields = {}): void {
		if (!this.enabled()) return;
		// Reject extra keys at runtime too; TypeScript alone is not a privacy boundary.
		if (!fields || typeof name !== "string" || typeof screen !== "string")
			return;
		if (
			Object.keys(fields).some(
				(k) => !["attempt_id", "failure", "choice"].includes(k),
			)
		)
			return;
		if (
			fields.choice !== undefined &&
			!(
				Object.prototype.hasOwnProperty.call(choices, name) &&
				choices[name].includes(fields.choice)
			)
		)
			return;
		const control = Object.prototype.hasOwnProperty.call(usageControls, name)
			? usageControls[name as keyof typeof usageControls]
			: undefined;
		if (
			control
				? control.screen !== screen
				: !(
						Object.prototype.hasOwnProperty.call(semantic, name) &&
						semantic[name].includes(screen)
					)
		)
			return;
		if (
			fields.attempt_id !== undefined &&
			(!name.startsWith("login.") || !UUID.test(fields.attempt_id))
		)
			return;
		if (
			fields.failure !== undefined &&
			(name !== "login.attempt.fail" || !failures.includes(fields.failure))
		)
			return;
		if (
			[
				"login.browser.start",
				"login.credentials.saved",
				"login.attempt.fail",
			].includes(name) &&
			!fields.attempt_id
		)
			return;
		void this.enqueue(name, screen, {
			...(fields.attempt_id ? { attempt_id: fields.attempt_id } : {}),
			...(fields.failure ? { failure: fields.failure } : {}),
			...(fields.choice ? { choice: fields.choice } : {}),
		});
	}
	private async enqueue(
		name: string,
		screen: string,
		fields: Fields,
		launch = false,
	): Promise<void> {
		const generation = this.generation;
		const epoch = this.choice()?.epoch;
		const now = this.env.now();
		try {
			await this.env.lock(() => {
				if (
					!this.enabled() ||
					generation !== this.generation ||
					epoch !== this.choice()?.epoch
				)
					return;
				let state: State | null = JSON.parse(
					this.env.storage.getItem(USAGE_STATE_KEY) ?? "null",
				);
				if (
					!state ||
					!UUID.test(state.id) ||
					!Number.isSafeInteger(state.sequence) ||
					state.sequence < 0 ||
					state.sequence >= Number.MAX_SAFE_INTEGER
				) {
					state = { id: this.env.uuid(), sequence: 0, firstReply: false };
				}
				if (name === "chat.reply.first" && state.firstReply) return;
				const push = (eventName: string, eventScreen: string) => {
					const event: UsageEvent = {
						name: eventName,
						screen: eventScreen,
						installation_id: state.id,
						event_id: this.env.uuid(),
						sequence: ++state.sequence,
						occurred_at: new Date(now).toISOString(),
						version: this.env.version,
						platform: this.env.platform,
						channel: this.env.channel,
						...fields,
					};
					if (new TextEncoder().encode(JSON.stringify(event)).length > 2048)
						return;
					if (this.queue.length === 50) {
						this.queue.shift();
						this.lost++;
					}
					this.queue.push({ event, born: now, retries: 0 });
				};
				if (state.sequence === 0) push("shell.start.observed", "shell");
				if (name === "chat.reply.first") state.firstReply = true;
				push(name, screen);
				this.env.storage.setItem(USAGE_STATE_KEY, JSON.stringify(state));
			});
			if (
				generation === this.generation &&
				this.enabled() &&
				(launch || this.queue.length)
			)
				this.schedule();
		} catch {
			this.blocked = true;
			this.stop();
		}
	}
	private schedule(): void {
		if (this.timer || this.controller || !this.enabled()) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, 5000);
	}
	async flush(): Promise<void> {
		if (!this.enabled() || this.enabledEpoch !== this.choice()?.epoch) {
			this.stop();
			return;
		}
		if (this.controller) return;
		if (!this.env.online()) {
			this.lost += this.queue.length;
			this.queue.length = 0;
			return;
		}
		const generation = this.generation;
		const epoch = this.choice()?.epoch;
		const batch = this.queue.splice(0).filter((q) => {
			if (this.env.now() - q.born < 600000) return true;
			this.lost++;
			return false;
		});
		if (!batch.length) return;
		const controller = new AbortController();
		this.controller = controller;
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			await this.env.send(
				batch.map((q) => q.event),
				controller.signal,
			);
		} catch {
			if (
				generation === this.generation &&
				epoch === this.choice()?.epoch &&
				this.enabled() &&
				this.env.online()
			) {
				for (const q of batch) {
					if (q.retries === 0 && this.env.now() - q.born < 600000) {
						q.retries++;
						this.queue.push(q);
					} else this.lost++;
				}
				while (this.queue.length > 50) {
					this.queue.sort((a, b) => a.event.sequence - b.event.sequence);
					this.queue.shift();
					this.lost++;
				}
			} else this.lost += batch.length;
		} finally {
			clearTimeout(timeout);
			this.controller = null;
			if (this.queue.length && this.enabled()) this.schedule();
		}
	}
}

export function parseUsageConnection(
	raw: string | undefined,
): { key: string; url: string } | null {
	if (!raw) return null;
	const pairs = Object.fromEntries(
		raw
			.split(";")
			.filter(Boolean)
			.map((part) => {
				const i = part.indexOf("=");
				return [
					part.slice(0, i).trim().toLowerCase(),
					part.slice(i + 1).trim(),
				];
			}),
	);
	if (!UUID.test(pairs.instrumentationkey ?? "")) return null;
	try {
		const endpoint = new URL(
			pairs.ingestionendpoint || "https://dc.services.visualstudio.com",
		);
		if (
			endpoint.protocol !== "https:" ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash ||
			endpoint.port ||
			!(
				/(^|\.)applicationinsights\.(azure\.com|azure\.cn|us)$/.test(
					endpoint.hostname,
				) || endpoint.hostname === "dc.services.visualstudio.com"
			)
		)
			return null;
		return {
			key: pairs.instrumentationkey,
			url: new URL("/v2.1/track", endpoint).href,
		};
	} catch {
		return null;
	}
}

export function usageEnvelope(event: UsageEvent, key: string) {
	return {
		name: "Microsoft.ApplicationInsights.Event",
		time: event.occurred_at,
		iKey: key,
		tags: {},
		data: {
			baseType: "EventData",
			baseData: {
				ver: 2,
				name: event.name,
				properties: { ...event, sequence: String(event.sequence) },
			},
		},
	};
}
