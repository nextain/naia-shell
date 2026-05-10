import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { listNaiaAssets, toAssetUrl } from "../lib/adk-store";
import { loadConfig, saveConfig } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { useAvatarStore } from "../stores/avatar";
import { useChatStore } from "../stores/chat";

type Step =
	| "agentName"
	| "userName"
	| "speechStyle"
	| "character"
	| "background"
	| "provider"
	| "complete";

// Steps shown when Naia key is already set (skip provider)
const STEPS_WITH_NAIA: Step[] = [
	"agentName",
	"userName",
	"speechStyle",
	"character",
	"background",
	"complete",
];
const STEPS_WITHOUT_NAIA: Step[] = [
	"agentName",
	"userName",
	"speechStyle",
	"character",
	"background",
	"provider",
	"complete",
];

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogg", "avi"]);
function isVideo(url: string) {
	return VIDEO_EXTS.has(
		url.split("?")[0].split(".").pop()?.toLowerCase() ?? "",
	);
}

function stepChat(step: Step, name: string, user: string): string {
	const n = name || "나이아";
	const u = user ? `${user}님` : "";
	switch (step) {
		case "agentName":
			return "안녕하세요! 저는 나이아예요. 제 이름을 지어주세요! ✨";
		case "userName":
			return `${n}! 정말 좋은 이름이에요. 그럼 저는 당신을 어떻게 부를까요?`;
		case "speechStyle":
			return `${u || ""}! 어떤 말투로 대화할까요? 편한 걸 골라주세요 😊`;
		case "character":
			return "제 외모를 골라주세요! 마음에 드는 캐릭터가 있나요? 🌸";
		case "background":
			return "배경화면도 함께 골라볼까요? 클릭하면 바로 바뀌어요! 🌟";
		case "provider":
			return "거의 다 왔어요! 저의 두뇌를 연결해 주세요 🧠";
		case "complete":
			return `${u ? u + ", " : ""}준비 완료! ${n}와 함께 시작해요! 🎉`;
	}
}

interface BgOption {
	url: string;
	label: string;
}

function getNaiaWebBaseUrl() {
	return (
		import.meta.env.VITE_NAIA_WEB_BASE_URL?.trim() || "https://naia.nextain.io"
	);
}

export function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
	const setAvatarModelPath = useAvatarStore((s) => s.setModelPath);
	const setBackgroundVideoUrl = useAvatarStore((s) => s.setBackgroundVideoUrl);
	const addMessage = useChatStore((s) => s.addMessage);

	const hasNaiaKey = !!localStorage.getItem("naia-remote-key");
	const STEPS = hasNaiaKey ? STEPS_WITH_NAIA : STEPS_WITHOUT_NAIA;

	const [step, setStep] = useState<Step>("agentName");
	const [agentName, setAgentName] = useState("");
	const [userName, setUserName] = useState("");
	const [speechStyle, setSpeechStyle] = useState<
		"casual" | "formal" | "honorific"
	>("casual");
	const [honorific, setHonorific] = useState("");
	const [naiaVrms, setNaiaVrms] = useState<string[]>([]);
	const [selectedVrm, setSelectedVrm] = useState("");
	const [backgrounds, setBackgrounds] = useState<BgOption[]>([]);
	const [selectedBg, setSelectedBg] = useState("/assets/background-space.webp");
	// Provider step state
	const [apiKey, setApiKey] = useState("");
	const [apiKeyMode, setApiKeyMode] = useState(false);
	const [naiaLoginWaiting, setNaiaLoginWaiting] = useState(false);
	const [naiaLoginDone, setNaiaLoginDone] = useState(hasNaiaKey);
	const naiaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const stepIndex = STEPS.indexOf(step);
	const didMount = useRef(false);
	const transitioning = useRef(false);

	// Load VRM list from naia-settings only — no hardcoded fallback
	useEffect(() => {
		listNaiaAssets("vrm-files").then((paths) => {
			const vrms = paths.filter((p) => p.toLowerCase().endsWith(".vrm"));
			setNaiaVrms(vrms);
			if (vrms.length > 0) setSelectedVrm((prev) => prev || vrms[0]);
		});
	}, []);

	// Initial chat message + default background
	useEffect(() => {
		if (!didMount.current) {
			didMount.current = true;
			setBackgroundVideoUrl("/assets/background-space.webp");
			setTimeout(() => {
				addMessage({
					role: "assistant",
					content: stepChat("agentName", "", ""),
				});
			}, 800);
		}
	}, [addMessage]);

	// Load backgrounds from ADK folder
	useEffect(() => {
		const builtin: BgOption = {
			url: "/assets/background-space.webp",
			label: t("onboard.background.default"),
		};
		listNaiaAssets("background")
			.then((paths) => {
				const adkBgs: BgOption[] = paths.map((p) => ({
					url: toAssetUrl(p),
					label:
						p
							.split(/[/\\]/)
							.pop()
							?.replace(/\.[^.]+$/, "") ?? p,
				}));
				setBackgrounds([builtin, ...adkBgs]);
			})
			.catch(() => setBackgrounds([builtin]));
	}, []);

	// Listen for Naia OAuth callback in provider step
	useEffect(() => {
		const unlisten = listen<{ naiaKey: string; naiaUserId?: string }>(
			"naia_auth_complete",
			(event) => {
				if (naiaTimerRef.current) clearTimeout(naiaTimerRef.current);
				localStorage.setItem("naia-remote-key", event.payload.naiaKey);
				if (event.payload.naiaUserId) {
					localStorage.setItem("naia-remote-user-id", event.payload.naiaUserId);
				}
				setNaiaLoginWaiting(false);
				setNaiaLoginDone(true);
			},
		);
		return () => {
			unlisten.then((fn) => fn());
			if (naiaTimerRef.current) clearTimeout(naiaTimerRef.current);
		};
	}, []);

	function goNext() {
		if (transitioning.current) return;
		const next = STEPS[stepIndex + 1];
		if (!next) return;
		transitioning.current = true;
		setStep(next);
		setTimeout(() => {
			addMessage({
				role: "assistant",
				content: stepChat(next, agentName.trim() || "나이아", userName.trim()),
			});
			transitioning.current = false;
		}, 300);
	}

	function goBack() {
		const prev = STEPS[stepIndex - 1];
		if (!prev) return;
		setStep(prev);
	}

	function handleVrmSelect(path: string) {
		setSelectedVrm(path);
		setAvatarModelPath(path);
	}

	function handleBgSelect(url: string) {
		setSelectedBg(url);
		setBackgroundVideoUrl(url);
	}

	async function handleNaiaLogin() {
		setNaiaLoginWaiting(true);
		naiaTimerRef.current = setTimeout(
			() => setNaiaLoginWaiting(false),
			180_000,
		);
		try {
			const lang = getLocale();
			const url = `${getNaiaWebBaseUrl()}/${lang}/login?redirect=desktop&source=embedded`;
			const ok = await invoke("browser_open_login", { url }).then(
				() => true,
				() => false,
			);
			if (!ok) {
				const state = await invoke<string>("generate_oauth_state").catch(
					() => "",
				);
				const params = new URLSearchParams({
					redirect: "desktop",
					source: "desktop",
				});
				if (state) params.set("state", state);
				await openUrl(
					`${getNaiaWebBaseUrl()}/${lang}/login?${params.toString()}`,
				);
			}
		} catch {
			setNaiaLoginWaiting(false);
		}
	}

	function handleComplete() {
		const base = loadConfig() ?? {
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "",
		};
		const vrmPath = selectedVrm.replace(/^\//, "");
		const bgFilename = !selectedBg.startsWith("/assets/")
			? (selectedBg.split(/[/\\?]/).pop() ?? undefined)
			: undefined;

		const speechDesc =
			speechStyle === "casual"
				? "casually and warmly"
				: speechStyle === "formal"
					? "formally and professionally"
					: "respectfully using honorifics";
		const persona = `You are ${agentName.trim() || "Naia"}, an AI companion. Speak ${speechDesc}.`;

		saveConfig({
			...base,
			agentName: agentName.trim() || "Naia",
			userName: userName.trim() || undefined,
			speechStyle,
			honorific:
				speechStyle === "honorific" && honorific.trim()
					? honorific.trim()
					: undefined,
			vrmModel: vrmPath,
			backgroundVideo: bgFilename,
			persona,
			...(apiKey.trim() && !naiaLoginDone ? { apiKey: apiKey.trim() } : {}),
			onboardingComplete: true,
		});

		setAvatarModelPath(`/${vrmPath}`);
		addMessage({
			role: "assistant",
			content: stepChat(
				"complete",
				agentName.trim() || "나이아",
				userName.trim(),
			),
		});
		setTimeout(onComplete, 1200);
	}

	const isFirst = stepIndex === 0;
	const isCompleteStep = step === "complete";
	const progressSteps = STEPS.slice(0, -1); // exclude "complete" from dot indicators

	return (
		<div className="onboarding-panel">
			{/* Progress dots */}
			<div className="onboarding-progress">
				{progressSteps.map((s, i) => (
					<div
						key={s}
						className={`onboarding-progress__dot${
							s === step ? " onboarding-progress__dot--active" : ""
						}${i < stepIndex ? " onboarding-progress__dot--done" : ""}`}
					/>
				))}
			</div>

			{/* Step content */}
			<div className="onboarding-step">
				{step === "agentName" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.agentName.title")}
						</h2>
						<input
							className="onboarding-step__input"
							value={agentName}
							onChange={(e) => setAgentName(e.target.value)}
							placeholder="Naia"
							maxLength={20}
							autoFocus
							onKeyDown={(e) => e.key === "Enter" && goNext()}
						/>
						<p className="onboarding-step__hint">
							{t("onboard.agentName.description")}
						</p>
					</>
				)}

				{step === "userName" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.userName.title").replace(
								"{agent}",
								agentName.trim() || "나이아",
							)}
						</h2>
						<input
							className="onboarding-step__input"
							value={userName}
							onChange={(e) => setUserName(e.target.value)}
							placeholder="Luke"
							maxLength={20}
							autoFocus
							onKeyDown={(e) => e.key === "Enter" && goNext()}
						/>
						<p className="onboarding-step__hint">
							{t("onboard.userName.description")}
						</p>
					</>
				)}

				{step === "speechStyle" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.speechStyle.title").replace(
								"{agent}",
								agentName.trim() || "나이아",
							)}
						</h2>
						<div className="onboarding-step__options">
							{(["casual", "formal", "honorific"] as const).map((style) => (
								<button
									key={style}
									type="button"
									className={`onboarding-step__option${speechStyle === style ? " onboarding-step__option--selected" : ""}`}
									onClick={() => setSpeechStyle(style)}
								>
									<span className="onboarding-step__option-label">
										{style === "casual"
											? t("onboard.speechStyle.casual")
											: style === "formal"
												? t("onboard.speechStyle.formal")
												: t("onboard.speechStyle.honorificLabel")}
									</span>
									<span className="onboarding-step__option-desc">
										{style === "casual"
											? t("onboard.speechStyle.casualDesc")
											: style === "formal"
												? t("onboard.speechStyle.formalDesc")
												: ""}
									</span>
								</button>
							))}
						</div>
						{speechStyle === "honorific" && (
							<input
								className="onboarding-step__input onboarding-step__input--sm"
								value={honorific}
								onChange={(e) => setHonorific(e.target.value)}
								placeholder={t("onboard.speechStyle.honorificPlaceholder")}
								maxLength={10}
							/>
						)}
					</>
				)}

				{step === "character" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.character.title")
								.replace("{user}", userName.trim() || "")
								.replace("{agent}", agentName.trim() || "나이아")}
						</h2>
						<div className="onboarding-step__avatar-list">
							{naiaVrms.length === 0 ? (
								<p className="onboarding-step__hint onboarding-step__hint--warn">
									naia-settings/vrm-files/ 폴더에 VRM 파일이 없습니다.
									<br />
									파일을 추가하고 앱을 재시작해 주세요.
								</p>
							) : (
								naiaVrms.map((path) => {
									const label = (path.split(/[/\\]/).pop() ?? path).replace(
										/\.vrm$/i,
										"",
									);
									return (
										<button
											key={path}
											type="button"
											className={`onboarding-step__avatar-item${selectedVrm === path ? " onboarding-step__avatar-item--selected" : ""}`}
											onClick={() => handleVrmSelect(path)}
										>
											{label}
										</button>
									);
								})
							)}
						</div>
						<p className="onboarding-step__hint">
							{t("onboard.character.hint")}
						</p>
					</>
				)}

				{step === "background" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.background.title")}
						</h2>
						<div className="onboarding-step__bg-grid">
							{backgrounds.map((bg) => (
								<button
									key={bg.url}
									type="button"
									className={`onboarding-step__bg-card${selectedBg === bg.url ? " onboarding-step__bg-card--selected" : ""}`}
									onClick={() => handleBgSelect(bg.url)}
								>
									{isVideo(bg.url) ? (
										<div className="onboarding-step__bg-video-thumb">▶</div>
									) : (
										<img
											src={bg.url}
											alt={bg.label}
											className="onboarding-step__bg-img"
										/>
									)}
									<span className="onboarding-step__bg-label">{bg.label}</span>
								</button>
							))}
						</div>
						<p className="onboarding-step__hint">
							{t("onboard.background.hint")}
						</p>
					</>
				)}

				{step === "provider" && (
					<>
						<h2 className="onboarding-step__title">{t("onboard.lab.title")}</h2>
						{naiaLoginDone ? (
							<div className="onboarding-step__provider-done">
								<span className="onboarding-step__provider-check">✓</span>
								<p>{t("onboard.lab.connected")}</p>
							</div>
						) : apiKeyMode ? (
							<>
								<p className="onboarding-step__hint">
									API 키를 입력하세요. 나중에 설정에서 변경할 수 있어요.
								</p>
								<input
									className="onboarding-step__input"
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder="sk-... / gw-..."
									autoFocus
								/>
								<button
									type="button"
									className="onboarding-step__link"
									onClick={() => setApiKeyMode(false)}
								>
									← Naia 로그인으로 돌아가기
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									className="onboarding-step__naia-btn"
									onClick={handleNaiaLogin}
									disabled={naiaLoginWaiting}
								>
									{naiaLoginWaiting
										? t("onboard.lab.waiting")
										: t("onboard.lab.login")}
								</button>
								<div className="onboarding-step__provider-or">
									{t("onboard.lab.or")}
								</div>
								<button
									type="button"
									className="onboarding-step__link"
									onClick={() => setApiKeyMode(true)}
								>
									{t("provider.apiKeyRequired")} 직접 입력
								</button>
								<button
									type="button"
									className="onboarding-step__link onboarding-step__link--muted"
									onClick={goNext}
								>
									나중에 설정 →
								</button>
							</>
						)}
					</>
				)}

				{step === "complete" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.complete.greeting").replace(
								"{name}",
								userName.trim() || "게스트",
							)}
						</h2>
						<p className="onboarding-step__hint">
							{t("onboard.complete.ready").replace(
								"{agent}",
								agentName.trim() || "나이아",
							)}
						</p>
					</>
				)}
			</div>

			{/* Navigation */}
			<div className="onboarding-step__actions">
				{!isFirst && !isCompleteStep && (
					<button
						type="button"
						className="onboarding-step__back-btn"
						onClick={goBack}
					>
						{t("onboard.back")}
					</button>
				)}
				{/* Provider step: skip handled internally; other steps show Next/Start */}
				{step !== "provider" && (
					<button
						type="button"
						className="onboarding-step__next-btn"
						onClick={isCompleteStep ? handleComplete : goNext}
					>
						{isCompleteStep ? t("onboard.complete.start") : t("onboard.next")}
					</button>
				)}
				{step === "provider" && (naiaLoginDone || apiKeyMode) && (
					<button
						type="button"
						className="onboarding-step__next-btn"
						onClick={goNext}
					>
						{t("onboard.next")}
					</button>
				)}
			</div>
		</div>
	);
}
