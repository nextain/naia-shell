// Small, entry-safe part of the Studio NVA apply feature: the request shape
// received from a deep link and the de-duplication rule. The apply flow itself
// lives in studio-nva-apply.ts and is loaded lazily with the dialog.

export type StudioNvaApplyEnvironment = "production" | "development";

export interface StudioNvaApplyRequest {
	requestId: string;
	avatarId: string;
	environment: StudioNvaApplyEnvironment;
}

export interface StudioNvaApplyTarget {
	avatarId: string;
	environment: string;
}

export function isStudioNvaApplyRequest(
	value: unknown,
): value is StudioNvaApplyRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Record<string, unknown>;
	return (
		typeof request.requestId === "string" &&
		typeof request.avatarId === "string" &&
		(request.environment === "production" ||
			request.environment === "development")
	);
}

/** Same avatar on the same environment: a repeated click on one link. */
export function hasPendingStudioNvaTarget(
	pending: readonly StudioNvaApplyTarget[],
	candidate: StudioNvaApplyTarget,
): boolean {
	return pending.some(
		(item) =>
			item.avatarId === candidate.avatarId &&
			item.environment === candidate.environment,
	);
}
