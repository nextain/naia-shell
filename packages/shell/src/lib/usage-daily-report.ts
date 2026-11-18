export interface DailyUsageEvent {
	name: string;
	occurred_at: string;
	event_id?: string;
	installation_id?: string;
	sequence?: number;
	screen?: string;
	elapsed_seconds?: number;
}

export type DailyUsageSource =
	| {
			status: "known";
			source: string;
			events: readonly DailyUsageEvent[];
	  }
	| { status: "unknown"; source: string };

type AvailabilityStatus = "확인" | "미확인";
type RateStatus = AvailabilityStatus | "분모 없음";
type MedianStatus = AvailabilityStatus | "분모 없음";

export interface DailyUsageReport {
	dateKst: string;
	timezone: "Asia/Seoul";
	interval: { startInclusive: string; endExclusive: string };
	generatedAt: string;
	sampleNote: string;
	deduplication: string;
	web: {
		source: string;
		status: AvailabilityStatus;
		loginViewCount: number | null;
		loginClickCount: number | null;
		loginOauthDoneCount: number | null;
		loginSuccessRate: {
			numerator: number | null;
			denominator: number | null;
			value: number | null;
			status: RateStatus;
		};
	};
	webgpu: {
		source: string;
		status: AvailabilityStatus;
		modelDownloadStartCount: number | null;
		modelDownloadCompleteCount: number | null;
		modelDownloadFailCount: number | null;
		unsupportedCount: number | null;
		firstReplyCount: number | null;
		firstReplyMedianSeconds: number | null;
		firstReplyMedianStatus: MedianStatus;
	};
	shell: {
		source: string;
		status: AvailabilityStatus;
		dailyActiveInstallations: number | null;
		firstIntroEntryInstallations: number | null;
		loginCredentialsSavedCount: number | null;
		firstReplyInstallations: number | null;
		appStoreOpenClickCount: number | null;
		loginAttemptFailCount: number | null;
	};
}

function assertDate(dateKst: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKst))
		throw new RangeError("dateKst must be YYYY-MM-DD");
	const [year, month, day] = dateKst.split("-").map(Number);
	const utcDay = new Date(Date.UTC(year, month - 1, day));
	if (utcDay.toISOString().slice(0, 10) !== dateKst)
		throw new RangeError("dateKst must be a calendar date");
	return new Date(Date.UTC(year, month - 1, day + 1))
		.toISOString()
		.slice(0, 10);
}

function occurredAtMs(event: DailyUsageEvent): number | null {
	if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(event.occurred_at)) return null;
	const timestamp = Date.parse(event.occurred_at);
	return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Deduplicate one service's rows by event UUID and installation sequence.
 * Keeping the first row makes the result stable for ordered source exports.
 */
export function deduplicateDailyUsageEvents(
	events: readonly DailyUsageEvent[],
): DailyUsageEvent[] {
	const eventIds = new Set<string>();
	const installationSequences = new Set<string>();
	const output: DailyUsageEvent[] = [];
	for (const event of events) {
		const eventId =
			typeof event.event_id === "string" && event.event_id.length > 0
				? event.event_id
				: null;
		const sequenceKey =
			typeof event.installation_id === "string" &&
			event.installation_id.length > 0 &&
			Number.isSafeInteger(event.sequence) &&
			(event.sequence ?? -1) >= 0
				? `${event.installation_id}:${event.sequence}`
				: null;
		if (
			(eventId !== null && eventIds.has(eventId)) ||
			(sequenceKey !== null && installationSequences.has(sequenceKey))
		)
			continue;
		if (eventId !== null) eventIds.add(eventId);
		if (sequenceKey !== null) installationSequences.add(sequenceKey);
		output.push(event);
	}
	return output;
}

function dailyEvents(
	source: DailyUsageSource,
	startMs: number,
	endMs: number,
): DailyUsageEvent[] | null {
	if (source.status === "unknown") return null;
	const inRange = source.events.filter((event) => {
		const timestamp = occurredAtMs(event);
		return timestamp !== null && timestamp >= startMs && timestamp < endMs;
	});
	return deduplicateDailyUsageEvents(inRange);
}

function countNamed(events: readonly DailyUsageEvent[], name: string): number {
	return events.filter((event) => event.name === name).length;
}

function uniqueInstallations(
	events: readonly DailyUsageEvent[],
	predicate: (event: DailyUsageEvent) => boolean,
): number {
	return new Set(
		events
			.filter(
				(event) =>
					predicate(event) &&
					typeof event.installation_id === "string" &&
					event.installation_id.length > 0,
			)
			.map((event) => event.installation_id as string),
	).size;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

export function calculateDailyUsageReport(
	dateKst: string,
	generatedAt: string,
	sources: {
		web: DailyUsageSource;
		webgpu: DailyUsageSource;
		shell: DailyUsageSource;
	},
): DailyUsageReport {
	const nextDateKst = assertDate(dateKst);
	const startInclusive = `${dateKst}T00:00:00+09:00`;
	const endExclusive = `${nextDateKst}T00:00:00+09:00`;
	const startMs = Date.parse(startInclusive);
	const endMs = Date.parse(endExclusive);
	const web = dailyEvents(sources.web, startMs, endMs);
	const webgpu = dailyEvents(sources.webgpu, startMs, endMs);
	const shell = dailyEvents(sources.shell, startMs, endMs);

	const viewCount = web === null ? null : countNamed(web, "login_view");
	const clickCount = web === null ? null : countNamed(web, "login_click");
	const oauthDoneCount =
		web === null ? null : countNamed(web, "login_oauth_done");
	const loginSuccessRate =
		viewCount === null || clickCount === null || oauthDoneCount === null
			? {
					numerator: oauthDoneCount,
					denominator: clickCount,
					value: null,
					status: "미확인" as const,
				}
			: clickCount === 0
				? {
						numerator: oauthDoneCount,
						denominator: clickCount,
						value: null,
						status: "분모 없음" as const,
					}
				: {
						numerator: oauthDoneCount,
						denominator: clickCount,
						value: oauthDoneCount / clickCount,
						status: "확인" as const,
					};

	const firstReplyRows =
		webgpu?.filter((event) => event.name === "webgpu_first_reply") ?? [];
	const elapsedSeconds = firstReplyRows
		.map((event) => event.elapsed_seconds)
		.filter(
			(value): value is number =>
				typeof value === "number" && Number.isFinite(value) && value >= 0,
		);
	const firstReplyMedianSeconds =
		webgpu === null
			? null
			: firstReplyRows.length === 0
				? null
				: elapsedSeconds.length === 0
					? null
					: median(elapsedSeconds);
	const firstReplyMedianStatus: MedianStatus =
		webgpu === null
			? "미확인"
			: firstReplyRows.length === 0
				? "분모 없음"
				: elapsedSeconds.length === 0
					? "미확인"
					: "확인";

	return {
		dateKst,
		timezone: "Asia/Seoul",
		interval: { startInclusive, endExclusive },
		generatedAt,
		sampleNote:
			"동의한 통계 표본만 포함. 웹·웹GPU·셸의 사람 경로를 연결하지 않으며, 다운로드와 설치를 연결하지 않음.",
		deduplication:
			"서비스별 event_id 및 (installation_id, sequence); 두 키가 없는 행은 중복 추정 없이 유지",
		web: {
			source: sources.web.source,
			status: web === null ? "미확인" : "확인",
			loginViewCount: viewCount,
			loginClickCount: clickCount,
			loginOauthDoneCount: oauthDoneCount,
			loginSuccessRate,
		},
		webgpu: {
			source: sources.webgpu.source,
			status: webgpu === null ? "미확인" : "확인",
			modelDownloadStartCount:
				webgpu === null
					? null
					: countNamed(webgpu, "webgpu_model_download_start"),
			modelDownloadCompleteCount:
				webgpu === null
					? null
					: countNamed(webgpu, "webgpu_model_download_complete"),
			modelDownloadFailCount:
				webgpu === null
					? null
					: countNamed(webgpu, "webgpu_model_download_fail"),
			unsupportedCount:
				webgpu === null ? null : countNamed(webgpu, "webgpu_unsupported"),
			firstReplyCount: webgpu === null ? null : firstReplyRows.length,
			firstReplyMedianSeconds,
			firstReplyMedianStatus,
		},
		shell: {
			source: sources.shell.source,
			status: shell === null ? "미확인" : "확인",
			dailyActiveInstallations:
				shell === null
					? null
					: uniqueInstallations(
							shell,
							(event) => event.name === "shell.launch.start",
						),
			firstIntroEntryInstallations:
				shell === null
					? null
					: uniqueInstallations(
							shell,
							(event) =>
								event.name === "intro.screen.view" &&
								event.screen === "welcome",
						),
			loginCredentialsSavedCount:
				shell === null ? null : countNamed(shell, "login.credentials.saved"),
			firstReplyInstallations:
				shell === null
					? null
					: uniqueInstallations(
							shell,
							(event) => event.name === "chat.reply.first",
						),
			appStoreOpenClickCount:
				shell === null
					? null
					: countNamed(shell, "app-bar.open-app-store-5.click"),
			loginAttemptFailCount:
				shell === null ? null : countNamed(shell, "login.attempt.fail"),
		},
	};
}
