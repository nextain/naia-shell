import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../lib/config";
import { t } from "../lib/i18n";
import { fetchNaiaModelCapabilities } from "../lib/llm/registry";
import {
	type SmallLlmChoice,
	type SurfacingLevel,
	describeSurfacingState,
	readSmallLlmSelection,
	readSurfacingLevel,
	writeSmallLlmSelection,
	writeSurfacingLevel,
} from "../lib/llm/surfacing";

export interface SmallLlmSectionProps {
	readonly config: AppConfig | null;
	readonly naiaKeyPresent: boolean;
	readonly gatewayHttpUrl: string;
	/** Persist the whole next config (the parent saves it and re-renders). */
	readonly onPersist: (next: AppConfig) => void;
	/** Injected for tests; defaults to fetchNaiaModelCapabilities. */
	readonly fetchCatalog?: (url: string) => Promise<Map<string, unknown> | null>;
}

export function SmallLlmSection({
	config,
	naiaKeyPresent,
	gatewayHttpUrl,
	onPersist,
	fetchCatalog,
}: SmallLlmSectionProps) {
	const selection = readSmallLlmSelection(config);
	const [selectedChoice, setSelectedChoice] = useState<
		SmallLlmChoice | "off" | "threshold" | null
	>(null);
	const defaultChoice: SmallLlmChoice | "off" | "threshold" =
		selection.surfacingOff
			? "off"
			: config?.memorySurfacingJudge === "threshold"
				? "threshold"
				: selection.choice === "ollama" || selection.choice === "vllm"
					? selection.choice
					: selection.choice === "naia" && naiaKeyPresent
						? "naia"
						: "threshold";
	const activeChoice = selectedChoice ?? defaultChoice;

	const [selectedLevel, setSelectedLevel] = useState<SurfacingLevel | null>(null);
	const activeLevel = selectedLevel ?? readSurfacingLevel(config);

	useEffect(() => {
		setSelectedLevel(null);
	}, [config?.memorySurfacingLevel]);

	const handleSelectLevel = (level: SurfacingLevel) => {
		if (!config) return;
		setSelectedLevel(level);
		onPersist(writeSurfacingLevel(config, level));
	};

	const [baseUrl, setBaseUrl] = useState<string>(
		selection.choice === "ollama"
			? selection.baseUrl || "http://localhost:11434/v1"
			: selection.choice === "vllm"
				? selection.baseUrl || "http://localhost:8000/v1"
				: "http://localhost:11434/v1",
	);
	const [model, setModel] = useState<string>(
		selection.choice === "ollama" || selection.choice === "vllm"
			? selection.model || ""
			: "",
	);

	const [gatewayModels, setGatewayModels] = useState<
		Set<string> | null | undefined
	>(undefined);

	const fetchCatalogRef = useRef(fetchCatalog ?? fetchNaiaModelCapabilities);
	fetchCatalogRef.current = fetchCatalog ?? fetchNaiaModelCapabilities;

	useEffect(() => {
		let alive = true;
		setGatewayModels(undefined);
		fetchCatalogRef.current(gatewayHttpUrl)
			.then((res) => {
				if (!alive) return;
				if (!res) {
					setGatewayModels(null);
				} else {
					setGatewayModels(new Set(res.keys()));
				}
			})
			.catch(() => {
				if (!alive) return;
				setGatewayModels(null);
			});
		return () => {
			alive = false;
		};
	}, [gatewayHttpUrl]);

	if (!config) return null;

	const handleSelectNaia = () => {
		setSelectedChoice("naia");
		onPersist(writeSmallLlmSelection(config, { choice: "naia" }));
	};

	const handleSelectOff = () => {
		setSelectedChoice("off");
		onPersist(writeSmallLlmSelection(config, { choice: "off" }));
	};

	const handleSelectThreshold = () => {
		setSelectedChoice("threshold");
		onPersist(writeSmallLlmSelection(config, { choice: "threshold" }));
	};

	const handleSelectLocal = (choice: "ollama" | "vllm") => {
		setSelectedChoice(choice);
		let nextBase = baseUrl;
		let nextModel = model;
		if (selection.choice === choice) {
			nextBase =
				selection.baseUrl ||
				(choice === "ollama"
					? "http://localhost:11434/v1"
					: "http://localhost:8000/v1");
			nextModel = selection.model || "";
		} else {
			nextBase =
				choice === "ollama"
					? "http://localhost:11434/v1"
					: "http://localhost:8000/v1";
			nextModel = "";
		}
		setBaseUrl(nextBase);
		setModel(nextModel);
		if (nextModel.trim().length > 0) {
			onPersist(
				writeSmallLlmSelection(config, {
					choice,
					baseUrl: nextBase,
					model: nextModel.trim(),
				}),
			);
		}
	};

	const handleBlur = () => {
		if (activeChoice !== "ollama" && activeChoice !== "vllm") return;
		const trimmedModel = model.trim();
		if (!trimmedModel) return;
		onPersist(
			writeSmallLlmSelection(config, {
				choice: activeChoice,
				baseUrl,
				model: trimmedModel,
			}),
		);
	};

	const state = describeSurfacingState(config, {
		naiaKeyPresent,
		gatewayModels: gatewayModels ?? null,
	});

	let stateText = "";
	switch (state.kind) {
		case "on":
			if (state.billing === "naia") {
				stateText = t("settings.surfacingOnNaia", { model: state.model });
			} else if (state.billing === "local") {
				stateText = t("settings.surfacingOnLocal", { model: state.model });
			} else {
				stateText = t("settings.surfacingOnOwn", {
					provider: state.provider,
					model: state.model,
				});
			}
			break;
		case "on-threshold":
			if (state.reason === "user-choice") {
				stateText = t("settings.surfacingThresholdChosen", {
					threshold: state.threshold.toFixed(2),
				});
			} else if (state.reason === "no-small-llm") {
				stateText = t("settings.surfacingOnThreshold", {
					threshold: state.threshold.toFixed(2),
				});
			} else if (state.reason === "inherited-billed") {
				stateText = t("settings.surfacingThresholdInherited", {
					provider: state.provider ?? "",
					model: state.model ?? "",
					threshold: state.threshold.toFixed(2),
				});
			} else {
				stateText = t("settings.surfacingThresholdPendingGateway", {
					model: state.model ?? "",
					threshold: state.threshold.toFixed(2),
				});
			}
			break;
		case "off-disabled":
			stateText = t("settings.surfacingOffDisabled");
			break;
		case "off-no-embedding":
			stateText = t("settings.surfacingOffNoEmbedding");
			break;
	}

	return (
		<>
			<div className="settings-section-divider">
				<span>{t("settings.smallLlm")}</span>
			</div>
			<div className="settings-field" data-testid="small-llm-section">
				<div className="settings-hint">{t("settings.smallLlmHint")}</div>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: "8px",
						marginTop: "4px",
					}}
				>
					<label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
						<input
							type="radio"
							name="small-llm"
							value="naia"
							data-testid="small-llm-choice-naia"
							checked={activeChoice === "naia"}
							disabled={!naiaKeyPresent}
							onChange={handleSelectNaia}
						/>
						{t("settings.smallLlmNaia")}
						{!naiaKeyPresent && (
							<span className="settings-hint" style={{ marginLeft: "8px" }}>
								⚠ {t("settings.memoryNaiaRequired")}
							</span>
						)}
					</label>
					<label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
						<input
							type="radio"
							name="small-llm"
							value="ollama"
							data-testid="small-llm-choice-ollama"
							checked={activeChoice === "ollama"}
							onChange={() => handleSelectLocal("ollama")}
						/>
						{t("settings.smallLlmOllama")}
					</label>
					<label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
						<input
							type="radio"
							name="small-llm"
							value="vllm"
							data-testid="small-llm-choice-vllm"
							checked={activeChoice === "vllm"}
							onChange={() => handleSelectLocal("vllm")}
						/>
						{t("settings.smallLlmVllm")}
					</label>
					<label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
						<input
							type="radio"
							name="small-llm"
							value="threshold"
							data-testid="small-llm-choice-threshold"
							checked={activeChoice === "threshold"}
							onChange={handleSelectThreshold}
						/>
						{t("settings.smallLlmThreshold")}
					</label>
					<label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
						<input
							type="radio"
							name="small-llm"
							value="off"
							data-testid="small-llm-choice-off"
							checked={activeChoice === "off"}
							onChange={handleSelectOff}
						/>
						{t("settings.smallLlmOff")}
					</label>
				</div>
				{activeChoice !== "off" &&
					(state.kind === "on" || state.kind === "on-threshold") && (
					<div
						role="radiogroup"
						aria-label={t("settings.surfacingLevel")}
						data-testid="surfacing-level"
						style={{
							display: "flex",
							flexDirection: "column",
							gap: "6px",
							marginTop: "8px",
							flexWrap: "wrap",
						}}
					>
						<label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
							<input
								type="radio"
								name="surfacing-level"
								value="less"
								data-testid="surfacing-level-less"
								checked={activeLevel === "less"}
								onChange={() => handleSelectLevel("less")}
							/>
							{t("settings.surfacingLevelLess")}
						</label>
						<label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
							<input
								type="radio"
								name="surfacing-level"
								value="normal"
								data-testid="surfacing-level-normal"
								checked={activeLevel === "normal"}
								onChange={() => handleSelectLevel("normal")}
							/>
							{t("settings.surfacingLevelNormal")}
						</label>
						<label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
							<input
								type="radio"
								name="surfacing-level"
								value="more"
								data-testid="surfacing-level-more"
								checked={activeLevel === "more"}
								onChange={() => handleSelectLevel("more")}
							/>
							{t("settings.surfacingLevelMore")}
						</label>
						<div className="settings-hint">
							{t("settings.surfacingLevelHint")}
						</div>
					</div>
				)}
				{(activeChoice === "ollama" || activeChoice === "vllm") && (
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: "6px",
							marginTop: "8px",
						}}
					>
						<label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
							{t("settings.smallLlmBaseUrl")}
							<input
								type="text"
								data-testid="small-llm-base-url"
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
								onBlur={handleBlur}
								placeholder={
									activeChoice === "ollama"
										? "http://localhost:11434/v1"
										: "http://localhost:8000/v1"
								}
							/>
						</label>
						<label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
							{t("settings.smallLlmModel")}
							<input
								type="text"
								data-testid="small-llm-model"
								value={model}
								onChange={(e) => setModel(e.target.value)}
								onBlur={handleBlur}
								placeholder=""
							/>
						</label>
						<div className="settings-hint">{t("settings.smallLlmLocalHint")}</div>
					</div>
				)}
				<div
					className="settings-hint"
					data-testid="small-llm-state"
					role="status"
					style={{ marginTop: "8px" }}
				>
					{stateText}
				</div>
				<div className="settings-hint">{t("settings.surfacingApplyHint")}</div>
				<div
					className="settings-hint"
					data-testid="surfacing-memory-tool-note"
					style={{ marginTop: "4px" }}
				>
					{t("settings.surfacingMemoryToolNote")}
				</div>
			</div>
		</>
	);
}
