import { Document, Page as PdfPage, pdfjs } from "react-pdf";
import type { RefObject } from "react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { t } from "../../lib/i18n";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
