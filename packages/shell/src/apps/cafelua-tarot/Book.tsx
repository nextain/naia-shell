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
export const readRequests: Record<AppLocale, string> = {
	ko: "나이아, 카페루아 타로 이야기 지금 장을 그대로 읽어 줘.",
	en: "Naia, please read the current chapter of the Cafe Lua tarot story aloud, just as it is written.",
	ar: "نايا، اقرئي الفصل الحالي من حكاية تاروت كافيه لوا بصوت عالٍ كما هو مكتوب.",
	bn: "নাইয়া, ক্যাফে লুয়া ট্যারোট গল্পের এই অধ্যায়টা যেমন লেখা আছে তেমনই পড়ে শোনাও।",
	de: "Naia, lies bitte das aktuelle Kapitel der Cafe-Lua-Tarotgeschichte so vor, wie es geschrieben ist.",
	es: "Naia, lee en voz alta el capítulo actual de la historia de tarot de Cafe Lua tal como está escrito.",
	fr: "Naia, lis à voix haute le chapitre actuel de l'histoire de tarot Cafe Lua, tel qu'il est écrit.",
	hi: "नाइया, कैफ़े लुआ टैरो कहानी का यह अध्याय जैसा लिखा है वैसा ही पढ़कर सुनाओ।",
	id: "Naia, tolong bacakan bab ini dari kisah tarot Cafe Lua persis seperti yang tertulis.",
	ja: "ナイア、カフェルアのタロット物語の今の章を、書かれているとおりに読んで。",
	pt: "Naia, leia em voz alta o capítulo atual da história de tarô Cafe Lua exatamente como está escrito.",
	ru: "Найя, прочитай вслух текущую главу истории таро Cafe Lua так, как она написана.",
	vi: "Naia ơi, đọc to chương hiện tại của truyện tarot Cafe Lua đúng như được viết nhé.",
	zh: "Naia，请把 Cafe Lua 塔罗故事的当前章节按原文读出来。",
};
export const readErrors: Record<AppLocale, string> = {
	ko: "낭독을 시작하지 못했어요. 다시 시도해 주세요.",
	en: "Could not start reading. Please try again.",
	ar: "تعذرت بدء القراءة. حاول مجددًا.",
	bn: "পাঠ শুরু করা যায়নি। আবার চেষ্টা করুন।",
	de: "Vorlesen konnte nicht starten. Bitte erneut versuchen.",
	es: "No se pudo iniciar la lectura. Inténtalo de nuevo.",
	fr: "La lecture n’a pas démarré. Réessayez.",
	hi: "पाठ शुरू नहीं हो सका। फिर कोशिश करें।",
	id: "Pembacaan gagal dimulai. Coba lagi.",
	ja: "朗読を始められませんでした。もう一度お試しください。",
	pt: "Não foi possível iniciar a leitura. Tente novamente.",
	ru: "Не удалось начать чтение. Попробуйте ещё раз.",
	vi: "Không thể bắt đầu đọc. Hãy thử lại.",
	zh: "无法开始朗读，请重试。",
};
export const chapterDone: Record<AppLocale, string> = {
	ko: "이 장을 다 읽었어요. 다음 장을 열어 주세요.",
	en: "This chapter is finished. Open the next chapter to continue.",
	ar: "انتهى هذا الفصل. افتح الفصل التالي للمتابعة.",
	bn: "এই অধ্যায় শেষ। চালিয়ে যেতে পরের অধ্যায় খুলুন।",
	de: "Dieses Kapitel ist zu Ende. Öffne das nächste Kapitel.",
	es: "Este capítulo ha terminado. Abre el siguiente para continuar.",
	fr: "Ce chapitre est terminé. Ouvrez le suivant pour continuer.",
	hi: "यह अध्याय पूरा हुआ। आगे पढ़ने के लिए अगला अध्याय खोलें।",
	id: "Bab ini selesai. Buka bab berikutnya untuk melanjutkan.",
	ja: "この章は終わりました。続けるには次の章を開いてください。",
	pt: "Este capítulo terminou. Abra o próximo para continuar.",
	ru: "Глава закончена. Откройте следующую главу, чтобы продолжить.",
	vi: "Chương này đã hết. Hãy mở chương tiếp theo để tiếp tục.",
	zh: "本章已读完。请打开下一章继续。",
};
let requestSequence = 0;

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
	const request = useRef<{
		id: string;
		timer: number;
		finish: (status: string) => void;
	} | null>(null);
	const readingRef = useRef(false);
	const readingGeneration = useRef(0);
	const localeRef = useRef(locale);
	localeRef.current = locale;
	const cursor = useRef({ page: 0 });
	const consumed = useRef(new Set<string>());
	const source = useRef<HTMLDivElement>(null);
	const template = useRef<HTMLElement>(null);
	const panel = useRef<HTMLElement>(null);
	const pending = useRef<(() => void)[]>([]);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const current = request.current;
			if (
				event.source !== window.parent ||
				!current ||
				event.data?.id !== current.id ||
				event.data?.type !== "naia-app:speech-result"
			)
				return;
			current.finish(event.data.status);
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
			if (request.current) {
				window.parent.postMessage(
					{
						type: "naia-app:speak-cancel",
						appId: "land.naia.cafelua-tarot",
						id: request.current.id,
					},
					"*",
				);
				clearTimeout(request.current.timer);
				request.current = null;
			}
			readingRef.current = false;
		};
	}, []);
	function stopReading() {
		readingGeneration.current++;
		readingRef.current = false;
		const current = request.current;
		if (current) {
			window.parent.postMessage(
				{
					type: "naia-app:speak-cancel",
					appId: "land.naia.cafelua-tarot",
					id: current.id,
				},
				"*",
			);
			clearTimeout(current.timer);
			request.current = null;
		}
		setReading(false);
		setAuto(false);
		setHighlight(null);
	}
	function requestReading() {
		if (readingRef.current) {
			stopReading();
			return;
		}
		if (window.parent === window) {
			setNotice(ui(locale, "readHint"));
			return;
		}
		void startReading();
	}
	function move(i: number) {
		if (readingRef.current) stopReading();
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
	async function startReading(): Promise<Record<string, unknown>> {
		if (readingRef.current)
			return {
				already_reading: true,
				chapter_title: pagesRef.current[cursor.current.page]?.chapterTitle,
				page: cursor.current.page + 1,
			};
		if (window.parent === window) {
			setNotice(ui(localeRef.current, "readHint"));
			return { started: false };
		}
		readingRef.current = true;
		const generation = ++readingGeneration.current;
		await wait();
		if (!readingRef.current || readingGeneration.current !== generation)
			return { stopped: true };
		const all = pagesRef.current;
		const chapter = all[cursor.current.page]?.chapterIndex;
		if (chapter === undefined) {
			readingRef.current = false;
			return { book_end: true };
		}
		const paragraphsOn = (p: MeasuredReaderPage) => {
			const el = document.createElement("div");
			el.innerHTML = p.html;
			return Array.from(
				el.querySelectorAll<HTMLElement>("p[data-reader-paragraph]"),
				(p) => p.dataset.readerParagraph!,
			);
		};
		const findBatch = () => {
			for (
				let page = cursor.current.page;
				page < all.length && all[page].chapterIndex === chapter;
				page++
			) {
				const ids = paragraphsOn(all[page]).filter(
					(id) => !consumed.current.has(id),
				);
				const picked: string[] = [],
					text: string[] = [];
				for (const id of ids) {
					const value =
						source.current?.querySelector<HTMLElement>(
							`p[data-reader-paragraph="${id}"]`,
						)?.textContent ?? "";
					if (!value) continue;
					if (value.length > 2000) return { error: true } as const;
					text.push(value);
					picked.push(id);
					break;
				}
				if (text.length)
					return { page, picked, text: text.join("\n\n") } as const;
			}
			return null;
		};
		const first = findBatch();
		if (first && "error" in first) {
			readingRef.current = false;
			setNotice(readErrors[localeRef.current]);
			return { started: false };
		}
		if (!first) {
			readingRef.current = false;
			const later = all.findIndex(
				(p, i) => i > cursor.current.page && p.chapterIndex !== chapter,
			);
			if (later < 0) return { book_end: true };
			setNotice(chapterDone[localeRef.current]);
			return {
				chapter_end: true,
				chapter_title: all[cursor.current.page].chapterTitle,
				page: cursor.current.page + 1,
			};
		}
		setNotice("");
		setAuto(false);
		setReading(true);
		const sendNext = () => {
			if (!readingRef.current || readingGeneration.current !== generation)
				return;
			const batch = findBatch();
			if (!batch) {
				readingRef.current = false;
				setReading(false);
				setHighlight(null);
				setNotice(chapterDone[localeRef.current]);
				return;
			}
			if ("error" in batch) {
				readingRef.current = false;
				setReading(false);
				setHighlight(null);
				setNotice(readErrors[localeRef.current]);
				return;
			}
			cursor.current = { page: batch.page };
			indexRef.current = compact ? batch.page : Math.floor(batch.page / 2) * 2;
			setIndex(indexRef.current);
			setHighlight({ page: batch.page, ids: batch.picked });
			const id = `tarot-read-${Date.now()}-${++requestSequence}`;
			const finish = (status: string) => {
				if (request.current?.id !== id) return;
				clearTimeout(request.current.timer);
				request.current = null;
				if (!readingRef.current) return;
				if (status !== "completed") {
					readingRef.current = false;
					setReading(false);
					setHighlight(null);
					if (status !== "cancelled") setNotice(readErrors[localeRef.current]);
					return;
				}
				batch.picked.forEach((id) => consumed.current.add(id));
				sendNext();
			};
			const timer = window.setTimeout(() => {
				window.parent.postMessage(
					{
						type: "naia-app:speak-cancel",
						appId: "land.naia.cafelua-tarot",
						id,
					},
					"*",
				);
				finish("failed");
			}, 120001);
			request.current = { id, timer, finish };
			window.parent.postMessage(
				{
					type: "naia-app:speak",
					appId: "land.naia.cafelua-tarot",
					id,
					page: batch.page + 1,
					text: batch.text,
				},
				"*",
			);
		};
		window.setTimeout(sendNext, 0);
		return {
			started: true,
			chapter_title: all[cursor.current.page].chapterTitle,
			page: cursor.current.page + 1,
			note: "Naia's voice is now reading the original text aloud in the app. Do not recite, summarize, or continue the story yourself; reply in at most one short sentence.",
		};
	}
	useImperativeHandle(
		ref,
		() => ({
			async open(chapter) {
				await wait();
				const i = pagesRef.current.findIndex(
					(p) => p.chapterIndex === chapter && !p.blank,
				);
				if (i < 0) throw Error("Chapter not found");
				stopReading();
				move(i);
				setAuto(false);
				return { chapter_title: pagesRef.current[i].chapterTitle, page: i + 1 };
			},
			read: startReading,
			stop() {
				stopReading();
				return {
					stopped: true,
					page: cursor.current.page + 1,
					note: "Reading stopped. Reply in one short sentence and do not add any story text.",
				};
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
				<button
					onClick={() => {
						stopReading();
						onBack();
					}}
					aria-label={ui(locale, "back")}
				>
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
						stopReading();
						setAuto(!auto);
					}}
				>
					<span className="book-wide">{ui(locale, "auto")}</span>
					<span className="book-icon" aria-hidden="true">
						▶
					</span>
				</button>
				<button aria-label={ui(locale, "read")} onClick={requestReading}>
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
					<button onClick={stopReading}>{ui(locale, "stop")}</button>
				</div>
			)}
		</section>
	);
});
