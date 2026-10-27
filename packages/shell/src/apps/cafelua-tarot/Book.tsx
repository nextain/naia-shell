import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tarotLibraryBook } from "./data/library/tarotBook";
import {
	alignChapterStartsToSpreads,
	measureRenderedReaderPages,
	type MeasuredReaderPage,
} from "./library-dom-pagination";
import { assetUrl } from "./assets";
import { bookLocation, ui } from "./ui";
import type { AppLocale } from "./i18n";
import "./LibraryPage.css";

export interface BookHandle {
	open: (chapter: number) => Promise<Record<string, unknown>>;
	read: () => Promise<Record<string, unknown>>;
	stop: () => Record<string, unknown>;
}
type Props = { locale: AppLocale; onBack: () => void };
const stopHint: Record<AppLocale, string> = {
	ko: "나이아에게 '그만'이라고 말해 보세요.",
	en: "Ask Naia to stop.",
	ar: "اطلب من نايا التوقف.",
	bn: "নায়াকে থামতে বলুন।",
	de: "Bitte Naia aufzuhören.",
	es: "Pídele a Naia que pare.",
	fr: "Demandez à Naia de s'arrêter.",
	hi: "नाया से रुकने को कहें।",
	id: "Minta Naia berhenti.",
	ja: "ナイアに「やめて」と言ってみましょう。",
	pt: "Peça a Naia para parar.",
	ru: "Попросите Naia остановиться.",
	vi: "Hãy bảo Naia dừng lại.",
	zh: "请对 Naia 说“停止”。",
};
export const Book = forwardRef<BookHandle, Props>(function Book(
	{ locale, onBack },
	ref,
) {
	const edition = tarotLibraryBook.editions.find(
		(x) => x.lang === (locale === "ko" ? "ko" : "en"),
	)!;
	const [pages, setPages] = useState<MeasuredReaderPage[]>([]);
	const pagesRef = useRef<MeasuredReaderPage[]>([]);
	const [index, setIndex] = useState(0);
	const indexRef = useRef(0);
	const [scale, setScale] = useState(1);
	const [toc, setToc] = useState(false);
	const [compact, setCompact] = useState(() => window.innerWidth < 720);
	const [auto, setAuto] = useState(false);
	const [reading, setReading] = useState(false);
	const [highlight, setHighlight] = useState<{
		page: number;
		ids: string[];
	} | null>(null);
	const [notice, setNotice] = useState("");
	const cursor = useRef({ page: 0 });
	const consumed = useRef(new Set<string>());
	const stopped = useRef(false);
	const source = useRef<HTMLDivElement>(null);
	const template = useRef<HTMLElement>(null);
	const panel = useRef<HTMLElement>(null);
	const pending = useRef<(() => void)[]>([]);
	function move(i: number) {
		indexRef.current = Math.max(0, Math.min(i, pagesRef.current.length - 1));
		setIndex(indexRef.current);
		cursor.current = { page: indexRef.current };
		consumed.current.clear();
		setHighlight(null);
	}
	useEffect(() => {
		const m = matchMedia("(max-width: 719px)");
		const sync = () => setCompact(m.matches);
		m.addEventListener("change", sync);
		return () => m.removeEventListener("change", sync);
	}, []);
	useLayoutEffect(() => {
		if (!source.current || !template.current) return;
		let cancelled = false;
		let frame = 0;
		const src = source.current;
		const tpl = template.current;
		src.querySelectorAll("p").forEach((p, i) => {
			if (!p.querySelector("img") && (p.textContent ?? "").trim())
				p.dataset.readerParagraph = String(i);
		});
		const measure = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (cancelled) return;
				const next = alignChapterStartsToSpreads(
					measureRenderedReaderPages(src, tpl),
					compact ? 1 : 2,
				);
				if (!next.length) return;
				pagesRef.current = next;
				setPages(next);
				pending.current.splice(0).forEach((f) => f());
			});
		};
		const observer = new ResizeObserver(measure);
		observer.observe(tpl);
		src
			.querySelectorAll("img")
			.forEach((img) => img.addEventListener("load", measure));
		void document.fonts.ready.then(measure);
		measure();
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
			observer.disconnect();
			src
				.querySelectorAll("img")
				.forEach((img) => img.removeEventListener("load", measure));
		};
	}, [edition, scale, compact]);
	const wait = () =>
		pagesRef.current.length
			? Promise.resolve()
			: new Promise<void>((resolve) => pending.current.push(resolve));
	useImperativeHandle(
		ref,
		() => ({
			async open(chapter) {
				await wait();
				const i = pagesRef.current.findIndex(
					(p) => p.chapterIndex === chapter && !p.blank,
				);
				if (i < 0) throw Error("Chapter not found");
				stopped.current = false;
				move(i);
				setReading(false);
				setAuto(false);
				return { chapter_title: pagesRef.current[i].chapterTitle, page: i + 1 };
			},
			async read() {
				await wait();
				if (stopped.current) return { stopped: true };
				setAuto(false);
				setReading(true);
				let { page } = cursor.current;
				const all = pagesRef.current;
				const paragraphsOn = (p: MeasuredReaderPage) => {
					const el = document.createElement("div");
					el.innerHTML = p.html;
					return Array.from(
						el.querySelectorAll<HTMLElement>("p[data-reader-paragraph]"),
					).map((p) => p.dataset.readerParagraph!);
				};
				while (page < all.length) {
					const ids = paragraphsOn(all[page]).filter(
						(id) => !consumed.current.has(id),
					);
					if (!ids.length) {
						page++;
						continue;
					}
					const text: string[] = [];
					const picked: string[] = [];
					let length = 0;
					for (const id of ids) {
						const value =
							source.current?.querySelector<HTMLElement>(
								`p[data-reader-paragraph="${id}"]`,
							)?.textContent ?? "";
						if (!value) continue;
						if (text.length && length + value.length + 2 > 600) break;
						text.push(value);
						picked.push(id);
						length += value.length + 2;
						if (text.length === 3) break;
					}
					if (!text.length) {
						page++;
						continue;
					}
					picked.forEach((id) => consumed.current.add(id));
					cursor.current = { page };
					indexRef.current = compact ? page : Math.floor(page / 2) * 2;
					setIndex(indexRef.current);
					setHighlight({ page, ids: picked });
					const last = !all
						.slice(page)
						.filter((p) => p.chapterIndex === all[page].chapterIndex)
						.some((p) =>
							paragraphsOn(p).some((id) => !consumed.current.has(id)),
						);
					return {
						text: text.join("\n\n"),
						chapter_title: all[page].chapterTitle,
						page: page + 1,
						total_pages: all.length,
						chapter_end: last,
					};
				}
				setReading(false);
				setHighlight(null);
				throw Error("End of book");
			},
			stop() {
				stopped.current = true;
				setReading(false);
				setAuto(false);
				setHighlight(null);
				return { page: cursor.current.page + 1 };
			},
		}),
		[compact, edition],
	);
	useEffect(() => {
		if (!auto || reading) return;
		const id = window.setInterval(
			() => move(indexRef.current + (compact ? 1 : 2)),
			10000,
		);
		return () => clearInterval(id);
	}, [auto, reading, compact]);
	function pageHtml(p: MeasuredReaderPage, pageIndex: number) {
		if (!highlight || highlight.page !== pageIndex) return p.html;
		const el = document.createElement("div");
		el.innerHTML = p.html;
		el.querySelectorAll<HTMLElement>("p[data-reader-paragraph]").forEach(
			(node) => {
				if (highlight.ids.includes(node.dataset.readerParagraph!))
					node.classList.add("naia-reading-highlight");
			},
		);
		return el.innerHTML;
	}
	return (
		<section className="library-reader-panel tarot-book" ref={panel}>
			<header className="book-toolbar">
				<button onClick={onBack} aria-label={ui(locale, "back")}>
					<span className="book-wide">{ui(locale, "back")}</span>
					<span className="book-icon" aria-hidden="true">
						←
					</span>
				</button>
				<button
					onClick={() => setToc(!toc)}
					aria-expanded={toc}
					aria-label={ui(locale, "contents")}
				>
					<span className="book-wide">{ui(locale, "contents")}</span>
					<span className="book-icon" aria-hidden="true">
						☰
					</span>
				</button>
				<button
					onClick={() => setScale(Math.max(0.85, scale - 0.05))}
					aria-label={ui(locale, "smaller")}
				>
					A−
				</button>
				<button
					onClick={() => setScale(Math.min(1.15, scale + 0.05))}
					aria-label={ui(locale, "larger")}
				>
					A+
				</button>
				{document.fullscreenEnabled && !compact && (
					<button onClick={() => void panel.current?.requestFullscreen()}>
						{ui(locale, "fullscreen")}
					</button>
				)}
				<button
					aria-label={ui(locale, "auto")}
					aria-pressed={auto}
					onClick={() => {
						setReading(false);
						setHighlight(null);
						setAuto(!auto);
					}}
				>
					<span className="book-wide">{ui(locale, "auto")}</span>
					<span className="book-icon" aria-hidden="true">
						▶
					</span>
				</button>
				<button
					aria-label={ui(locale, "read")}
					onClick={() => setNotice(ui(locale, "readHint"))}
				>
					<span className="book-wide">{ui(locale, "read")}</span>
					<span className="book-icon" aria-hidden="true">
						♫
					</span>
				</button>
				<span>
					{edition.title}
					{pages[index] &&
						` · ${bookLocation(locale, edition.chapters[pages[index].chapterIndex].path, pages[index].chapterTitle)}`}
				</span>
			</header>
			{toc && (
				<aside className="book-toc">
					<button
						onClick={() => setToc(false)}
						aria-label={ui(locale, "close")}
					>
						×
					</button>
					{edition.chapters.map((c, i) => (
						<button
							key={c.path}
							onClick={() => {
								const n = pages.findIndex((p) => p.chapterIndex === i);
								if (n >= 0) move(n);
								setToc(false);
							}}
						>
							{c.title}
						</button>
					))}
				</aside>
			)}
			<div className="book-layout">
				<div
					className={`library-reader-spread ${compact ? "compact" : ""}`}
					style={{ "--reader-font-scale": scale } as CSSProperties}
				>
					<article
						ref={template}
						className="library-paper-page library-paper-template"
						data-measure-template
						aria-hidden="true"
					>
						<header>
							<span>{edition.title}</span>
							<small>0</small>
						</header>
						<div className="library-paper-content" />
					</article>
					<div
						ref={source}
						className="library-reader-measure-source library-paper-content"
						aria-hidden="true"
					>
						{edition.chapters.map((chapter, i) => (
							<section
								key={chapter.path}
								data-reader-chapter
								data-chapter-index={i}
								data-chapter-title={chapter.title}
							>
								<ReactMarkdown
									remarkPlugins={[remarkGfm]}
									components={{
										img: ({ src, alt }) => {
											if (typeof src !== "string") return null;
											const path = src.startsWith("/")
												? src
												: `library-books/${edition.sourceSlug}/${src}`;
											return (
												<span className="library-illustration">
													<img src={assetUrl(path)} alt={alt ?? ""} />
												</span>
											);
										},
									}}
								>
									{chapter.markdown}
								</ReactMarkdown>
							</section>
						))}
					</div>
					{pages.slice(index, index + (compact ? 1 : 2)).map((p, i) => (
						<article
							className={`library-paper-page${p.blank ? " library-paper-blank" : ""}`}
							key={`${p.chapterIndex}-${p.pageInChapter}`}
						>
							<header>
								<span>{p.blank ? "" : p.chapterTitle}</span>
								<small>{index + i + 1}</small>
							</header>
							<div
								className="library-paper-content"
								dangerouslySetInnerHTML={{ __html: pageHtml(p, index + i) }}
							/>
						</article>
					))}
				</div>
				<nav className="book-navigation">
					<button
						disabled={index <= 0}
						onClick={() => move(index - (compact ? 1 : 2))}
						aria-label={ui(locale, "previous")}
					>
						‹
					</button>
					<span>
						{index + 1}
						{!compact ? `–${Math.min(index + 2, pages.length)}` : ""} /{" "}
						{pages.length}
					</span>
					<button
						disabled={index + (compact ? 1 : 2) >= pages.length}
						onClick={() => move(index + (compact ? 1 : 2))}
						aria-label={ui(locale, "nextPage")}
					>
						›
					</button>
				</nav>
			</div>
			{notice && (
				<div
					role="status"
					className="book-notice"
					onClick={() => setNotice("")}
				>
					{notice}
				</div>
			)}
			{reading && (
				<div className="book-reading">
					{ui(locale, "reading")}{" "}
					<button
						onClick={() => {
							stopped.current = true;
							setReading(false);
							setAuto(false);
							setHighlight(null);
							setNotice(stopHint[locale]);
							window.setTimeout(() => setNotice(""), 3500);
						}}
					>
						{ui(locale, "stop")}
					</button>
				</div>
			)}
		</section>
	);
});
