/**
 * DocTabBar — open-document tab strip for the workspace document viewer (zone 3
 * top). Keeps many documents open and switchable (the user routinely has a large
 * number of work documents open and struggles to find them). Each tab carries an
 * "ask AI" action (✦) that hands the file to the conversation rail, and a close
 * action (×).
 */
interface DocTabBarProps {
	/** Ordered list of open document paths (tabs). */
	docs: string[];
	/** Currently shown document path. */
	activeDoc: string;
	/** Switch the viewer to this document. */
	onSelect: (path: string) => void;
	/** Close (remove) this document tab. */
	onClose: (path: string) => void;
	/** Send this document to the conversation rail as an AI query. */
	onAskAi: (path: string) => void;
}

function basename(p: string): string {
	return p.split(/[/\\]/).pop() || p;
}

export function DocTabBar({
	docs,
	activeDoc,
	onSelect,
	onClose,
	onAskAi,
}: DocTabBarProps) {
	return (
		<div className="doc-tab-bar" role="tablist" aria-label="열린 문서">
			{docs.length === 0 ? (
				<span className="doc-tab-bar__empty">열린 문서 없음</span>
			) : (
				docs.map((path) => (
					<div
						key={path}
						role="tab"
						tabIndex={0}
						aria-selected={path === activeDoc}
						className={`doc-tab${path === activeDoc ? " doc-tab--active" : ""}`}
						onClick={() => onSelect(path)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") onSelect(path);
						}}
						title={path}
					>
						<span className="doc-tab__label">{basename(path)}</span>
						<button
							type="button"
							className="doc-tab__ask"
							title="이 문서를 AI에게 질의"
							aria-label={`AI에게 질의: ${basename(path)}`}
							onClick={(e) => {
								e.stopPropagation();
								onAskAi(path);
							}}
						>
							✦
						</button>
						<button
							type="button"
							className="doc-tab__close"
							aria-label={`문서 닫기: ${basename(path)}`}
							onClick={(e) => {
								e.stopPropagation();
								onClose(path);
							}}
						>
							×
						</button>
					</div>
				))
			)}
		</div>
	);
}
