import { Document, Page as PdfPage, pdfjs } from "react-pdf";
import type { RefObject } from "react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { t } from "../../lib/i18n";

type SlidesWorkerLocation = Pick<Location, "protocol" | "host" | "pathname">;

export function resolveSlidesPdfWorkerUrl(
	workerUrl: string,
	location: SlidesWorkerLocation | undefined = typeof window === "undefined"
		? undefined
		: window.location,
): string {
	if (
		!location ||
		!(
			location.protocol === "asset:" ||
			((location.protocol === "http:" || location.protocol === "https:") &&
				(location.host === "asset.localhost" ||
					location.host.startsWith("asset.localhost:")))
		)
	) {
		return workerUrl;
	}

	const workerName = workerUrl.split(/[\\/]/).pop()?.split(/[?#]/, 1)[0];
	if (!workerName) {
		return workerUrl;
	}

	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(location.pathname);
	} catch {
		return workerUrl;
	}

	const absolutePath = decodedPath.startsWith("//")
		? decodedPath.slice(1)
		: decodedPath;
	const normalizedPath = absolutePath.replaceAll("\\", "/");
	const isWindowsDrivePath = /^\/?[A-Za-z]:\//.test(normalizedPath);
	const pathWithoutUrlSlash =
		isWindowsDrivePath && absolutePath.startsWith("/")
			? absolutePath.slice(1)
			: absolutePath;
	const normalizedAbsolutePath = pathWithoutUrlSlash.replaceAll("\\", "/");
	const lastSlash = normalizedAbsolutePath.lastIndexOf("/");
	if (
		(!normalizedAbsolutePath.startsWith("/") && !/^[A-Za-z]:\//.test(normalizedAbsolutePath)) ||
		lastSlash <= 0
	) {
		return workerUrl;
	}

	const appRoot = normalizedAbsolutePath.slice(0, lastSlash);
	const separator = pathWithoutUrlSlash.includes("\\") ? "\\" : "/";
	const outputRoot = separator === "\\" ? appRoot.replaceAll("/", "\\") : appRoot;
	const workerPath = `${outputRoot}${separator}assets${separator}${workerName}`;
	return `${location.protocol}//${location.host}/${encodeURIComponent(workerPath)}`;
}

pdfjs.GlobalWorkerOptions.workerSrc = resolveSlidesPdfWorkerUrl(pdfWorkerUrl);

export interface SlidesViewerProps {
	file: File | null;
	fileName: string;
	page: number;
	viewerRef: RefObject<HTMLDivElement>;
	viewerWidth: number;
	totalPages: number;
	onReady: (file: File, totalPages: number, texts: string[]) => void;
	onError: (file: File, error: unknown) => void;
}

export function SlidesViewer({
	file,
	fileName,
	page,
	viewerRef,
	viewerWidth,
	totalPages,
	onReady,
	onError,
}: SlidesViewerProps) {
	return (
		<div className="slides-app__viewer" ref={viewerRef} data-testid="slides-viewer">
			{file ? (
				<Document
					file={file}
					onLoadSuccess={async (document) => {
						const texts: string[] = [];
						for (let page = 1; page <= document.numPages; page++) {
							const pdfPage = await document.getPage(page);
							const content = await pdfPage.getTextContent();
							texts.push(
								content.items
									.map((item) => ("str" in item ? item.str : ""))
									.join(" ")
									.replace(/\s+/g, " ")
									.trim(),
							);
						}
						onReady(file, document.numPages, texts);
					}}
					onLoadError={(error) => onError(file, error)}
					loading={
						<div className="slides-app__empty">{t("slides.loading")}</div>
					}
					error={
						<div className="slides-app__empty slides-app__empty--error">
							{t("slides.loadError")}
						</div>
					}
				>
					{totalPages > 0 ? (
						<PdfPage
							key={`${fileName}-${totalPages}`}
							pageNumber={page}
							width={viewerWidth}
							renderAnnotationLayer={false}
							renderTextLayer={false}
							className="slides-app__page"
						/>
					) : null}
				</Document>
			) : (
				<div className="slides-app__empty">
					<div className="slides-app__empty-icon">▣</div>
					<h2>{t("slides.emptyTitle")}</h2>
					<p>{t("slides.emptyBody")}</p>
				</div>
			)}
		</div>
	);
}
