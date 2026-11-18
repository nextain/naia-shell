import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Book, type BookHandle } from "./Book";
import { assetUrl } from "./assets";
import {
	createBrowserAudioController,
	type TarotAudioController,
} from "./audio";
import { FALLBACK_TAROT_CARDS } from "./data/fallbackCards";
import type { DrawnCard } from "./data/types";
import { type AppLocale, appText, normalizeAppLocale } from "./i18n";
import { loungeBackground } from "./lounge-background";
import {
	drawCelticCross,
	type TarotReading,
	type TarotSpread,
} from "./reading";
import { createTarotToolHandler } from "./tools";
import { ui } from "./ui";
import "./tarot.css";

const SPREAD_OPTIONS: ReadonlyArray<{
	id: TarotSpread;
	count: number;
	titleKey: "spreadOne" | "spreadThree" | "spreadCeltic";
	descKey: "spreadOneDesc" | "spreadThreeDesc" | "spreadCelticDesc";
	recommended?: boolean;
}> = [
	{
		id: "one",
		count: 1,
		titleKey: "spreadOne",
		descKey: "spreadOneDesc",
	},
	{
		id: "three",
		count: 3,
		titleKey: "spreadThree",
		descKey: "spreadThreeDesc",
	},
	{
		id: "celtic",
		count: 10,
		titleKey: "spreadCeltic",
		descKey: "spreadCelticDesc",
		recommended: true,
	},
];

export function TarotApp() {
	const [locale, setLocale] = useState<AppLocale>(() =>
		normalizeAppLocale(navigator.language.split("-")[0]),
	);
	const [preferredSpread, setPreferredSpread] =
		useState<TarotSpread>("celtic");
	const preferredSpreadRef = useRef<TarotSpread>("celtic");
	preferredSpreadRef.current = preferredSpread;

	const [reading, setReading] = useState<TarotReading | null>(null);
	const readingRef = useRef<TarotReading | null>(null);
	const [screen, setScreen] = useState<"table" | "book">("table");
	const screenRef = useRef(screen);
	screenRef.current = screen;
	const [finished, setFinished] = useState(false);
	const [spotlightIndex, setSpotlightIndex] = useState<number | null>(null);
	const [artFullscreen, setArtFullscreen] = useState(false);
	const meaningDrag = useRef<number | null>(null);
	const [notice, setNotice] = useState("");
	const [muted, setMuted] = useState(false);
	const book = useRef<BookHandle>(null);
	const audio = useRef<TarotAudioController | null>(null);
	const ko = locale === "ko";
	const t = (a: string, b: string) => (ko ? a : b);

	function store(r: TarotReading | null) {
		readingRef.current = r;
		setReading(r);
	}

	function selectPreferredSpread(next: TarotSpread) {
		preferredSpreadRef.current = next;
		setPreferredSpread(next);
	}

	function resetToSpreadPicker() {
		store(null);
		setFinished(false);
		setSpotlightIndex(null);
		setArtFullscreen(false);
		setScreen("table");
	}

	useEffect(() => {
		if (spotlightIndex === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setArtFullscreen(false);
				setSpotlightIndex(null);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [spotlightIndex]);

	function showNotice(s: string) {
		setNotice(s);
		window.setTimeout(() => setNotice(""), 3500);
	}

	// Push lightweight active state to the host shell so Naia asks spread style & concern naturally.
	useEffect(() => {
		if (!window.parent || window.parent === window) return;
		const revealedCount =
			reading?.cards.filter((c) => c.isFlipped).length ?? 0;
		window.parent.postMessage(
			{
				type: "naia-app:context",
				context: {
					app: "land.naia.cafelua-tarot",
					version: "0.1.5",
					screen,
					preferredSpread,
					readingActive: Boolean(reading),
					activeSpread: reading?.spread ?? null,
					revealedCards: revealedCount,
					totalCards: reading?.cards.length ?? 0,
					finished,
					guidance: reading
						? "Reveal one card at a time with reveal_next and interpret only revealed cards."
						: "Before calling start_reading, ask the user BOTH what is on their mind AND how they want to read: 'one' (1-card focus), 'three' (3-card Past/Present/Future), or 'celtic' (10-card Celtic Cross, recommended classic).",
				},
			},
			"*",
		);
	}, [screen, preferredSpread, reading, finished]);

	useEffect(() => {
		const bgm = new Audio(assetUrl("sounds/taro-bgm.mp3"));
		const a = createBrowserAudioController(bgm, () => {});
		audio.current = a;
		void a.startBgm();
		const retry = () => {
			if (!a.isMuted) void a.startBgm();
		};
		window.addEventListener("pointerdown", retry, { once: true });
		return () => {
			window.removeEventListener("pointerdown", retry);
			a.dispose();
		};
	}, []);

	const handler = useRef<(args: Record<string, unknown>) => unknown>(
		() => ({}),
	);
	handler.current = createTarotToolHandler({
		getReading: () => readingRef.current,
		getPreferredSpread: () => preferredSpreadRef.current,
		setPreferredSpread: selectPreferredSpread,
		startReading: (question, spread) => {
			selectPreferredSpread(spread);
			const r = drawCelticCross(question, Math.random, Date.now(), spread);
			store(r);
			setFinished(false);
			setScreen("table");
			setSpotlightIndex(null);
			return r;
		},
		setReading: (next) => {
			store(next);
		},
		onReveal: () => {
			void audio.current?.playFlip();
		},
		finish: () => {
			setFinished(true);
			setScreen("table");
		},
		openStory: (card, part) => {
			const item =
				typeof card === "number"
					? FALLBACK_TAROT_CARDS.find((c) => c.id === card)
					: FALLBACK_TAROT_CARDS.find(
							(c) =>
								c.nameEn.toLowerCase() === String(card).toLowerCase() ||
								c.nameKr === card ||
								String(c.id) === card,
						);
			if (!item && card !== undefined) throw Error("Card not found");
			setScreen("book");
			return book.current!.open(
				item ? (part === 1 ? 2 : 25) + item.id : 0,
			) as unknown as Record<string, unknown>;
		},
		readAloud: () => {
			setScreen("book");
			return book.current!.read() as unknown as Record<string, unknown>;
		},
		stopReading: () => book.current!.stop(),
		status: () => ({
			screen: screenRef.current,
			preferred_spread: preferredSpreadRef.current,
			spread: readingRef.current?.spread ?? null,
			revealed:
				readingRef.current?.cards.filter((c) => c.isFlipped).length ?? 0,
			total: readingRef.current?.cards.length ?? 0,
			finished,
		}),
	});

	useEffect(() => {
		const onMessage = async (e: MessageEvent) => {
			if (e.source !== window.parent || !e.data || typeof e.data !== "object")
				return;
			const m = e.data;
			if (m.type === "naia-app:locale" && typeof m.locale === "string") {
				const l = normalizeAppLocale(m.locale);
				setLocale(l);
				document.documentElement.lang = l;
				document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
				return;
			}
			if (
				m.type === "naia-tool-call" &&
				m.tool === "skill_cafelua_tarot" &&
				typeof m.id === "string"
			) {
				try {
					const result = await handler.current(m.args ?? {});
					window.parent.postMessage(
						{ type: "naia-tool-result", id: m.id, result },
						e.origin || "*",
					);
				} catch (error) {
					window.parent.postMessage(
						{
							type: "naia-tool-result",
							id: m.id,
							error: error instanceof Error ? error.message : String(error),
						},
						e.origin || "*",
					);
				}
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	const cards = reading?.cards ?? [];
	const flippedIndices: number[] = [];
	cards.forEach((c, idx) => {
		if (c.isFlipped) flippedIndices.push(idx);
	});
	const last = flippedIndices.length;
	const current = last ? cards[flippedIndices[last - 1]] : null;
	const selected =
		spotlightIndex !== null && cards[spotlightIndex]?.isFlipped
			? cards[spotlightIndex]
			: null;
	const selectedFlippedOrder =
		spotlightIndex !== null ? flippedIndices.indexOf(spotlightIndex) : -1;

	const displayName = (c: DrawnCard) => (ko ? c.card.nameKr : c.card.nameEn);
	const position = (c: DrawnCard) =>
		ko ? c.position.nameKr : c.position.nameEn;

	const spreadClass =
		reading?.spread === "one"
			? "one"
			: reading?.spread === "three"
				? "three"
				: "celtic";

	return (
		<main
			className="tarot-app"
			style={{
				backgroundImage: `linear-gradient(180deg,rgba(0,0,0,.38),rgba(0,0,0,.16) 45%,rgba(0,0,0,.58)),url('${assetUrl(loungeBackground(new Date()))}')`,
			}}
		>
			<div
				className={screen === "table" ? "table-screen" : "table-screen hidden"}
			>
				<header className="table-header">
					<strong>
						{reading
							? reading.question || ui(locale, "today")
							: appText(locale, "title")}
					</strong>
					<div className="table-header-actions">
						{reading && (
							<button
								type="button"
								className="header-pill-btn"
								data-usage-event="cafelua-tarot.ctrl-14.click" onClick={resetToSpreadPicker}
							>
								{ui(locale, "newReading")}
							</button>
						)}
						<button
							type="button"
							aria-label={appText(locale, "stories")}
							data-usage-event="cafelua-tarot.ctrl-15.click" onClick={() => {
								setScreen("book");
								void book.current?.open(0);
							}}
						>
							▤
						</button>
						<button
							type="button"
							aria-label={
								muted ? appText(locale, "unmute") : appText(locale, "mute")
							}
							aria-pressed={muted}
							data-usage-event="cafelua-tarot.ctrl-16.click" onClick={() => {
								audio.current?.setMuted(!muted);
								setMuted(!muted);
							}}
						>
							{muted ? "♩" : "♫"}
						</button>
					</div>
				</header>
				<section
					className={`table-area ${reading ? spreadClass : "setup"}`}
					aria-label={ui(locale, "table")}
				>
					{!reading ? (
						<div className="spread-setup">
							<div className="deck setup-deck" aria-hidden="true">
								{[0, 1, 2, 3].map((i) => (
									<img
										key={i}
										src={assetUrl("tarot/card-back.webp")}
										alt=""
									/>
								))}
							</div>
							<div
								className="spread-picker"
								role="group"
								aria-label={ui(locale, "chooseSpread")}
							>
								<h2 className="spread-picker-title">
									{ui(locale, "chooseSpread")}
								</h2>
								<div className="spread-options">
									{SPREAD_OPTIONS.map((opt) => {
										const active = preferredSpread === opt.id;
										return (
											<button
												key={opt.id}
												type="button"
												className={`spread-option ${active ? "active" : ""}`}
												data-spread={opt.id}
												aria-pressed={active}
												data-usage-event="cafelua-tarot.ctrl-17.click" onClick={() => selectPreferredSpread(opt.id)}
											>
												<div className="spread-option-top">
													<span className="spread-count-badge">
														{opt.count}
													</span>
													{opt.recommended && (
														<span className="spread-rec-badge">
															{ui(locale, "recommended")}
														</span>
													)}
												</div>
												<strong className="spread-option-name">
													{ui(locale, opt.titleKey)}
												</strong>
												<span className="spread-option-desc">
													{ui(locale, opt.descKey)}
												</span>
											</button>
										);
									})}
								</div>
							</div>
						</div>
					) : (
						<>
							<div className="spread-board">
								{cards.map((c, i) => (
									<div className={`card-place card-${i + 1}`} key={c.card.id}>
										<button
											type="button"
											className={`card ${c.isFlipped ? "flipped" : ""} ${!finished && last > 0 && flippedIndices[last - 1] === i ? "current" : ""} ${spotlightIndex === i ? "selected-card" : ""}`}
											aria-label={`${position(c)}: ${c.isFlipped ? displayName(c) : ui(locale, "faceDown")}`}
											data-usage-event="cafelua-tarot.ctrl-18.click" onClick={() => {
												if (c.isFlipped) {
													setArtFullscreen(false);
													setSpotlightIndex(i);
												} else {
													showNotice(ui(locale, "nextHint"));
												}
											}}
										>
											<img
												className={c.isFlipped && c.isReversed ? "reversed" : ""}
												src={assetUrl(
													c.isFlipped
														? c.card.imagePath
														: "tarot/card-back.webp",
												)}
												alt=""
											/>
										</button>
										<span>
											{i === 0 && reading.spread === "celtic"
												? t("현재 / 도전", "Present / Challenge")
												: i === 1 && reading.spread === "celtic"
													? ""
													: position(c)}
										</span>
									</div>
								))}
							</div>
							{last > 0 && !selected && (
								<button
									type="button"
									className="spotlight-reopen"
									data-usage-event="cafelua-tarot.ctrl-19.click" onClick={() => setSpotlightIndex(flippedIndices[last - 1])}
								>
									🔍 {ui(locale, "enlargeCard")}
								</button>
							)}
						</>
					)}
				</section>
				<footer
					className={`table-footer ${finished ? "summary" : ""}`}
					role="status"
				>
					{finished ? (
						<>
							<div>{ui(locale, "storyCards")}</div>
							<div className="story-buttons">
								{cards.map((c) => (
									<button
										type="button"
										key={c.card.id}
										data-usage-event="cafelua-tarot.ctrl-20.click" onClick={() => {
											setScreen("book");
											void book.current?.open(2 + c.card.id);
										}}
									>
										<img src={assetUrl(c.card.imagePath)} alt="" />
										{displayName(c)}
									</button>
								))}
							</div>
							<small>{ui(locale, "newQuestion")}</small>
						</>
					) : notice || !reading ? (
						<>
							<span>{notice || ui(locale, "prompt")}</span>
							{!notice && <small>{ui(locale, "examples")}</small>}
						</>
					) : current ? (
						<div className="footer-current-row">
							<span>
								{last} / {cards.length} · {position(current)} ·{" "}
								{displayName(current)} (
								{current.isReversed
									? appText(locale, "reversed")
									: appText(locale, "upright")}
								)
							</span>
							{!selected && (
								<button
									type="button"
									className="footer-enlarge-btn"
									data-usage-event="cafelua-tarot.ctrl-21.click" onClick={() => setSpotlightIndex(flippedIndices[last - 1])}
								>
									{ui(locale, "enlargeCard")}
								</button>
							)}
						</div>
					) : (
						ui(locale, "laid")
					)}
				</footer>
				{selected && (
					<div
						className="meaning-overlay modal"
						data-usage-event="cafelua-tarot.ctrl-22.click" onClick={() => {
							setArtFullscreen(false);
							setSpotlightIndex(null);
						}}
					>
						<section
							role="dialog"
							aria-label={displayName(selected)}
							className={`meaning tarot-spotlight zoomed ${artFullscreen ? "art-only" : ""}`}
							data-usage-event="cafelua-tarot.ctrl-23.click" onClick={(e) => e.stopPropagation()}
							onPointerDown={(e) => {
								if (
									e.clientY - e.currentTarget.getBoundingClientRect().top < 36
								) {
									meaningDrag.current = e.clientY;
									e.currentTarget.setPointerCapture(e.pointerId);
								}
							}}
							onPointerUp={(e) => {
								if (
									meaningDrag.current !== null &&
									e.clientY - meaningDrag.current > 40
								) {
									setArtFullscreen(false);
									setSpotlightIndex(null);
								}
								meaningDrag.current = null;
							}}
						>
							<div className="spotlight-topbar">
								<span className="spotlight-pos-pill">
									{selectedFlippedOrder + 1} / {last} · {position(selected)}
								</span>
								<div className="spotlight-controls">
									<button
										type="button"
										className="spotlight-zoom-btn"
										data-usage-event="cafelua-tarot.ctrl-24.click" onClick={() => setArtFullscreen((z) => !z)}
									>
										{artFullscreen
											? ui(locale, "shrinkCard")
											: ui(locale, "enlargeCard")}
									</button>
									<button
										type="button"
										className="meaning-close"
										data-usage-event="cafelua-tarot.ctrl-25.click" onClick={() => {
											setArtFullscreen(false);
											setSpotlightIndex(null);
										}}
										aria-label={ui(locale, "close")}
									>
										×
									</button>
								</div>
							</div>
							<div className="spotlight-body">
								<button
									type="button"
									className="spotlight-art"
									data-usage-event="cafelua-tarot.ctrl-26.click" onClick={() => setArtFullscreen((z) => !z)}
									aria-label={
										artFullscreen
											? ui(locale, "shrinkCard")
											: ui(locale, "enlargeCard")
									}
								>
									<img
										className={selected.isReversed ? "reversed" : ""}
										src={assetUrl(selected.card.imagePath)}
										alt={displayName(selected)}
									/>
								</button>
								{!artFullscreen && (
									<div className="spotlight-meta">
										<h2>
											<span>
												{selected.card.id}. {displayName(selected)}
											</span>
											<em
												className={`orient-badge ${selected.isReversed ? "is-reversed" : "is-upright"}`}
											>
												{selected.isReversed
													? appText(locale, "reversed")
													: appText(locale, "upright")}
											</em>
										</h2>
										{ko && (
											<p className="spotlight-pos-desc">
												{selected.position.description}
											</p>
										)}
										<p className="spotlight-keywords">
											{selected.card.keywords.join(" · ")}
										</p>
										<div className="spotlight-meanings">
											<div
												className={
													!selected.isReversed
														? "meaning-active"
														: "meaning-dim"
												}
											>
												<b>{appText(locale, "upright")}</b>
												<p>{selected.card.upright.join(" · ")}</p>
											</div>
											<div
												className={
													selected.isReversed
														? "meaning-active"
														: "meaning-dim"
												}
											>
												<b>{appText(locale, "reversed")}</b>
												<p>{selected.card.reversed.join(" · ")}</p>
											</div>
										</div>
									</div>
								)}
							</div>
							{last > 1 && (
								<div className="spotlight-nav">
									<button
										type="button"
										disabled={selectedFlippedOrder <= 0}
										data-usage-event="cafelua-tarot.ctrl-27.click" onClick={() => {
											if (selectedFlippedOrder > 0) {
												setSpotlightIndex(
													flippedIndices[selectedFlippedOrder - 1],
												);
											}
										}}
									>
										‹ {ui(locale, "prevCard")}
									</button>
									<button
										type="button"
										disabled={selectedFlippedOrder >= last - 1}
										data-usage-event="cafelua-tarot.ctrl-28.click" onClick={() => {
											if (selectedFlippedOrder < last - 1) {
												setSpotlightIndex(
													flippedIndices[selectedFlippedOrder + 1],
												);
											}
										}}
									>
										{ui(locale, "nextCard")} ›
									</button>
								</div>
							)}
						</section>
					</div>
				)}
			</div>
			<div className={`book-layer ${screen === "book" ? "" : "hidden"}`}>
				<Book ref={book} locale={locale} onBack={() => setScreen("table")} />
			</div>
		</main>
	);
}

const rootEl = document.getElementById("root");
if (rootEl) {
	createRoot(rootEl).render(<TarotApp />);
}
