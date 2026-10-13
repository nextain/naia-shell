import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type TarotAudioController,
	createBrowserAudioController,
} from "./audio";
import {
	STORY_AUTHORS,
	cardById,
	storyForCard,
	validatePackagedContent,
} from "./content";
import { FALLBACK_TAROT_CARDS } from "./data/fallbackCards";
import {
	TAROT_STORY_EDITIONS,
	type TarotStoryEditionKey,
} from "./data/tarotStories";
import type { DrawnCard } from "./data/types";
import {
	type AppLocale,
	LANGUAGE_NAMES,
	UI_LABELS,
	appText,
	contentLocale,
	normalizeAppLocale,
} from "./i18n";
import {
	type TarotReading,
	drawCelticCross,
	nextUnrevealedCard,
	revealNextCard,
} from "./reading";
import { type TarotToolResult, createTarotToolHandler } from "./tools";
import "./tarot.css";

const APP_ID = "land.naia.cafelua-tarot";
const TOOL_NAME = "skill_cafelua_tarot";
const localeEvent = "naia-app:locale";
const toolCallEvent = "naia-tool-call";
const toolResultEvent = "naia-tool-result";
const replyEvent = "naia-cafelua-tarot:response";
const PROMPT_LIMIT = 9_000;

function makeId(): string {
	return `reading-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function imageSrc(imagePath: string): string {
	return imagePath.replace(/^\//, "");
}

function makeCardPrompt(
	reading: TarotReading,
	drawn: DrawnCard,
	locale: AppLocale,
): string {
	const chapterEn = storyForCard("fable", drawn.card.id);
	const language = LANGUAGE_NAMES[locale];
	const direction = drawn.isReversed ? "reversed" : "upright";
	const meaning =
		locale === "ko"
			? `${drawn.card.keywords.join(", ")}; ${drawn.card.objects.map((item) => `${item.cafelua} (${item.meaning})`).join(", ")}; ${drawn.card[drawn.isReversed ? "reversed" : "upright"].join(", ")}`
			: (chapterEn?.cardMeaningEn ?? "");
	return [
		`You are Naia, the user's tarot reader. Interpret this Cafe Lua Tarot card as a reflective prompt, not a certain prediction. Reply in ${language} (${locale}). The user chose this question and revealed the card in the app.`,
		`Question: ${reading.question || "No question was supplied; offer a gentle general reflection."}`,
		`Celtic Cross position: ${drawn.position.nameEn} (${drawn.position.nameKr}) — ${drawn.position.description}.`,
		`Card: ${drawn.card.nameEn} (${drawn.card.nameKr}), ${direction}.`,
		`Cafe Lua card meaning: ${meaning}`,
		"Speak as Naia, never as Alpha. Connect the card to its position and the question in a few warm, grounded sentences. Do not call Cafe Lua servers or any tarot API.",
	]
		.join("\n")
		.slice(0, PROMPT_LIMIT);
}

function makeSummaryPrompt(reading: TarotReading, locale: AppLocale): string {
	const language = LANGUAGE_NAMES[locale];
	const cards = reading.cards
		.map(
			({ card, position, isReversed }) =>
				`${position.nameEn}: ${card.nameEn} (${isReversed ? "reversed" : "upright"})`,
		)
		.join("\n");
	return [
		`You are Naia, the user's tarot reader. In ${language} (${locale}), synthesize this completed Cafe Lua Celtic Cross as a reflective reading, not a certain prediction. Never speak as Alpha.`,
		`Question: ${reading.question || "No question supplied."}`,
		cards,
		"Describe the overall pattern, one practical reflection, and one open question for the user. Do not call external tarot services.",
	]
		.join("\n")
		.slice(0, PROMPT_LIMIT);
}

function TarotApp() {
	const [locale, setLocale] = useState<AppLocale>(() =>
		normalizeAppLocale(navigator.language.split("-")[0]),
	);
	const [activeTab, setActiveTab] = useState<
		"reading" | "cards" | "stories" | "credits"
	>("reading");
	const [reading, setReading] = useState<TarotReading | null>(null);
	const readingRef = useRef<TarotReading | null>(null);
	const [question, setQuestion] = useState("");
	const [pendingRequest, setPendingRequest] = useState<string | null>(null);
	const [reply, setReply] = useState("");
	const [failed, setFailed] = useState(false);
	const [playbackBlocked, setPlaybackBlocked] = useState(false);
	const [muted, setMuted] = useState(false);
	const [storyEdition, setStoryEdition] =
		useState<TarotStoryEditionKey>("fable");
	const [selectedCardId, setSelectedCardId] = useState(0);
	const [packError, setPackError] = useState(false);
	const bgmRef = useRef<HTMLAudioElement | null>(null);
	const audioRef = useRef<TarotAudioController | null>(null);
	const toolHandlerRef = useRef<
		(args: Record<string, unknown>) => TarotToolResult
	>(() => ({ status: "empty", message: "The app is initializing." }));

	const strings = useMemo(
		() => ({
			reading: appText(locale, "reading"),
			cards: appText(locale, "cards"),
			stories: appText(locale, "stories"),
			credits: appText(locale, "credits"),
		}),
		[locale],
	);

	useEffect(() => {
		if (!validatePackagedContent()) {
			setPackError(true);
			return;
		}
		const onMessage = async (event: MessageEvent) => {
			if (
				event.source !== window.parent ||
				!event.data ||
				typeof event.data !== "object"
			)
				return;
			const message = event.data as Record<string, unknown>;
			if (message.type === localeEvent && typeof message.locale === "string") {
				const nextLocale = normalizeAppLocale(message.locale);
				setLocale(nextLocale);
				document.documentElement.lang = nextLocale;
				document.documentElement.dir = nextLocale === "ar" ? "rtl" : "ltr";
				return;
			}
			if (message.type === replyEvent && typeof message.id === "string") {
				const response = message.text;
				if (typeof response !== "string" || response.length > 30_000) return;
				if (message.error) setFailed(true);
				else {
					setReply(response);
					setFailed(false);
				}
				setPendingRequest((current) =>
					current === message.id ? null : current,
				);
				return;
			}
			if (
				message.type === toolCallEvent &&
				typeof message.id === "string" &&
				message.tool === TOOL_NAME
			) {
				const args =
					message.args && typeof message.args === "object"
						? (message.args as Record<string, unknown>)
						: {};
				try {
					const result = toolHandlerRef.current(args);
					window.parent.postMessage(
						{ type: toolResultEvent, id: message.id, result },
						event.origin || "*",
					);
				} catch (error) {
					window.parent.postMessage(
						{
							type: toolResultEvent,
							id: message.id,
							error: error instanceof Error ? error.message : String(error),
						},
						event.origin || "*",
					);
				}
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	useEffect(() => {
		const bgm = new Audio("sounds/taro-bgm.mp3");
		bgm.preload = "auto";
		bgm.volume = 0.42;
		bgmRef.current = bgm;
		const audio = createBrowserAudioController(bgm, (playing) =>
			setPlaybackBlocked(!playing),
		);
		audioRef.current = audio;
		void audio.startBgm().then((playing) => setPlaybackBlocked(!playing));
		const retryOnGesture = () => {
			if (!audio.isMuted)
				void audio.startBgm().then((playing) => setPlaybackBlocked(!playing));
		};
		window.addEventListener("pointerdown", retryOnGesture, { once: true });
		return () => {
			window.removeEventListener("pointerdown", retryOnGesture);
			audio.dispose();
			bgmRef.current = null;
			audioRef.current = null;
		};
	}, []);

	function storeReading(next: TarotReading | null) {
		readingRef.current = next;
		setReading(next);
	}

	const toolHandler = useMemo(
		() =>
			createTarotToolHandler({
				getReading: () => readingRef.current,
				startReading: (nextQuestion) => {
					const next = drawCelticCross(nextQuestion);
					readingRef.current = next;
					setReading(next);
					setReply("");
					setFailed(false);
					setPendingRequest(null);
					return next;
				},
				setReading: (next) => {
					readingRef.current = next;
					setReading(next);
				},
				onReveal: () => {
					void audioRef.current?.playFlip();
				},
			}),
		[],
	);
	toolHandlerRef.current = toolHandler;

	function startReading(event: React.FormEvent) {
		event.preventDefault();
		const next = drawCelticCross(question);
		storeReading(next);
		setReply("");
		setFailed(false);
		setPendingRequest(null);
		setActiveTab("reading");
	}

	function requestNaia(prompt: string) {
		const id = makeId();
		setPendingRequest(id);
		setReply("");
		setFailed(false);
		window.parent.postMessage(
			{ type: "naia-cafelua-tarot:ask", appId: APP_ID, id, prompt },
			"*",
		);
	}

	function flipNextCard() {
		const current = readingRef.current;
		if (!current || pendingRequest) return;
		const nextCard = nextUnrevealedCard(current);
		if (!nextCard) return;
		const updated = revealNextCard(current);
		storeReading(updated);
		setSelectedCardId(nextCard.card.id);
		void audioRef.current?.playFlip();
		requestNaia(
			makeCardPrompt(updated, { ...nextCard, isFlipped: true }, locale),
		);
	}

	function askForSummary() {
		const current = readingRef.current;
		if (!current || pendingRequest) return;
		requestNaia(makeSummaryPrompt(current, locale));
	}

	function retryInterpretation() {
		const current = readingRef.current;
		if (!current || pendingRequest) return;
		const lastRevealed = current.cards
			.slice()
			.reverse()
			.find((item) => item.isFlipped);
		if (lastRevealed)
			requestNaia(makeCardPrompt(current, lastRevealed, locale));
		else askForSummary();
	}

	function toggleMute() {
		const nextMuted = !muted;
		setMuted(nextMuted);
		audioRef.current?.setMuted(nextMuted);
		setPlaybackBlocked(false);
	}

	const renderCardMeaning = (cardId: number) => {
		const card = cardById(cardId);
		if (!card) return null;
		if (contentLocale(locale) === "ko")
			return (
				<div className="tarot-meaning-block">
					<h3>{appText(locale, "keywords")}</h3>
					<p>{card.keywords.join(" · ")}</p>
					<h3>{appText(locale, "upright")}</h3>
					<ul>
						{card.upright.map((meaning) => (
							<li key={meaning}>{meaning}</li>
						))}
					</ul>
					<h3>{appText(locale, "reversed")}</h3>
					<ul>
						{card.reversed.map((meaning) => (
							<li key={meaning}>{meaning}</li>
						))}
					</ul>
					<h3>{appText(locale, "symbols")}</h3>
					<ul>
						{card.objects.map((object) => (
							<li key={object.cafelua}>
								<b>{object.cafelua}</b> — {object.meaning}
							</li>
						))}
					</ul>
				</div>
			);
		const fable = storyForCard("fable", cardId);
		const astra = storyForCard("astra", cardId);
		return (
			<div className="tarot-meaning-block">
				<h3>{appText(locale, "meaning")}</h3>
				<p>
					<b>Fable</b> · {fable?.cardMeaningEn}
				</p>
				<p>
					<b>Astra</b> · {astra?.cardMeaningEn}
				</p>
			</div>
		);
	};

	const nav = [
		["reading", strings.reading],
		["cards", strings.cards],
		["stories", strings.stories],
		["credits", strings.credits],
	] as const;
	const moveTabFocus = (
		event: React.KeyboardEvent<HTMLButtonElement>,
		currentTab: (typeof nav)[number][0],
	) => {
		const backwards = locale === "ar" ? "ArrowRight" : "ArrowLeft";
		const forwards = locale === "ar" ? "ArrowLeft" : "ArrowRight";
		const currentIndex = nav.findIndex(([tab]) => tab === currentTab);
		let nextIndex: number;
		if (event.key === backwards)
			nextIndex = (currentIndex + nav.length - 1) % nav.length;
		else if (event.key === forwards)
			nextIndex = (currentIndex + 1) % nav.length;
		else if (event.key === "Home") nextIndex = 0;
		else if (event.key === "End") nextIndex = nav.length - 1;
		else return;
		event.preventDefault();
		const [nextTab] = nav[nextIndex];
		setActiveTab(nextTab);
		document.getElementById(`tarot-tab-${nextTab}`)?.focus();
	};
	const story = storyForCard(storyEdition, selectedCardId);
	const edition = TAROT_STORY_EDITIONS[storyEdition];
	const chosenCard = cardById(selectedCardId);
	const revealed = reading?.cards.filter((item) => item.isFlipped).length ?? 0;
	const allRevealed = !!reading && revealed === reading.cards.length;

	return (
		<main className="cafelua-tarot" dir={locale === "ar" ? "rtl" : "ltr"}>
			<header className="tarot-header">
				<div className="tarot-brand">
					<div className="tarot-brand-mark" aria-hidden="true">
						☾
					</div>
					<div>
						<p className="tarot-eyebrow">{UI_LABELS[locale].brand}</p>
						<h1>{appText(locale, "title")}</h1>
					</div>
				</div>
				<button
					className="tarot-sound"
					type="button"
					aria-label={
						muted ? appText(locale, "unmute") : appText(locale, "mute")
					}
					title={muted ? appText(locale, "unmute") : appText(locale, "mute")}
					onClick={toggleMute}
				>
					<span aria-hidden="true">{muted ? "♪̸" : "♫"}</span>
				</button>
			</header>
			<nav
				className="tarot-tabs"
				role="tablist"
				aria-orientation="horizontal"
				aria-label={appText(locale, "title")}
			>
				{nav.map(([tab, label]) => (
					<button
						key={tab}
						id={`tarot-tab-${tab}`}
						type="button"
						role="tab"
						aria-selected={activeTab === tab}
						aria-controls={`tarot-panel-${tab}`}
						tabIndex={activeTab === tab ? 0 : -1}
						className={activeTab === tab ? "is-active" : ""}
						onClick={() => setActiveTab(tab)}
						onKeyDown={(event) => moveTabFocus(event, tab)}
					>
						{label}
					</button>
				))}
			</nav>
			{playbackBlocked && (
				<output className="tarot-audio-note">
					{appText(locale, "audioBlocked")}
				</output>
			)}
			{packError ? (
				<section role="alert" className="tarot-error">
					<h2>{appText(locale, "toolError")}</h2>
					<p>{appText(locale, "toolError")}</p>
				</section>
			) : (
				<>
					{activeTab === "reading" && (
						<section
							id="tarot-panel-reading"
							role="tabpanel"
							className="tarot-screen"
							aria-labelledby="reading-heading"
						>
							<div className="tarot-screen-heading">
								<div>
									<p className="tarot-eyebrow">{UI_LABELS[locale].deck}</p>
									<h2 id="reading-heading">
										{appText(locale, "readingTitle")}
									</h2>
								</div>
								<p className="tarot-screen-note">
									{appText(locale, "naiaNote")}
								</p>
							</div>
							{!reading ? (
								<div className="tarot-welcome">
									<div className="tarot-welcome-copy">
										<p>{appText(locale, "intro")}</p>
										<p className="tarot-deck-note">
											{appText(locale, "deckIntro")}
										</p>
										<p className="tarot-count">
											{appText(locale, "cardCount")}
										</p>
									</div>
									<form className="tarot-question-form" onSubmit={startReading}>
										<label htmlFor="tarot-question">
											{appText(locale, "question")}
										</label>
										<textarea
											id="tarot-question"
											value={question}
											maxLength={500}
											rows={3}
											placeholder={appText(locale, "questionPlaceholder")}
											onChange={(event) => setQuestion(event.target.value)}
										/>
										<p>{appText(locale, "questionHint")}</p>
										<button className="tarot-primary" type="submit">
											{appText(locale, "begin")}
										</button>
									</form>
								</div>
							) : (
								<>
									<div className="tarot-reading-meta">
										<span>
											{appText(locale, "revealedCount", { shown: revealed })}
										</span>
										{reading.question && (
											<span className="tarot-reading-question">
												{appText(locale, "questionLabel")}: {reading.question}
											</span>
										)}
									</div>
									<div
										className="tarot-spread"
										aria-label={appText(locale, "readingTitle")}
									>
										{reading.cards.map((drawn, index) => (
											<article
												className={`tarot-spread-card tarot-spread-position-${index}${drawn.isFlipped ? " is-flipped" : ""}`}
												key={`${drawn.position.index}-${drawn.card.id}`}
											>
												<p className="tarot-position">
													{locale === "ko"
														? drawn.position.nameKr
														: drawn.position.nameEn}
												</p>
												<button
													type="button"
													className="tarot-card-button"
													aria-label={`${drawn.position.nameEn}: ${drawn.isFlipped ? (locale === "ko" ? drawn.card.nameKr : drawn.card.nameEn) : appText(locale, "revealNext")}`}
													disabled={
														!drawn.isFlipped &&
														(pendingRequest !== null ||
															index !==
																reading.cards.findIndex(
																	(card) => !card.isFlipped,
																))
													}
													onClick={
														drawn.isFlipped
															? () => setSelectedCardId(drawn.card.id)
															: flipNextCard
													}
												>
													{drawn.isFlipped ? (
														<img
															src={imageSrc(drawn.card.imagePath)}
															alt={`${drawn.card.nameEn} / ${drawn.card.nameKr}`}
															style={{
																transform: drawn.isReversed
																	? "rotate(180deg)"
																	: undefined,
															}}
														/>
													) : (
														<span
															className="tarot-card-back"
															aria-hidden="true"
														>
															<span>☾</span>
															<small>CAFE LUA</small>
															<span>✦</span>
														</span>
													)}
												</button>
												{drawn.isFlipped && (
													<p className="tarot-card-label">
														{locale === "ko"
															? drawn.card.nameKr
															: drawn.card.nameEn}
														{drawn.isReversed
															? ` · ${appText(locale, "reversed")}`
															: ""}
													</p>
												)}
											</article>
										))}
									</div>
									<div className="tarot-reading-actions">
										{!allRevealed ? (
											<button
												className="tarot-primary"
												type="button"
												onClick={flipNextCard}
												disabled={pendingRequest !== null}
											>
												{appText(locale, "revealNext")}
											</button>
										) : (
											<button
												className="tarot-primary"
												type="button"
												onClick={askForSummary}
												disabled={pendingRequest !== null}
											>
												{appText(locale, "askNaia")}
											</button>
										)}
										<button
											className="tarot-secondary"
											type="button"
											onClick={() => {
												storeReading(null);
												setReply("");
												setQuestion("");
											}}
										>
											{appText(locale, "readingAgain")}
										</button>
									</div>
									{pendingRequest && (
										<output className="tarot-pending" aria-live="polite">
											{appText(locale, "naiaReading")}
										</output>
									)}
									{failed && (
										<div role="alert" className="tarot-error">
											<p>{appText(locale, "naiaError")}</p>
											<button
												type="button"
												className="tarot-secondary"
												onClick={retryInterpretation}
											>
												{appText(locale, "retry")}
											</button>
										</div>
									)}
									{reply && (
										<section className="tarot-naia-reply" aria-live="polite">
											<h3>Naia</h3>
											<p>{reply}</p>
										</section>
									)}
								</>
							)}
						</section>
					)}
					{activeTab === "cards" && (
						<section
							id="tarot-panel-cards"
							role="tabpanel"
							className="tarot-screen"
							aria-labelledby="cards-heading"
						>
							<div className="tarot-screen-heading">
								<div>
									<p className="tarot-eyebrow">{UI_LABELS[locale].gallery}</p>
									<h2 id="cards-heading">{appText(locale, "cards")}</h2>
								</div>
								<p className="tarot-screen-note">
									{appText(locale, "deckIntro")}
								</p>
							</div>
							<div className="tarot-library-layout">
								<ul
									className="tarot-card-index"
									aria-label={appText(locale, "cards")}
								>
									{FALLBACK_TAROT_CARDS.map((card) => (
										<li key={card.id}>
											<button
												type="button"
												aria-current={
													selectedCardId === card.id ? "true" : undefined
												}
												className={
													selectedCardId === card.id ? "is-selected" : ""
												}
												onClick={() => setSelectedCardId(card.id)}
											>
												<img
													src={imageSrc(card.imagePath)}
													alt=""
													loading="lazy"
												/>
												<span>
													{String(card.id).padStart(2, "0")} ·{" "}
													{locale === "ko" ? card.nameKr : card.nameEn}
												</span>
											</button>
										</li>
									))}
								</ul>
								<article className="tarot-card-detail">
									{chosenCard && (
										<>
											<div className="tarot-card-detail-top">
												<img
													src={imageSrc(chosenCard.imagePath)}
													alt={`${chosenCard.nameEn} / ${chosenCard.nameKr}`}
												/>
												<div>
													<p className="tarot-eyebrow">
														{String(chosenCard.id).padStart(2, "0")} / 21
													</p>
													<h3>
														{locale === "ko"
															? chosenCard.nameKr
															: chosenCard.nameEn}
													</h3>
													<p className="tarot-card-en-name">
														{locale === "ko"
															? chosenCard.nameEn
															: chosenCard.nameKr}
													</p>
												</div>
											</div>
											{renderCardMeaning(chosenCard.id)}
										</>
									)}
								</article>
							</div>
							{contentLocale(locale) === "en" && locale !== "en" && (
								<p className="tarot-language-note">
									{appText(locale, "englishOnly")}
								</p>
							)}
						</section>
					)}
					{activeTab === "stories" && (
						<section
							id="tarot-panel-stories"
							role="tabpanel"
							className="tarot-screen"
							aria-labelledby="stories-heading"
						>
							<div className="tarot-screen-heading">
								<div>
									<p className="tarot-eyebrow">{UI_LABELS[locale].stories}</p>
									<h2 id="stories-heading">{appText(locale, "stories")}</h2>
								</div>
								<p className="tarot-screen-note">
									{appText(locale, "storyDeckNote")}
								</p>
							</div>
							<div
								className="tarot-story-switch"
								aria-label={appText(locale, "stories")}
							>
								<button
									type="button"
									aria-pressed={storyEdition === "fable"}
									className={storyEdition === "fable" ? "is-active" : ""}
									onClick={() => setStoryEdition("fable")}
								>
									{appText(locale, "storyFable")}
								</button>
								<button
									type="button"
									aria-pressed={storyEdition === "astra"}
									className={storyEdition === "astra" ? "is-active" : ""}
									onClick={() => setStoryEdition("astra")}
								>
									{appText(locale, "storyAstra")}
								</button>
							</div>
							<div className="tarot-story-banner">
								<img
									src={chosenCard ? imageSrc(chosenCard.imagePath) : ""}
									alt=""
								/>
								<div>
									<p className="tarot-eyebrow">{STORY_AUTHORS[storyEdition]}</p>
									<h3>{locale === "ko" ? edition.titleKo : edition.titleEn}</h3>
									<p>
										{contentLocale(locale) === "ko"
											? edition.introKo
											: edition.introEn}
									</p>
								</div>
							</div>
							<div className="tarot-story-layout">
								<ul
									className="tarot-story-chapters"
									aria-label={appText(locale, "stories")}
								>
									{FALLBACK_TAROT_CARDS.map((card) => {
										const chapter = storyForCard(storyEdition, card.id);
										return (
											<li key={card.id}>
												<button
													type="button"
													className={
														selectedCardId === card.id ? "is-selected" : ""
													}
													onClick={() => setSelectedCardId(card.id)}
												>
													<span>{String(card.id).padStart(2, "0")}</span>
													<span>
														{locale === "ko"
															? chapter?.titleKo
															: chapter?.titleEn}
													</span>
												</button>
											</li>
										);
									})}
								</ul>
								<article className="tarot-story-body">
									{story && chosenCard && (
										<>
											<div className="tarot-story-title">
												<span>
													{appText(locale, "storyChapter", {
														number: selectedCardId,
													})}
												</span>
												<h3>
													{contentLocale(locale) === "ko"
														? story.titleKo
														: story.titleEn}
												</h3>
												<p>
													{contentLocale(locale) === "ko"
														? story.summaryKo
														: story.summaryEn}
												</p>
											</div>
											<div className="tarot-story-prose">
												{(contentLocale(locale) === "ko"
													? story.bodyKo
													: story.bodyEn
												)
													.split("\n\n")
													.map((paragraph) => (
														<p key={paragraph}>{paragraph}</p>
													))}
											</div>
											<aside className="tarot-story-meaning">
												<b>{appText(locale, "meaning")}</b>
												<p>
													{contentLocale(locale) === "ko"
														? story.cardMeaningKo
														: story.cardMeaningEn}
												</p>
											</aside>
										</>
									)}
								</article>
							</div>
							<p className="tarot-collaboration-note">
								{appText(locale, "storyAuthors")}
							</p>
							{contentLocale(locale) === "en" && locale !== "en" && (
								<p className="tarot-language-note">
									{appText(locale, "englishOnly")}
								</p>
							)}
						</section>
					)}
					{activeTab === "credits" && (
						<section
							id="tarot-panel-credits"
							role="tabpanel"
							className="tarot-screen"
							aria-labelledby="credits-heading"
						>
							<div className="tarot-screen-heading">
								<div>
									<p className="tarot-eyebrow">CAFE LUA · CC BY-NC-SA 4.0</p>
									<h2 id="credits-heading">{appText(locale, "license")}</h2>
								</div>
							</div>
							<div className="tarot-license-panel">
								<p>{appText(locale, "licenseText")}</p>
								<a
									href="https://creativecommons.org/licenses/by-nc-sa/4.0/"
									target="_blank"
									rel="noreferrer"
								>
									{appText(locale, "licenseLink")}
								</a>
								<p className="tarot-license-source">
									{UI_LABELS[locale].bgmLicense}
								</p>
							</div>
						</section>
					)}
				</>
			)}
			<footer className="tarot-footer">
				Cafe Lua · v2.0 <span>·</span> {appText(locale, "naiaNote")}
			</footer>
		</main>
	);
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<TarotApp />);
