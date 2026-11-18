import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";

type MermaidApi = typeof import("mermaid")["default"];

let mermaidPromise: Promise<MermaidApi> | undefined;

function loadMermaid(): Promise<MermaidApi> {
	mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
		mermaid.initialize({
			startOnLoad: false,
			theme: "dark",
			securityLevel: "strict",
			htmlLabels: false,
			flowchart: { htmlLabels: false },
			sequence: { useHtmlLabels: false } as Record<string, unknown>,
		});
		return mermaid;
	});
	return mermaidPromise;
}

let mermaidIdCounter = 0;

export function highlightCode(code: string, language: string): string {
	const normalized = language.toLowerCase();
	const highlighted = hljs.getLanguage(normalized)
		? hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value
		: hljs.highlight(code, { language: "plaintext" }).value;
	return DOMPurify.sanitize(highlighted, {
		ALLOWED_TAGS: ["span"],
		ALLOWED_ATTR: ["class"],
	});
}

/**
 * Clipboard action shared by the code block and the Mermaid failure screen.
 *
 * The failure screen used to show the source and nothing else, so the only way
 * out was to select the text by hand. It now reuses this exact button.
 */
function CopyCodeButton({ code }: { code: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			data-usage-event="markdown-code-block.set-copied-1.click"
			onClick={() => {
				void navigator.clipboard.writeText(code).then(() => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1600);
				});
			}}
			aria-live="polite"
		>
			{copied ? t("chat.codeCopied") : t("chat.codeCopy")}
		</button>
	);
}

/** Shared safe Mermaid renderer for chat and workspace Markdown. */
export function MermaidBlock({ code }: { code: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	// Bumped by the retry button so the same source is rendered again — a failed
	// import or a transient worker error does not have to be permanent.
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!containerRef.current || !code.trim()) return;
		const id = `mermaid-${++mermaidIdCounter}`;
		let cancelled = false;
		void loadMermaid()
			.then((mermaid) => mermaid.render(id, code.trim()))
			.then(({ svg }) => {
				if (!cancelled && containerRef.current) {
					containerRef.current.innerHTML = DOMPurify.sanitize(svg, {
						USE_PROFILES: { svg: true, svgFilters: true },
					});
					setError(null);
				}
			})
			.catch((cause) => {
				if (!cancelled) setError(String(cause?.message ?? cause));
			});
		return () => {
			cancelled = true;
		};
	}, [code, attempt]);

	if (error) {
		return (
			<div className="markdown-mermaid-error" role="alert">
				<div>{t("chat.mermaidError")}</div>
				<div className="chat-code-actions">
					<CopyCodeButton code={code} />
					<button
						type="button"
						data-usage-event="markdown-code-block.set-error-2.click"
						onClick={() => {
							setError(null);
							setAttempt((count) => count + 1);
						}}
					>
						{t("common.retry")}
					</button>
				</div>
				<pre>
					<code>{code}</code>
				</pre>
			</div>
		);
	}
	return <div ref={containerRef} className="workspace-editor__mermaid" />;
}

interface MarkdownCodeBlockProps {
	className?: string;
	children?: ReactNode;
	onOpenWorkspace?: (code: string, language: string) => void;
}

export function MarkdownCodeBlock({
	className,
	children,
	onOpenWorkspace,
}: MarkdownCodeBlockProps) {
	const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "text";
	const code = String(children).replace(/\n$/, "");
	if (language.toLowerCase() === "mermaid") return <MermaidBlock code={code} />;
	// react-markdown also calls this override for inline code.
	if (!className) return <code>{children}</code>;
	return (
		<details className="chat-code-block" open>
			<summary>
				<span className="chat-code-language">{language}</span>
			</summary>
			<div className="chat-code-actions">
				<CopyCodeButton code={code} />
				{onOpenWorkspace ? (
					<button
						type="button"
						data-usage-event="markdown-code-block.on-open-workspace-3.click"
						onClick={() => onOpenWorkspace(code, language)}
					>
						워크스페이스에서 열기
					</button>
				) : null}
			</div>
			<pre>
				{/* DOMPurify restricts this highlighted fragment to span/class only. */}
				<code
					className={className}
					// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized syntax-highlight markup
					dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }}
				/>
			</pre>
		</details>
	);
}
