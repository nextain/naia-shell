import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Logger } from "../../lib/logger";

interface MarkdownPreviewProps {
	content: string;
	filePath: string;
	workspaceRoot: string;
	onOpenFile?: (path: string) => void;
	codeComponent?: React.ComponentType<{
		className?: string;
		children?: React.ReactNode;
	}>;
}

const previewScrollPositions = new Map<string, number>();

function normalizePath(path: string): string {
	const windows = /^[A-Za-z]:[\\/]/.test(path);
	const prefix = windows ? path.slice(0, 2).toLowerCase() : "";
	const body = (windows ? path.slice(2) : path).replaceAll("\\", "/");
	const parts: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `${prefix}/${parts.join("/")}`;
}

function dirname(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	return normalized.slice(0, normalized.lastIndexOf("/")) || "/";
}

export function resolveWorkspaceReference(
	reference: string,
	filePath: string,
	workspaceRoot: string,
): string | null {
	if (!reference || !workspaceRoot || reference.startsWith("#")) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
	} catch {
		return null;
	}
	if (
		!decoded ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded) ||
		decoded.startsWith("//")
	) {
		return null;
	}
	const root = normalizePath(workspaceRoot);
	const candidate = decoded.startsWith("/")
		? normalizePath(`${root}/${decoded.slice(1)}`)
		: normalizePath(`${dirname(filePath)}/${decoded}`);
	return candidate === root || candidate.startsWith(`${root}/`)
		? candidate
		: null;
}

function mimeForPath(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase();
	return (
		(
			{
				png: "image/png",
				jpg: "image/jpeg",
				jpeg: "image/jpeg",
				gif: "image/gif",
				webp: "image/webp",
				svg: "image/svg+xml",
			} as Record<string, string>
		)[ext ?? ""] ?? "application/octet-stream"
	);
}

function MarkdownImage({
	src,
	alt,
	filePath,
	workspaceRoot,
}: {
	src?: string;
	alt?: string;
	filePath: string;
	workspaceRoot: string;
}) {
	const resolved = useMemo(
		() => resolveWorkspaceReference(src ?? "", filePath, workspaceRoot),
		[src, filePath, workspaceRoot],
	);
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		setBlobUrl(null);
		setFailed(false);
		if (!resolved) {
			setFailed(true);
			return;
		}
		let cancelled = false;
		let createdUrl: string | null = null;
		invoke<number[]>("workspace_read_file_bytes", { path: resolved })
			.then((bytes) => {
				if (cancelled) return;
				createdUrl = URL.createObjectURL(
					new Blob([new Uint8Array(bytes)], { type: mimeForPath(resolved) }),
				);
				setBlobUrl(createdUrl);
			})
			.catch((error) => {
				if (!cancelled) setFailed(true);
				Logger.warn("MarkdownPreview", "Local image could not be loaded", {
					path: resolved,
					error: String(error),
				});
			});
		return () => {
			cancelled = true;
			if (createdUrl) URL.revokeObjectURL(createdUrl);
		};
	}, [resolved]);

	if (failed) {
		return (
			<output className="workspace-markdown__image-error">
				이미지를 열 수 없습니다: {alt || src || "알 수 없는 이미지"}
			</output>
		);
	}
	return blobUrl ? (
		<img src={blobUrl} alt={alt ?? ""} />
	) : (
		<output>이미지 로딩 중…</output>
	);
}

export function MarkdownPreview({
	content,
	filePath,
	workspaceRoot,
	onOpenFile,
	codeComponent,
}: MarkdownPreviewProps) {
	const articleRef = useRef<HTMLElement>(null);
	useEffect(() => {
		const article = articleRef.current;
		if (article) article.scrollTop = previewScrollPositions.get(filePath) ?? 0;
	}, [filePath]);

	return (
		<article
			ref={articleRef}
			className="workspace-editor__preview"
			aria-label="Markdown 미리보기"
			onScroll={(event) =>
				previewScrollPositions.set(filePath, event.currentTarget.scrollTop)
			}
		>
			<Markdown
				remarkPlugins={[remarkGfm]}
				skipHtml
				components={{
					...(codeComponent ? { code: codeComponent } : {}),
					img: ({ src, alt }) => (
						<MarkdownImage
							src={src}
							alt={alt}
							filePath={filePath}
							workspaceRoot={workspaceRoot}
						/>
					),
					a: ({ href, children }) => {
						const external = href ? /^https?:\/\//i.test(href) : false;
						const localPath = href
							? resolveWorkspaceReference(href, filePath, workspaceRoot)
							: null;
						const blocked = Boolean(
							href && !external && !localPath && !href.startsWith("#"),
						);
						return (
							<a
								href={blocked ? undefined : href}
								aria-label={
									external ? `${String(children)} (외부 링크)` : undefined
								}
								data-usage-event="markdown-preview.open-url-1.click"
								onClick={(event) => {
									if (external && href) {
										event.preventDefault();
										void openUrl(href).catch((error) =>
											Logger.warn("MarkdownPreview", "External link failed", {
												error: String(error),
											}),
										);
									} else if (localPath) {
										event.preventDefault();
										onOpenFile?.(localPath);
									} else if (blocked) event.preventDefault();
								}}
							>
								{children}
								{external ? <span aria-hidden="true"> ↗</span> : null}
							</a>
						);
					},
				}}
			>
				{content}
			</Markdown>
		</article>
	);
}
