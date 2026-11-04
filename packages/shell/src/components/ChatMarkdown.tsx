import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { appRegistry } from "../lib/app-registry";
import { useAppStore } from "../stores/app";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

const FILE_PATH_RE =
	/(?<![/\w])(\/[\w\-\.\/]+\.(?:png|jpe?g|gif|webp|csv|json|log|pdf|tsx|ts|jsx|js|rs|py|md|yaml|yml|sh|toml)(?![.\w]))/;

function openFileInWorkspace(path: string): void {
	appRegistry.getApi("workspace")?.openFile(path);
	useAppStore.getState().setActiveApp("workspace");
}

const CODE_FILE_EXTENSIONS: Record<string, string> = {
	bash: "sh",
	css: "css",
	html: "html",
	javascript: "js",
	js: "js",
	json: "json",
	jsx: "jsx",
	markdown: "md",
	md: "md",
	python: "py",
	py: "py",
	rust: "rs",
	rs: "rs",
	sh: "sh",
	tsx: "tsx",
	typescript: "ts",
	ts: "ts",
	yaml: "yaml",
	yml: "yml",
};

async function openCodeInWorkspace(
	code: string,
	language: string,
): Promise<void> {
	const extension = CODE_FILE_EXTENSIONS[language.toLowerCase()] ?? "txt";
	const path = await invoke<string>("write_temp_text", {
		filename: `naia-code-${Date.now()}.${extension}`,
		content: code,
	});
	openFileInWorkspace(path);
}

function processFilePaths(text: string): ReactNode[] {
	const parts = text.split(FILE_PATH_RE);
	let matchIndex = 0;
	return parts.map((part) => {
		if (!FILE_PATH_RE.test(part)) return part;
		matchIndex += 1;
		return (
			<button
				key={`file-${part}-${matchIndex}`}
				type="button"
				className="chat-file-deeplink"
				data-usage-event="chat-markdown.open-file-in-workspace-1.click"
				onClick={() => openFileInWorkspace(part)}
				title={`워크스페이스에서 열기: ${part}`}
			>
				{part}
			</button>
		);
	});
}

const components: Components = {
	code: ({ className, children }) => (
		<MarkdownCodeBlock
			className={className}
			onOpenWorkspace={(code, language) =>
				void openCodeInWorkspace(code, language)
			}
		>
			{children}
		</MarkdownCodeBlock>
	),
	p({ children, ...props }) {
		const processed = Array.isArray(children)
			? children.flatMap((child) =>
					typeof child === "string" ? processFilePaths(child) : [child],
				)
			: typeof children === "string"
				? processFilePaths(children)
				: children;
		return <p {...props}>{processed}</p>;
	},
};

export function ChatMarkdown({ children }: { children: string }) {
	return (
		<Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
			{children}
		</Markdown>
	);
}
