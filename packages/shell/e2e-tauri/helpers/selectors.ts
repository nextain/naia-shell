/** CSS selectors verified against shell/src components. */
export const S = {
	// App
	appRoot: ".app-root",

	// AdkSetupScreen
	adkSetupScreen: ".adk-setup-screen",
	adkSetupOptionCard: ".adk-setup-option-card",
	adkSetupInput: ".adk-setup-input",
	adkSetupConfirmBtn: ".adk-setup-confirm-btn",
	adkSetupHint: ".adk-setup-hint",
	adkSetupError: ".adk-setup-error",
	adkSetupBack: ".adk-setup-back",
	adkSetupPathPreview: ".adk-setup-path-preview",
	adkSetupHeadline: ".adk-setup-headline",
	adkSetupNaiaCard: ".adk-setup-option-card--naia",

	// SettingsTab (8th tab: chat, history, progress, skills, channels, agents, diagnostics, settings)
	settingsTab: ".settings-tab",
	// #541: 설정·스킬·진단은 더 이상 채팅 탭바에 없다 — 앱바의 설정 버튼으로 연다.
	settingsTabBtn: ".app-bar-settings",
	// 위치가 아니라 식별자로 잡는다 — 탭이 하나만 늘어도 위치는 어긋난다.
	chatTab: '[data-chat-tab="chat"]',
	providerSelect: "#provider-select",
	apiKeyInput: "#apikey-input",
	toolsToggle: "#tools-toggle",
	gatewayUrlInput: "#gateway-url-input",
	gatewayTokenInput: "#gateway-token-input",
	settingsSaveBtn: ".settings-save-btn",

	// ChatApp
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
	historyTab: '[data-chat-tab="history"]',
	historyItem: ".history-item",
	historyItemTitle: ".history-item-title",
	historyDeleteBtn: ".history-delete-btn",
	historyEmpty: ".history-tab-empty",
	historyCurrentBadge: ".history-current-badge",

	// Progress tab (3rd tab)
	progressTabBtn: '[data-meta-tab="progress"]',

	// Cost dashboard
	costBadge: ".cost-badge-clickable",
	costDashboard: ".cost-dashboard",
	costTable: ".cost-table",

	// Onboarding wizard
	// 마법사 뿌리. 예전 값 `.onboarding-overlay` 는 **제품에 없는 클래스**였다 —
	// CSS 에만 남아 있고 어느 컴포넌트도 쓰지 않아, 이것을 기다리던 스펙 넷이
	// 삼십 초를 채우고 죽었다(#564 재조사). check-dead-ui-specs 는 클래스
	// 선택자를 풀지 못해 그 드리프트를 보지 못했으므로 표지로 바꾼다.
	onboardingOverlay: '[data-testid="onboarding"]',
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
	// 스킬 화면은 설정 안으로 옮겨졌다(#541 이후 `SettingsTab` 의 skills 탭이
	// `<SkillsTab>` 을 그린다). 옛 메타 탭 표지(skills)를 그리던
	// `NaiaMetaArea` 는 지금 어디에서도 렌더되지 않아, 그 셀렉터는 영영 뜨지 않는다.
	skillsTab: '[data-settings-tab="skills"]',
	skillsTabApp: ".skills-tab",
	skillsSearch: ".skills-search",
	skillsCard: ".skill-card",
	skillsCardName: ".skill-card-name",
	skillsToggle: ".skill-toggle input",
	skillsSectionTitle: ".skills-section-title",
	skillsCount: ".skills-count",
	skillsEnableAllBtn: ".skills-action-btn:first-child",
	skillsDisableAllBtn: ".skills-action-btn:last-child",

	// Agents tab (6th tab)
	// Agents 는 채팅 탭이 아니라 메타 화면의 탭이다. 순서로 집으면 탭 구성이
	// 바뀔 때마다 엉뚱한 것을 누르거나 없는 것을 기다린다.
	agentsTabApp: '[data-testid="agents-tab"]',
	sessionCard: '[data-testid="session-card"]',
	agentsRefreshBtn: ".agents-refresh-btn",

	// Gateway TTS (Settings, Phase 5)
	gatewayTtsProvider: '[data-testid="gateway-tts-provider"]',

	// Voice Wake (Settings, Phase 5)

	// Diagnostics tab (7th tab)
	diagnosticsTabBtn: '[data-meta-tab="diagnostics"]',
	diagnosticsTabApp: '[data-testid="diagnostics-tab"]',
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

	// AppBar (app tabs)
	modeBar: ".app-bar",
	modeBarTab: ".app-bar-tab",
	modeBarTabActive: ".app-bar-tab--active",
	modeBarTabWrapper: ".app-bar-tab-wrapper",
	modeBarTabRemove: ".app-bar-tab-remove",
	modeBarAdd: ".app-bar-add",

	// SampleNoteApp
	sampleNoteApp: ".sample-note-app",
	sampleNoteEditor: ".sample-note-app__editor",

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
	// #541: VRM 선택 UI 는 카드 그리드에서 목록(vrm-list-item)으로 바뀌었다.
	// 설정 안의 목록으로 범위를 좁힌다 — 같은 클래스가 다른 화면에도 쓰인다.
	vrmCard: '[data-testid="settings-vrm-list"] .vrm-list-item',
	vrmCardActive: '[data-testid="settings-vrm-list"] .vrm-list-item--active',
	vrmCardAdd: ".vrm-list-add",

	// Background
	// #541: 배경 선택은 카드가 아니라 select 위젯이다.
	bgSelect: '[data-testid="settings-bg-select"]',

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
	memoryEmbeddingVllm: 'input[name="memory-embedding"][value="vllm"]',
	memoryEmbeddingOllama: 'input[name="memory-embedding"][value="ollama"]',
	memoryEmbeddingNaia: 'input[name="memory-embedding"][value="naia"]',
	memoryLlmNone: 'input[name="memory-llm"][value="none"]',
	memoryLlmVllm: 'input[name="memory-llm"][value="vllm"]',
	memoryLlmOllama: 'input[name="memory-llm"][value="ollama"]',
	memoryLlmNaia: 'input[name="memory-llm"][value="naia"]',
	memoryOfflineModelMiniLM:
		'input[name="memory-offline-model"][value="all-MiniLM-L6-v2"]',
	memoryOfflineModelMpnet:
		'input[name="memory-offline-model"][value="all-mpnet-base-v2"]',
	qdrantUrlInput: 'input[placeholder*="6333"]',
	// TODO(#223): SettingsTab에 data-testid="qdrant-api-key" 추가 후 개선 필요
	qdrantApiKeyInput: 'input[type="password"][placeholder="..."]',
	memoryEmbeddingBaseUrl: 'input[placeholder*="localhost:11434"]',
	memoryEmbeddingModel: 'input[placeholder*="text-embedding-ada-002"]',
	memoryBackupPasswordInput:
		'input[type="password"][placeholder*="password"], input[type="password"][placeholder*="\ubc44\ubc00\ubc88\ud638"]',
	memoryExportBtn: ".memory-export-btn",
	memoryImportBtn: ".memory-import-btn",
	memorySection: ".memory-settings-section",
	memoryStatsFacts: ".memory-stats-facts",

	// Voice Wake

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
