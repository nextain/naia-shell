import { useEffect, useRef, useState } from "react";
import {
	makeAxApprovalAdapter,
	type AxApprovalCard,
	type AxHostControlPort,
} from "../lib/ax-approval-adapter";
import { t } from "../lib/i18n";

/** Unmounted draft. Composition must supply an authenticated host connection,
 * not a chat RPC. Evidence is supplied by that host at capture start. */
export function AxApprovalDraft({
	card,
	host,
	evidence,
	onSettled,
}: {
	card: AxApprovalCard;
	host: AxHostControlPort;
	evidence: () => unknown;
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
			aria-label={t("axApproval.title")}
			style={{
				maxWidth: 560,
				padding: 16,
				boxSizing: "border-box",
				overflowWrap: "anywhere",
			}}
		>
			<h2>{t("axApproval.title")}</h2>
			<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
				{card.preview}
			</pre>
			<p>
				{card.mode === "code"
					? t("axApproval.codePrompt")
					: t("axApproval.typePrompt")}
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
					{t("axApproval.responseLabel")}
					<input
						aria-label={t("axApproval.responseLabel")}
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
					{t("axApproval.submit")}
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
					{t("axApproval.cancel")}
				</button>
			</form>
			{inputError && <p role="alert">{t("axApproval.inputError")}</p>}
			{(!ready || settled) && (
				<p role="status">
					{settled
						? approved
							? t("axApproval.delivered")
							: t("axApproval.notApproved")
						: t("axApproval.checkConnection")}
				</p>
			)}
		</section>
	);
}
