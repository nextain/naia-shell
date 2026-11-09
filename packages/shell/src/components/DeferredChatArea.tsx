import {
	type ComponentType,
	type ReactNode,
	Suspense,
	lazy,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import {
	SLIDE_PRESENTER_SPEAK_EVENT,
	activateSlidePresenterSpeechConsumer,
	consumeBufferedSlidePresenterSpeech,
	deactivateSlidePresenterSpeechConsumer,
	ensureSlidePresenterSpeechBuffer,
	failBufferedSlidePresenterSpeech,
	prepareSlidePresenterSpeechConsumer,
} from "../lib/slide-presenter-events";
import type { ChatVariant } from "./ChatArea";
import { ErrorBoundary } from "./ErrorBoundary";

type ChatComponent = ComponentType<{
	variant?: ChatVariant;
	headerControls?: ReactNode;
}>;
type ChatLoader = () => Promise<{ default: ChatComponent }>;

const defaultLoader: ChatLoader = () =>
	import("./ChatArea").then((module) => ({ default: module.ChatArea }));

function LoadedChatArea({
	Chat,
	variant,
	headerControls,
}: {
	Chat: ChatComponent;
	variant?: ChatVariant;
	headerControls?: ReactNode;
}) {
	useEffect(() => {
		const buffered = activateSlidePresenterSpeechConsumer();
		const timer = buffered
			? window.setTimeout(() => {
					const request = consumeBufferedSlidePresenterSpeech(
						buffered.requestId,
					);
					if (request) {
						window.dispatchEvent(
							new CustomEvent(SLIDE_PRESENTER_SPEAK_EVENT, {
								detail: request,
							}),
						);
					}
				}, 0)
			: undefined;
		return () => {
			if (timer != null) window.clearTimeout(timer);
			deactivateSlidePresenterSpeechConsumer();
		};
	}, []);
	return <Chat variant={variant} headerControls={headerControls} />;
}

export function DeferredChatArea({
	variant,
	headerControls,
	load = defaultLoader,
	reload = () => window.location.reload(),
	reloadOnFailure = load === defaultLoader,
}: {
	variant?: ChatVariant;
	headerControls?: ReactNode;
	load?: ChatLoader;
	reload?: () => void;
	reloadOnFailure?: boolean;
}) {
	useLayoutEffect(() => {
		prepareSlidePresenterSpeechConsumer();
		return ensureSlidePresenterSpeechBuffer();
	}, []);
	const [attempt, setAttempt] = useState(0);
	const retry = () => {
		Logger.debug("DeferredChatArea", "retry requested", {
			attempt,
			reloadOnFailure,
		});
		if (reloadOnFailure) {
			Logger.debug("DeferredChatArea", "reloading shell after chunk failure");
			return reload();
		}
		prepareSlidePresenterSpeechConsumer();
		Logger.debug("DeferredChatArea", "remounting injected chat loader", {
			nextAttempt: attempt + 1,
		});
		setAttempt((value) => value + 1);
	};
	const Chat = useMemo(
		() =>
			lazy(() => {
				void attempt;
				return load().catch((error) => {
					failBufferedSlidePresenterSpeech("chat_unavailable");
					throw error;
				});
			}),
		[attempt, load],
	);

	return (
		<ErrorBoundary
			scope="ChatArea"
			resetKey={attempt}
			fallback={
				<div role="alert">
					<p>{t("chat.error")}</p>
					<button type="button" onClick={retry}>
						{t("common.retry")}
					</button>
				</div>
			}
		>
			<Suspense
				fallback={<output aria-live="polite">{t("progress.loading")}</output>}
			>
				<LoadedChatArea
					Chat={Chat}
					variant={variant}
					headerControls={headerControls}
				/>
			</Suspense>
		</ErrorBoundary>
	);
}
