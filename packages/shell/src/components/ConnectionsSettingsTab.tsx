import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";

type ConnectionState =
	| "checking"
	| "disconnected"
	| "configured"
	| "connected"
	| "error";
type Participation = "mentions" | "all" | "paused";

interface CredentialStatus {
	readonly configured: boolean;
	readonly code: string;
}

interface DiscoveredChannel {
	readonly id: string;
	readonly name: string;
	readonly kind: number;
	readonly position: number;
	readonly permissions: {
		readonly viewChannel: boolean;
		readonly sendMessages: boolean;
		readonly readMessageHistory: boolean;
		readonly usable: boolean;
	};
}

interface DiscoveredGuild {
	readonly id: string;
	readonly name: string;
	readonly channels: readonly DiscoveredChannel[];
}

interface DiscordDiscovery {
	readonly botId: string;
	readonly botUsername: string;
	readonly messageContentIntent: boolean;
	readonly intentCode: string;
	readonly guilds: readonly DiscoveredGuild[];
	readonly degradedGuildIds: readonly string[];
	readonly discoveryTruncated: boolean;
}

interface RuntimeStatus {
	readonly tokenConfigured: boolean;
	readonly generation?: number;
	readonly state: string;
	readonly code?: string;
	readonly authoritative: boolean;
}

interface BindingInput {
	readonly bindingId: string;
	readonly guildId: string;
	readonly guildName?: string | null;
	readonly channelId: string;
	readonly channelName?: string | null;
	readonly allowedUserIds: readonly string[];
	readonly processingProfileRef: "default";
	readonly participation: Participation;
}

const SNOWFLAKE = /^\d{6,32}$/;

function bindingIdFor(guildId: string, channelId: string): string {
	return `discord_${guildId}_${channelId}`;
}

function parseAllowedUsers(value: string): readonly string[] {
	return [...new Set(value.split(",").map((id) => id.trim()))].filter(
		(id) => id.length > 0,
	);
}

export function ConnectionsSettingsTab() {
	const [state, setState] = useState<ConnectionState>("checking");
	const [discovery, setDiscovery] = useState<DiscordDiscovery | null>(null);
	const [bindingSnapshot, setBindingSnapshot] = useState<
		readonly BindingInput[]
	>([]);
	const [runtimeErrorCode, setRuntimeErrorCode] = useState<string | null>(null);
	const [discoveryErrorCode, setDiscoveryErrorCode] = useState<string | null>(
		null,
	);
	const refreshVersionRef = useRef(0);
	const statusVersionRef = useRef(0);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [participation, setParticipation] = useState<
		Readonly<Record<string, Participation>>
	>({});
	const [allowedUsersText, setAllowedUsersText] = useState<
		Readonly<Record<string, string>>
	>({});
	const [saved, setSaved] = useState(false);
	const [saving, setSaving] = useState(false);
	const errorCode = runtimeErrorCode ?? discoveryErrorCode;

	const snapshotByBindingId = useMemo(
		() =>
			new Map(
				bindingSnapshot.map((binding) => [binding.bindingId, binding] as const),
			),
		[bindingSnapshot],
	);
	const snapshotByChannel = useMemo(
		() =>
			new Map(
				bindingSnapshot.map(
					(binding) =>
						[`${binding.guildId}:${binding.channelId}`, binding] as const,
				),
			),
		[bindingSnapshot],
	);
	const usableChannelKeys = useMemo(
		() =>
			new Set(
				discovery?.guilds.flatMap((guild) =>
					guild.channels
						.filter((channel) => channel.permissions.usable)
						.map((channel) => `${guild.id}:${channel.id}`),
				) ?? [],
			),
		[discovery],
	);
	const degradedGuildIds = useMemo(
		() => new Set(discovery?.degradedGuildIds ?? []),
		[discovery],
	);
	const discoveredGuildIds = useMemo(
		() => new Set(discovery?.guilds.map((guild) => guild.id) ?? []),
		[discovery],
	);
	const bindingDiscoveryIsUncertain = useCallback(
		(binding: BindingInput) =>
			degradedGuildIds.has(binding.guildId) ||
			(discovery?.discoveryTruncated === true &&
				!discoveredGuildIds.has(binding.guildId)),
		[degradedGuildIds, discoveredGuildIds, discovery?.discoveryTruncated],
	);
	const unavailableBindings = useMemo(
		() =>
			bindingSnapshot.filter(
				(binding) =>
					!usableChannelKeys.has(`${binding.guildId}:${binding.channelId}`),
			),
		[bindingSnapshot, usableChannelKeys],
	);
	const staleBindings = useMemo(
		() =>
			unavailableBindings.filter(
				(binding) => !bindingDiscoveryIsUncertain(binding),
			),
		[bindingDiscoveryIsUncertain, unavailableBindings],
	);
	const uncertainBindings = useMemo(
		() => unavailableBindings.filter(bindingDiscoveryIsUncertain),
		[bindingDiscoveryIsUncertain, unavailableBindings],
	);
	const selectedUsersValid = useMemo(
		() =>
			[...selected].every((bindingId) => {
				const ids = parseAllowedUsers(allowedUsersText[bindingId] ?? "");
				return ids.length > 0 && ids.every((id) => SNOWFLAKE.test(id));
			}),
		[allowedUsersText, selected],
	);

	const restoreBindings = useCallback((bindings: readonly BindingInput[]) => {
		setBindingSnapshot(bindings);
		setSelected(new Set(bindings.map((binding) => binding.bindingId)));
		setParticipation(
			Object.fromEntries(
				bindings.map((binding) => [binding.bindingId, binding.participation]),
			),
		);
		setAllowedUsersText(
			Object.fromEntries(
				bindings.map((binding) => [
					binding.bindingId,
					binding.allowedUserIds.join(", "),
				]),
			),
		);
	}, []);

	const refresh = useCallback(async () => {
		const refreshVersion = ++refreshVersionRef.current;
		const statusVersion = ++statusVersionRef.current;
		setState("checking");
		setDiscovery(null);
		setRuntimeErrorCode(null);
		setDiscoveryErrorCode(null);
		setSaved(false);
		try {
			const [runtime, bindings] = await Promise.all([
				invoke<RuntimeStatus>("discord_connection_status"),
				invoke<BindingInput[]>("discord_binding_snapshot"),
			]);
			if (
				refreshVersionRef.current !== refreshVersion ||
				statusVersionRef.current !== statusVersion
			)
				return;
			if (!runtime.tokenConfigured) {
				restoreBindings(bindings);
				setState("disconnected");
				return;
			}
			const result = await invoke<DiscordDiscovery>(
				"discord_discover_channels",
			);
			if (
				refreshVersionRef.current !== refreshVersion ||
				statusVersionRef.current !== statusVersion
			)
				return;
			restoreBindings(bindings);
			setDiscovery(result);
			if (!result.messageContentIntent) {
				setDiscoveryErrorCode(result.intentCode);
			} else if (
				result.degradedGuildIds.length > 0 ||
				result.discoveryTruncated
			) {
				setDiscoveryErrorCode("discord_discovery_incomplete");
			} else {
				setDiscoveryErrorCode(null);
			}
			setState(runtime.authoritative ? "connected" : "configured");
			setRuntimeErrorCode(runtime.code ?? null);
		} catch (error) {
			if (
				refreshVersionRef.current !== refreshVersion ||
				statusVersionRef.current !== statusVersion
			)
				return;
			setState("error");
			setDiscoveryErrorCode(null);
			setRuntimeErrorCode(String(error));
		}
	}, [restoreBindings]);

	useEffect(() => {
		void refresh();
		const unlisten = listen("discord_status_changed", () => void refresh());
		return () => {
			void unlisten.then((stop) => stop());
		};
	}, [refresh]);

	async function captureCredential() {
		setRuntimeErrorCode(null);
		setSaved(false);
		try {
			const result = await invoke<CredentialStatus>(
				"discord_capture_bot_token",
			);
			if (!result.configured) {
				setState("error");
				setRuntimeErrorCode(result.code);
				return;
			}
			await refresh();
		} catch (error) {
			setState("error");
			setRuntimeErrorCode(
				String(error).includes("capture_cancelled")
					? "capture_cancelled"
					: "native_prompt_unavailable",
			);
		}
	}

	async function removeCredential() {
		setRuntimeErrorCode(null);
		setSaved(false);
		try {
			await invoke("discord_remove_bot_token");
			await refresh();
		} catch (error) {
			setRuntimeErrorCode(String(error));
		}
	}

	function toggleChannel(bindingId: string) {
		setSaved(false);
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(bindingId)) {
				next.delete(bindingId);
			} else {
				next.add(bindingId);
				setAllowedUsersText((users) => ({
					...users,
					[bindingId]: users[bindingId] ?? "",
				}));
				setParticipation((currentParticipation) => ({
					...currentParticipation,
					[bindingId]: currentParticipation[bindingId] ?? "mentions",
				}));
			}
			return next;
		});
	}

	async function saveBindings() {
		if (!discovery || !selectedUsersValid || saving) return;
		const usableBindings: BindingInput[] = discovery.guilds.flatMap((guild) =>
			guild.channels
				.filter((channel) => {
					const existing = snapshotByChannel.get(`${guild.id}:${channel.id}`);
					return (
						channel.permissions.usable &&
						selected.has(
							existing?.bindingId ?? bindingIdFor(guild.id, channel.id),
						)
					);
				})
				.map((channel) => {
					const existing = snapshotByChannel.get(`${guild.id}:${channel.id}`);
					const bindingId =
						existing?.bindingId ?? bindingIdFor(guild.id, channel.id);
					return {
						bindingId,
						guildId: guild.id,
						guildName: guild.name,
						channelId: channel.id,
						channelName: channel.name,
						allowedUserIds: parseAllowedUsers(
							allowedUsersText[bindingId] ?? "",
						),
						processingProfileRef: "default" as const,
						participation: participation[bindingId] ?? "mentions",
					};
				}),
		);
		// An inaccessible existing binding must never disappear as a side effect of
		// editing another channel. Native validation decides whether it can be kept.
		const bindings = [
			...usableBindings,
			...unavailableBindings.filter((binding) =>
				selected.has(binding.bindingId),
			),
		];
		setSaving(true);
		try {
			await invoke<number>("discord_save_bindings", { bindings });
			await refresh();
			setSaved(true);
		} catch (error) {
			setSaved(false);
			setRuntimeErrorCode(String(error));
		} finally {
			setSaving(false);
		}
	}

	const statusLabel =
		state === "checking"
			? t("settings.connectionsChecking")
			: state === "connected"
				? t("settings.connectionsConnected")
				: state === "configured"
					? t("settings.connectionsConfigured")
					: state === "disconnected"
						? t("settings.connectionsDisconnected")
						: t("settings.connectionsError");

	return (
		<section
			className="settings-section"
			aria-labelledby="discord-connection-title"
			data-testid="discord-connections"
		>
			<h2 id="discord-connection-title">{t("settings.connectionsDiscord")}</h2>
			<p className="settings-hint">{t("settings.connectionsSecureHelp")}</p>
			<div className="settings-field">
				<span>{t("settings.connectionsStatus")}</span>
				<strong aria-live="polite">{statusLabel}</strong>
			</div>
			{discovery && (
				<div className="settings-field">
					<span>{t("settings.connectionsBot")}</span>
					<code>
						{discovery.botUsername} ({discovery.botId})
					</code>
				</div>
			)}
			<div className="settings-actions">
				<button type="button" onClick={() => void captureCredential()}>
					{state === "connected" || state === "configured"
						? t("settings.connectionsRotate")
						: t("settings.connectionsConnect")}
				</button>
				<button type="button" onClick={() => void refresh()}>
					{t("settings.connectionsRefresh")}
				</button>
				{state !== "disconnected" && (
					<button type="button" onClick={() => void removeCredential()}>
						{t("settings.connectionsRemove")}
					</button>
				)}
			</div>

			<div className="settings-field">
				<h3>{t("settings.connectionsPermissions")}</h3>
				<p className="settings-hint">
					{state === "connected" || state === "configured"
						? t("settings.connectionsPermissionPending")
						: t("settings.connectionsSetupHelp")}
				</p>
			</div>

			{discovery && (
				<>
					{discovery.guilds.map((guild) => (
						<fieldset className="settings-field" key={guild.id}>
							<legend>{guild.name}</legend>
							{guild.channels.map((channel) => {
								const existing = snapshotByChannel.get(
									`${guild.id}:${channel.id}`,
								);
								const bindingId =
									existing?.bindingId ?? bindingIdFor(guild.id, channel.id);
								const isSelected = selected.has(bindingId);
								const restored = snapshotByBindingId.get(bindingId);
								return (
									<div key={channel.id}>
										<label>
											<input
												type="checkbox"
												checked={isSelected}
												disabled={!channel.permissions.usable && !isSelected}
												onChange={() => toggleChannel(bindingId)}
											/>
											<span>#{channel.name}</span>
										</label>
										<span className="settings-hint">
											{channel.permissions.usable
												? t("settings.connectionsPermissionOk")
												: existing
													? t("settings.connectionsBindingStale")
													: t("settings.connectionsPermissionMissing")}
										</span>
										{isSelected && (
											<>
												<label>
													<span>{t("settings.connectionsAllowedUsers")}</span>
													<input
														type="text"
														inputMode="numeric"
														disabled={!channel.permissions.usable}
														value={allowedUsersText[bindingId] ?? ""}
														onChange={(event) =>
															setAllowedUsersText((current) => ({
																...current,
																[bindingId]: event.target.value,
															}))
														}
														aria-invalid={
															parseAllowedUsers(
																allowedUsersText[bindingId] ?? "",
															).length === 0 ||
															!parseAllowedUsers(
																allowedUsersText[bindingId] ?? "",
															).every((id) => SNOWFLAKE.test(id))
														}
													/>
												</label>
												<select
													aria-label={`${guild.name} #${channel.name}`}
													disabled={!channel.permissions.usable}
													value={
														participation[bindingId] ??
														restored?.participation ??
														"mentions"
													}
													onChange={(event) =>
														setParticipation((current) => ({
															...current,
															[bindingId]: event.target.value as Participation,
														}))
													}
												>
													<option value="mentions">
														{t("settings.connectionsMentionOnly")}
													</option>
													<option value="all">
														{t("settings.connectionsAllMessages")}
													</option>
													<option value="paused">
														{t("settings.connectionsPaused")}
													</option>
												</select>
											</>
										)}
									</div>
								);
							})}
						</fieldset>
					))}
					{staleBindings
						.filter(
							(binding) =>
								!discovery.guilds.some((guild) =>
									guild.channels.some(
										(channel) =>
											guild.id === binding.guildId &&
											channel.id === binding.channelId,
									),
								),
						)
						.map((binding) => (
							<fieldset
								className="settings-field"
								key={binding.bindingId}
								data-testid="discord-stale-binding"
							>
								<legend>{binding.guildName ?? binding.guildId}</legend>
								<label>
									<input
										type="checkbox"
										checked={selected.has(binding.bindingId)}
										onChange={(event) =>
											setSelected((current) => {
												const next = new Set(current);
												if (event.target.checked) {
													next.add(binding.bindingId);
												} else {
													next.delete(binding.bindingId);
												}
												return next;
											})
										}
									/>
									<span>#{binding.channelName ?? binding.channelId}</span>
								</label>
								<span className="settings-hint">
									{t("settings.connectionsBindingStale")}
								</span>
								<label>
									<span>{t("settings.connectionsAllowedUsers")}</span>
									<input
										type="text"
										value={binding.allowedUserIds.join(", ")}
										disabled
										readOnly
									/>
								</label>
								<select
									aria-label={`${binding.guildName ?? binding.guildId} #${
										binding.channelName ?? binding.channelId
									}`}
									value={binding.participation}
									disabled
								>
									<option value="mentions">
										{t("settings.connectionsMentionOnly")}
									</option>
									<option value="all">
										{t("settings.connectionsAllMessages")}
									</option>
									<option value="paused">
										{t("settings.connectionsPaused")}
									</option>
								</select>
							</fieldset>
						))}
					{uncertainBindings.map((binding) => (
						<fieldset
							className="settings-field"
							key={binding.bindingId}
							data-testid="discord-uncertain-binding"
						>
							<legend>{binding.guildName ?? binding.guildId}</legend>
							<label>
								<input
									type="checkbox"
									checked={selected.has(binding.bindingId)}
									onChange={(event) =>
										setSelected((current) => {
											const next = new Set(current);
											if (event.target.checked) {
												next.add(binding.bindingId);
											} else {
												next.delete(binding.bindingId);
											}
											return next;
										})
									}
								/>
								<span>#{binding.channelName ?? binding.channelId}</span>
							</label>
							<span className="settings-hint">
								{t("settings.connectionsPermissionPending")}
							</span>
							<label>
								<span>{t("settings.connectionsAllowedUsers")}</span>
								<input
									type="text"
									value={binding.allowedUserIds.join(", ")}
									disabled
									readOnly
								/>
							</label>
						</fieldset>
					))}
					<p className="settings-hint">
						{t("settings.connectionsAllowedUsersHint")}
					</p>
					<div className="settings-actions">
						<button
							type="button"
							disabled={saving || !selectedUsersValid}
							onClick={() => void saveBindings()}
						>
							{t("settings.save")}
						</button>
					</div>
					{saved && <output>{t("settings.connectionsBindingsSaved")}</output>}
				</>
			)}

			{errorCode && (
				<p role="alert" data-error-code={errorCode}>
					{errorCode === "capture_cancelled"
						? t("settings.connectionsCaptureCancelled")
						: errorCode === "message_content_disabled" ||
								errorCode === "discord_message_content_intent_missing"
							? t("settings.connectionsIntentMissing")
							: t("settings.connectionsTroubleshoot")}
				</p>
			)}
		</section>
	);
}
