export const usageControlAliases: Record<
	string,
	{ name: string; screen: string; choice?: string }
> = {
	"onboarding-wizard.open-url-1.click": {
		name: "intro.welcome.link",
		screen: "welcome",
		choice: "github",
	},
	"onboarding-wizard.open-url-2.click": {
		name: "intro.welcome.link",
		screen: "welcome",
		choice: "discord",
	},
	"onboarding-wizard.open-url-3.click": {
		name: "intro.welcome.link",
		screen: "welcome",
		choice: "donate",
	},
	"onboarding-wizard.set-speech-style-4.click": {
		name: "intro.speech.select",
		screen: "speechStyle",
		choice: "select",
	},
	"onboarding-wizard.handle-vrm-select-5.click": {
		name: "intro.character.select",
		screen: "character",
		choice: "vrm",
	},
	"onboarding-wizard.handle-nva-select-6.click": {
		name: "intro.character.select",
		screen: "character",
		choice: "nva",
	},
	"onboarding-wizard.handle-bg-select-7.click": {
		name: "intro.background.select",
		screen: "background",
		choice: "select",
	},
	"onboarding-wizard.handle-naia-login-9.click": {
		name: "intro.provider.choose",
		screen: "provider",
		choice: "naia_start",
	},
	"onboarding-wizard.handle-go-to-settings-10.click": {
		name: "intro.provider.choose",
		screen: "provider",
		choice: "manual",
	},
	"onboarding-wizard.go-next-11.click": {
		name: "intro.provider.choose",
		screen: "provider",
		choice: "later",
	},
	"onboarding-wizard.set-tts-enabled-12.click": {
		name: "intro.voice.select",
		screen: "voice",
		choice: "enable",
	},
	"onboarding-wizard.set-tts-enabled-13.click": {
		name: "intro.voice.select",
		screen: "voice",
		choice: "disable",
	},
	"onboarding-wizard.set-web-voice-uri-14.select": {
		name: "intro.voice.select",
		screen: "voice",
		choice: "host",
	},
	"onboarding-wizard.button-15.click": {
		name: "intro.voice.preview",
		screen: "voice",
		choice: "host",
	},
	"onboarding-wizard.toggle-local-voice-16.click": {
		name: "intro.voice.select",
		screen: "voice",
		choice: "local",
	},
	"settings-tab.handle-check-update-115.click": {
		name: "settings.update.check",
		screen: "settings",
	},
	"app-bar.handle-ctx-remove-shortcut-10.click": {
		name: "home.shortcut.click",
		screen: "home",
		choice: "remove",
	},
	"app-bar.set-url-input-dialog-18.click": {
		name: "home.shortcut.click",
		screen: "home",
		choice: "open",
	},
	"app-bar.set-url-input-dialog-20.click": {
		name: "home.shortcut.click",
		screen: "home",
		choice: "open",
	},
	"settings-tab.handle-theme-change-17.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "select",
	},
	"settings-tab.handle-import-asset-19.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "import",
	},
	"settings-tab.handle-delete-asset-20.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "remove",
	},
	"settings-tab.handle-import-asset-27.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "import",
	},
	"settings-tab.handle-delete-asset-28.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "remove",
	},
	"settings-tab.handle-import-asset-30.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "import",
	},
	"settings-tab.handle-delete-asset-31.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "remove",
	},
	"settings-tab.handle-voice-preview-65.click": {
		name: "settings.voice.click",
		screen: "voice",
		choice: "preview",
	},
	"settings-tab.handle-save-70.click": {
		name: "settings.save.click",
		screen: "settings",
	},
	"settings-tab.handle-voice-preview-80.click": {
		name: "settings.voice.click",
		screen: "voice",
		choice: "preview",
	},
	"settings-tab.handle-voice-preview-82.click": {
		name: "settings.voice.click",
		screen: "voice",
		choice: "preview",
	},
	"settings-tab.stop-mic-test-83.click": {
		name: "settings.voice.click",
		screen: "voice",
		choice: "microphone",
	},
	"settings-tab.handle-save-85.click": {
		name: "settings.save.click",
		screen: "settings",
	},
	"settings-tab.handle-save-89.click": {
		name: "settings.save.click",
		screen: "settings",
	},
	"settings-tab.delete-fact-confirm-93.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "remove",
	},
	"settings-tab.handle-save-94.click": {
		name: "settings.save.click",
		screen: "settings",
	},
	"settings-tab.set-reset-clear-history-100.select": {
		name: "settings.option.click",
		screen: "settings",
		choice: "reset",
	},
	"settings-tab.set-show-reset-confirm-102.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "reset",
	},
	"settings-tab.handle-reset-103.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "reset",
	},
	"settings-tab.handle-stt-model-delete-108.click": {
		name: "settings.option.click",
		screen: "settings",
		choice: "remove",
	},
	"app-bar.set-active-app-2.click": {
		name: "home.menu.open",
		screen: "home",
		choice: "home",
	},
	"app-bar.set-active-app-3.click": {
		name: "home.menu.open",
		screen: "home",
		choice: "browser",
	},
	"app-bar.set-active-app-4.click": {
		name: "home.menu.open",
		screen: "home",
		choice: "workspace",
	},
	"app-bar.open-app-store-5.click": {
		name: "home.menu.open",
		screen: "home",
		choice: "app-store",
	},
	"app-bar.set-active-app-26.click": {
		name: "home.menu.open",
		screen: "home",
		choice: "settings",
	},
	"app-bar.set-active-app-6.click": {
		name: "home.shortcut.click",
		screen: "home",
		choice: "open",
	},
	"app-bar.open-icon-editor-8.click": {
		name: "home.shortcut.click",
		screen: "home",
		choice: "edit",
	},
	"app-bar.set-add-url-dialog-21.click": {
		name: "home.shortcut.click",
		screen: "home",
		choice: "add",
	},
	"app-bar.set-edit-mode-22.click": {
		name: "home.shortcut.click",
		screen: "home",
		choice: "edit",
	},
};
