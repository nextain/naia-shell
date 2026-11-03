import { useEffect, useRef, useState } from "react";
import {
	makeAxApprovalAdapter,
	type AxApprovalCard,
	type AxHostControlPort,
} from "../lib/ax-approval-adapter";

/** Unmounted draft. Composition must supply an authenticated host connection,
 * not a chat RPC. Evidence is supplied by that host at capture start. */
export function AxApprovalDraft({
	card,
	host,
	evidence,
	locale = "ko",
	onSettled,
}: {
	card: AxApprovalCard;
	host: AxHostControlPort;
	evidence: () => unknown;
	locale?: "ko" | "en";
	onSettled: (approved: boolean) => void;
}) {
	const [text, setText] = useState("");
	const [ready, setReady] = useState(false);
	const [settled, setSettled] = useState(false);
	const [approved, setApproved] = useState(false);
	const [inputError, setInputError] = useState(false);
	const adapterRef = useRef<ReturnType<typeof makeAxApprovalAdapter> | null>(
		null,
	);
	const capturedRef = useRef(false);
	const mountLeaseRef = useRef(0);
	const mountedHostRef = useRef(host);
	const ko = locale === "ko";
	useEffect(() => {
		const adapter = makeAxApprovalAdapter(host);
		adapterRef.current = adapter;
		adapter.present(card);
		capturedRef.current = false;
		setText("");
		setSettled(false);
		setApproved(false);
		setInputError(false);
		setReady(adapter.displayed(card.proposalId));
		// Host present already replaced the previous proposal. Do not invalidate
		// that new proposal while React cleans up the old card.
		return () => {
			adapterRef.current = null;
		};
	}, [card, host, evidence]);
	useEffect(() => {
		const lease = ++mountLeaseRef.current;
		mountedHostRef.current = host;
		return () => {
			// React StrictMode replays mount effects. Retire local input now,
			// then invalidate the host only if this mount was actually removed.
			capturedRef.current = false;
			queueMicrotask(() => {
				if (mountLeaseRef.current === lease || mountedHostRef.current !== host)
					host.invalidate();
			});
		};
	}, [host]);
	return (
		<section
			role="dialog"
			aria-modal="false"
			aria-label={ko ? "작업 승인 검토" : "Review action approval"}
			style={{
				maxWidth: 560,
				padding: 16,
				boxSizing: "border-box",
				overflowWrap: "anywhere",
			}}
		>
			<h2>{ko ? "작업 승인 검토" : "Review action approval"}</h2>
			<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
				{card.preview}
			</pre>
			<p>
				{card.mode === "code"
					? ko
						? "검토한 계획의 별도 승인 코드를 입력하세요."
						: "Enter the separate approval code for the reviewed plan."
					: ko
						? "내용을 확인한 뒤 승인하려면 ‘보내’를 입력하세요. 거절하려면 취소하세요."
						: "Review the action, then type 보내 to approve. Choose Cancel to decline."}
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (settled || !ready || !capturedRef.current) return;
					setSettled(true);
					setText("");
					const accepted = adapterRef.current?.submit(text) === true;
					setApproved(accepted);
					onSettled(accepted);
				}}
			>
				<label>
					{ko ? "승인 응답" : "Approval response"}
					<input
						aria-label={ko ? "승인 응답" : "Approval response"}
						value={text}
						disabled={!ready || settled}
						autoComplete="off"
						style={{ width: "100%", boxSizing: "border-box" }}
						onChange={(event) => {
							if (!capturedRef.current)
								capturedRef.current =
									adapterRef.current?.beginInput(evidence()) === true;
							setInputError(!capturedRef.current);
							setText(capturedRef.current ? event.target.value : "");
						}}
					/>
				</label>
				<button type="submit" disabled={!ready || settled || !text}>
					{ko ? "응답 제출" : "Submit response"}
				</button>
				<button
					type="button"
					disabled={settled}
					onClick={() => {
						adapterRef.current?.invalidate();
						setInputError(false);
						setText("");
						setSettled(true);
						onSettled(false);
					}}
				>
					{ko ? "취소" : "Cancel"}
				</button>
			</form>
			{inputError && (
				<p role="alert">
					{ko
						? "입력을 확인하지 못했습니다. 승인 연결을 확인한 뒤 다시 입력하거나 취소하세요."
						: "Input could not be verified. Check the approval connection, then enter again or cancel."}
				</p>
			)}
			{(!ready || settled) && (
				<p role="status">
					{settled
						? ko
							? approved
								? "승인 응답을 전달했습니다."
								: "승인하지 않았습니다. 다시 검토하려면 새 요청을 시작하세요."
							: approved
								? "Approval response delivered."
								: "Not approved. Start a new request to review again."
						: ko
							? "승인 연결을 확인하세요."
							: "Check the approval connection."}
				</p>
			)}
		</section>
	);
}
