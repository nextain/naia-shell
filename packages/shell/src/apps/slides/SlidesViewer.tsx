import type { RefObject } from "react";
import { Document, Page as PdfPage, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { t } from "../../lib/i18n";
import type { ParsedPptxDeck } from "../../lib/pptx-ooxml";
import { pdfTextFromItems } from "../../lib/slides-pdf-text";

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
		(!normalizedAbsolutePath.startsWith("/") &&
			!/^[A-Za-z]:\//.test(normalizedAbsolutePath)) ||
		lastSlash <= 0
	) {
		return workerUrl;
	}

	const appRoot = normalizedAbsolutePath.slice(0, lastSlash);
	const separator = pathWithoutUrlSlash.includes("\\") ? "\\" : "/";
	const outputRoot =
		separator === "\\" ? appRoot.replaceAll("/", "\\") : appRoot;
	const workerPath = `${outputRoot}${separator}assets${separator}${workerName}`;
	return `${location.protocol}//${location.host}/${encodeURIComponent(workerPath)}`;
}

pdfjs.GlobalWorkerOptions.workerSrc = resolveSlidesPdfWorkerUrl(pdfWorkerUrl);

export interface SlidesViewerProps {
	file: File | null;
	pptxDeck?: ParsedPptxDeck | null;
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
	pptxDeck,
	fileName,
	page,
	viewerRef,
	viewerWidth,
	totalPages,
	onReady,
	onError,
}: SlidesViewerProps) {
	const pptxSlide =
		pptxDeck && pptxDeck.slides.length > 0
			? (pptxDeck.slides[page - 1] ?? pptxDeck.slides[0])
			: null;
	const aspectRatio =
		pptxDeck && pptxDeck.slideWidthEmu > 0 && pptxDeck.slideHeightEmu > 0
			? `${pptxDeck.slideWidthEmu} / ${pptxDeck.slideHeightEmu}`
			: "16 / 9";

	return (
		<div
			className="slides-app__viewer"
			ref={viewerRef}
			data-testid="slides-viewer"
		>
			{pptxSlide ? (
				<article
					className="slides-app__page slides-app__pptx-stage"
					data-testid={`pptx-slide-${page}`}
					style={{
						width: `${viewerWidth}px`,
						aspectRatio,
						background: pptxSlide.backgroundHex ?? undefined,
					}}
				>
					<div className="slides-app__pptx-accent" />
					<div className="slides-app__pptx-body">
						<div className="slides-app__pptx-text">
							<h2 className="slides-app__pptx-title">{pptxSlide.title}</h2>
							{pptxSlide.subtitle ? (
								<p className="slides-app__pptx-subtitle">
									{pptxSlide.subtitle}
								</p>
							) : null}
							{pptxSlide.bullets.length > 0 ? (
								<ul className="slides-app__pptx-bullets">
									{pptxSlide.bullets.map((bullet, bIdx) => (
										<li
											key={`${page}-b-${bIdx}`}
											data-level={bullet.level}
											style={{ paddingLeft: `${bullet.level * 18}px` }}
										>
											{bullet.text}
										</li>
									))}
								</ul>
							) : null}
							{pptxSlide.tables.map((tbl, tIdx) => (
								<table
									key={`${page}-tbl-${tIdx}`}
									className="slides-app__pptx-table"
								>
									<tbody>
										{tbl.rows.map((row, rIdx) => (
											<tr key={`${page}-tr-${tIdx}-${rIdx}`}>
												{row.map((cell, cIdx) => (
													<td key={`${page}-tc-${tIdx}-${rIdx}-${cIdx}`}>
														{cell}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							))}
						</div>
						{pptxSlide.images.length > 0 ? (
							<div className="slides-app__pptx-media">
								{pptxSlide.images.map((img) => (
									<img
										key={img.id}
										src={img.dataUrl}
										alt={img.alt ?? pptxSlide.title}
										className="slides-app__pptx-image"
									/>
								))}
							</div>
						) : null}
					</div>
					<footer className="slides-app__pptx-footer">
						<span>{fileName}</span>
						<span>
							{page} / {totalPages}
						</span>
					</footer>
				</article>
			) : file ? (
				<Document
					file={file}
					onLoadSuccess={async (document) => {
						const texts: string[] = [];
						for (let page = 1; page <= document.numPages; page++) {
							const pdfPage = await document.getPage(page);
							const content = await pdfPage.getTextContent();
							texts.push(pdfTextFromItems(content.items));
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
