import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	Suspense,
	lazy,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type StudioNvaApplyRequest,
	hasPendingStudioNvaTarget,
	isStudioNvaApplyRequest,
} from "../lib/studio-nva-apply-request";
import { ErrorBoundary } from "./ErrorBoundary";

// The dialog, its apply flow, and the NVA manifest checks load only when a
// Studio apply link arrives, so they stay out of the entry bundle.
const StudioNvaApplyDialog = lazy(() =>
	import("./StudioNvaApplyDialog").then((module) => ({
		default: module.StudioNvaApplyDialog,
	})),
);

/**
 * Receives Studio NVA apply links (while open, and pending ones queued while
 * the Shell was closed), de-duplicates them, and shows them one at a time.
 */
export default function StudioNvaApplyHost() {
	const [requests, setRequests] = useState<StudioNvaApplyRequest[]>([]);
	const seenRequestIds = useRef(new Set<string>());
	const request = requests[0] ?? null;

	const addRequest = useCallback((candidate: unknown) => {
		if (
			!isStudioNvaApplyRequest(candidate) ||
			seenRequestIds.current.has(candidate.requestId)
		)
			return;
		seenRequestIds.current.add(candidate.requestId);
		setRequests((current) =>
			hasPendingStudioNvaTarget(current, candidate)
				? current
				: [...current, candidate],
		);
	}, []);

	useEffect(() => {
		let active = true;
		const unlisten = listen<StudioNvaApplyRequest>(
			"studio_nva_apply_requested",
			(event) => {
				if (active) addRequest(event.payload);
			},
		);
		void invoke<StudioNvaApplyRequest[]>("studio_nva_apply_pending")
			.then((pending) => {
				if (active) pending.forEach(addRequest);
			})
			.catch(() => {});
		return () => {
			active = false;
			void unlisten.then((stop) => stop()).catch(() => {});
		};
	}, [addRequest]);

	const closeCurrent = useCallback(() => {
		setRequests((current) => current.slice(1));
	}, []);

	if (!request) return null;
	return (
		<ErrorBoundary scope="StudioNvaApplyDialog" resetKey={request.requestId}>
			<Suspense fallback={null}>
				<StudioNvaApplyDialog request={request} onClose={closeCurrent} />
			</Suspense>
		</ErrorBoundary>
	);
}
