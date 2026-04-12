/** CSS selectors verified against shell/src components. */
export const S = {
	// App
	appRoot: ".app-root",

	// SettingsTab (8th tab: chat, history, progress, skills, channels, agents, diagnostics, settings)
	settingsTab: ".settings-tab",
	settingsTabBtn: ".chat-tab:nth-child(8)",
	chatTab: ".chat-tab:first-child",
	providerSelect: "#provider-select",
	apiKeyInput: "#apikey-input",
	toolsToggle: "#tools-toggle",
	gatewayUrlInput: "#gateway-url-input",
	gatewayTokenInput: "#gateway-token-input",
	settingsSaveBtn: ".settings-save-btn",

	// ChatPanel
	chatInput: ".chat-input",
	chatSendBtn: ".chat-send-btn",
	cursorBlink: ".cursor-blink",
	assistantMessage: ".chat-message.assistant .message-content",

	// Memory
	newChatBtn: ".new-chat-btn",
	userMessage: ".chat-message.user",
	completedAssistantMessage: ".chat-message.assistant:not(.streaming)",

	// ToolActivity
	toolActivity: ".tool-activity",
	toolSuccess: ".tool-activity.tool-success",
	toolName: ".tool-name",

	// PermissionModal
	permissionAlways: ".permission-btn-always",

	// History tab (2nd tab)
	historyTab: ".chat-tab:nth-child(2)",
	historyItem: ".history-item",
	historyItemTitle: ".history-item-title",
	historyDeleteBtn: ".history-delete-btn",
	historyEmpty: ".history-tab-empty",
	historyCurrentBadge: ".history-current-badge",

	// Progress tab (3rd tab)
	progressTabBtn: ".chat-tab:nth-child(3)",

	// Cost dashboard
	costBadge: ".cost-badge-clickable",
	costDashboard: ".cost-dashboard",
	costTable: ".cost-table",

	// Onboarding wizard
	onboardingOverlay: ".onboarding-overlay",
	onboardingNextBtn: ".onboarding-next-btn",
	onboardingSkipBtn: ".onboarding-skip-btn",
	onboardingBackBtn: ".onboarding-back-btn",
	onboardingInput: ".onboarding-input",
	onboardingProviderCard: ".onboarding-provider-card",
	onboardingVrmCard: ".onboarding-vrm-card",
	onboardingPersonalityCard: ".onboarding-personality-card",
	onboardingValidateBtn: ".onboarding-validate-btn",
	onboardingValidationSuccess: ".onboarding-validation-success",
	onboardingLabSection: ".onboarding-provider-card.lab-card",
	onboardingLabBtn: ".onboarding-provider-card.lab-card",
	onboardingLabDesc: ".onboarding-provider-card.lab-card .provider-card-desc",
	onboardingDivider: ".onboarding-divider",

	// Lab (Settings + CostDashboard)
	labConnectedRow: ".lab-connected-row",
	labBalanceSection: ".lab-balance-section",
	labBalanceRow: ".lab-balance-row",
	labChargeBtn: ".lab-charge-btn",

	// Skills tab (4th tab)
	skillsTab: ".chat-tab:nth-child(4)",
	skillsTabPanel: ".skills-tab",
	skillsSearch: ".skills-search",
	skillsCard: ".skill-card",
	skillsCardName: ".skill-card-name",
	skillsToggle: ".skill-toggle input",
	skillsSectionTitle: ".skills-section-title",
	skillsCount: ".skills-count",
	skillsEnableAllBtn: ".skills-action-btn:first-child",
	skillsDisableAllBtn: ".skills-action-btn:last-child",
	gatewaySkillCard: '[data-testid="gateway-skill-card"]',
	skillsInstallBtn: '[data-testid="skills-install-btn"]',
	skillInstallResultSuccess: ".skill-install-result.success",
	skillInstallResultError: ".skill-install-result.error",

	// Channels tab (5th tab)
	channelsTabBtn: ".chat-tab:nth-child(5)",
	channelsTabPanel: '[data-testid="channels-tab"]',
	channelCard: '[data-testid="channel-card"]',
	channelAccount: '[data-testid="channel-account"]',
	channelStatus: '[data-testid="channel-status"]',
	channelsSettingsHint: '[data-testid="channels-settings-hint"]',
	channelLoginBtn: ".channel-action-btn.login",
	channelLogoutBtn: ".channel-action-btn.logout",
	channelsRefreshBtn: ".channels-refresh-btn",

	// Agents tab (6th tab)
	agentsTabBtn: ".chat-tab:nth-child(6)",
	agentsTabPanel: '[data-testid="agents-tab"]',
	agentCard: '[data-testid="agent-card"]',
	sessionCard: '[data-testid="session-card"]',
	agentsRefreshBtn: ".agents-refresh-btn",

	// Gateway TTS (Settings, Phase 5)
	gatewayTtsProvider: '[data-testid="gateway-tts-provider"]',

	// Voice Wake (Settings, Phase 5)
	voiceWakeTriggers: '[data-testid="voice-wake-triggers"]',
	voiceWakeInput: '[data-testid="voice-wake-input"]',
	voiceWakeSave: '[data-testid="voice-wake-save"]',

	// Diagnostics tab (7th tab)
	diagnosticsTabBtn: ".chat-tab:nth-child(7)",
	diagnosticsTabPanel: '[data-testid="diagnostics-tab"]',
	diagnosticsStatusGrid: ".diagnostics-status-grid",
	diagnosticsStatusItem: ".diagnostics-status-item",
	diagnosticsStatusOk: ".diagnostics-value.status-ok",
	diagnosticsStatusErr: ".diagnostics-value.status-err",
	diagnosticsRefreshBtn: ".diagnostics-refresh-btn",
	diagnosticsLogBtn: ".diagnostics-log-btn",
	diagnosticsLogsContainer: ".diagnostics-logs-container",

	// Agent file management (AgentsTab)
	agentFilesBtn: ".agent-files-btn",
	agentFileItem: ".agent-file-item",
	agentFileTextarea: ".agent-file-textarea",
	agentFileSaveBtn: ".agent-file-save-btn",

	// ModeBar (panel tabs)
	modeBar: ".mode-bar",
	modeBarTab: ".mode-bar-tab",
	modeBarTabActive: ".mode-bar-tab--active",
	modeBarTabWrapper: ".mode-bar-tab-wrapper",
	modeBarTabRemove: ".mode-bar-tab-remove",
	modeBarAdd: ".mode-bar-add",

	// SampleNotePanel
	sampleNotePanel: ".sample-note-panel",
	sampleNoteEditor: ".sample-note-panel__editor",

	// Session actions (AgentsTab)
	sessionCompactBtn: ".session-action-btn.compact",
	sessionDeleteBtn: ".session-action-btn.delete",

	// Device pairing (SettingsTab)
	deviceNodeCard: ".device-node-card",
	deviceNodesList: ".device-nodes-list",
	devicePairRequests: ".device-pair-requests",
	devicePairApprove: ".device-pair-approve",
	devicePairReject: ".device-pair-reject",

	// Queue badge
	queueBadge: ".queue-badge",

	// Theme
	themeSwatch: ".theme-swatch",
	themeSwatchActive: ".theme-swatch.active",

	// VRM/Avatar
	vrmCard: ".vrm-card",
	vrmCardActive: ".vrm-card.active",
	vrmCardAdd: ".vrm-card.vrm-card-add",

	// Background
	bgCard: ".bg-card",
	bgCardActive: ".bg-card.active",

	// Settings inputs
	speechStyleSelect: '[data-testid="settings-speech-style"]',
	localeSelect: "#locale-select",
	personaInput: "#persona-input",
	modelInput: "#model-input",
	ttsToggle: "#tts-toggle",
	sttToggle: "#stt-toggle",
	googleApiKeyInput: "#google-apikey-input",
	ttsProviderSelect: "#tts-provider-select",
	ttsApiKeyInput: "#tts-api-key",
	ttsVoiceSelect: "#tts-voice-select",
	voicePreviewBtn: ".voice-preview-btn",
	settingsResetBtn: ".settings-reset-btn",

	// Lab
	labInfoBlock: ".lab-info-block",
	labBalanceValue: ".lab-balance-value",

	// Memory/Facts
	factsList: ".facts-list",
	factItem: ".fact-item",
	factDeleteBtn: ".fact-delete-btn",

	// Memory Settings (SettingsTab)
	memoryAdapterLocal: 'input[name="memory-adapter"][value="local"]',
	memoryAdapterQdrant: 'input[name="memory-adapter"][value="qdrant"]',
	memoryEmbeddingNone: 'input[name="memory-embedding"][value="none"]',
	memoryEmbeddingOffline: 'input[name="memory-embedding"][value="offline"]',
	memoryEmbeddingOpenaiCompat: 'input[name="memory-embedding"][value="openai-compat"]',
	memoryEmbeddingNaia: 'input[name="memory-embedding"][value="naia"]',
	memoryOfflineModelMiniLM: 'input[name="memory-offline-model"][value="all-MiniLM-L6-v2"]',
	memoryOfflineModelMpnet: 'input[name="memory-offline-model"][value="all-mpnet-base-v2"]',
	qdrantUrlInput: 'input[placeholder*="6333"]',
	// TODO(#223): SettingsTab에 data-testid="qdrant-api-key" 추가 후 개선 필요
	qdrantApiKeyInput: 'input[type="password"][placeholder="..."]',
	memoryEmbeddingBaseUrl: 'input[placeholder*="localhost:11434"]',
	memoryEmbeddingModel: 'input[placeholder*="text-embedding-ada-002"]',
	memoryBackupPasswordInput: 'input[type="password"][placeholder*="password"], input[type="password"][placeholder*="\ubc44\ubc00\ubc88\ud638"]',
	memoryExportBtn: '.memory-export-btn',
	memoryImportBtn: '.memory-import-btn',
	memorySection: '.memory-settings-section',
	memoryStatsFacts: '.memory-stats-facts',

	// Voice Wake
	voiceWakeTag: ".voice-wake-tag",
	voiceWakeTagRemove: ".voice-wake-tag-remove",

	// History (extended)
	historyList: ".history-list",
	historyItemMain: ".history-item-main",
	historyItemMeta: ".history-item-meta",

	// Skills (extended)
	skillCardHeader: ".skill-card-header",
	skillCardExpanded: ".skill-card.expanded",
	skillCardDetail: ".skill-card-detail",

	// Diagnostics (extended)
	diagnosticsTailingIndicator: ".diagnostics-tailing-indicator",
	diagnosticsLogLine: ".diagnostics-log-line",

	// Channels (extended)
	channelsLoading: ".channels-loading",
	channelsEmpty: ".channels-empty",
	channelName: ".channel-name",

	// Agents (extended)
	agentCardName: ".agent-card-name",
	agentFileEditor: ".agent-file-editor",
	agentFileStatus: ".agent-file-status",
	sessionCardMeta: ".session-card-meta",
} as const;
