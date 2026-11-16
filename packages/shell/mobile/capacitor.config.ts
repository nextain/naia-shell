/**
 * Canonical Capacitor 7 configuration for packaging `naia-shell` Web Mode (`--mode web`)
 * into standalone iOS (App Store) and Android (Google Play) mobile applications.
 *
 * Usage (from `packages/shell/mobile/` after copying `package.template.json` -> `package.json`):
 *   npx cap add ios
 *   npx cap add android
 *   npx cap sync
 */

export interface NaiaCapacitorServerConfig {
	/** Custom hostname mapped inside WebView (`capacitor://naia.mobile` on iOS, `https://naia.mobile` on Android). */
	hostname?: string;
	iosScheme?: "capacitor" | "ionic";
	androidScheme?: "https" | "http";
	/** Optional live-reload URL during local development ONLY (never set in store release builds). */
	url?: string;
	cleartext?: boolean;
	allowNavigation?: string[];
}

export interface NaiaCapacitorConfig {
	appId: string;
	appName: string;
	webDir: string;
	bundledWebRuntime?: boolean;
	backgroundColor?: string;
	server?: NaiaCapacitorServerConfig;
	ios?: {
		contentInset?: "automatic" | "scrollableAxes" | "never" | "always";
		allowsLinkPreview?: boolean;
		scrollEnabled?: boolean;
		limitsNavigationsToAppBoundDomains?: boolean;
		preferredContentMode?: "mobile" | "desktop" | "recommended";
		scheme?: string;
	};
	android?: {
		allowMixedContent?: boolean;
		captureInput?: boolean;
		webContentsDebuggingEnabled?: boolean;
		buildOptions?: {
			keystorePath?: string;
			keystoreAlias?: string;
			releaseType?: "AAB" | "APK";
		};
	};
	plugins?: Record<string, Record<string, unknown>>;
}

const nodeEnv = (
	globalThis as unknown as {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const liveReloadUrl = nodeEnv?.CAPACITOR_LIVE_RELOAD_URL?.trim();

const config: NaiaCapacitorConfig = {
	appId: "land.naia.mobile",
	appName: "Naia",
	webDir: "../dist",
	backgroundColor: "#0b0d14",
	server: {
		hostname: "app.naia.land",
		iosScheme: "capacitor",
		androidScheme: "https",
		...(liveReloadUrl ? { url: liveReloadUrl, cleartext: true } : {}),
		allowNavigation: ["www.naia.land", "gateway.naia.nextain.io"],
	},
	ios: {
		contentInset: "never",
		allowsLinkPreview: false,
		scrollEnabled: false,
		preferredContentMode: "mobile",
		scheme: "naia",
	},
	android: {
		allowMixedContent: false,
		captureInput: true,
		webContentsDebuggingEnabled: nodeEnv?.NODE_ENV !== "production",
		buildOptions: {
			releaseType: "AAB",
		},
	},
	plugins: {
		SplashScreen: {
			launchShowDuration: 1200,
			launchAutoHide: true,
			backgroundColor: "#0b0d14",
			showSpinner: false,
		},
		StatusBar: {
			overlaysWebView: true,
			style: "DARK",
			backgroundColor: "#00000000",
		},
		Keyboard: {
			resize: "none",
			style: "DARK",
			resizeOnFullScreen: true,
		},
		PushNotifications: {
			presentationOptions: ["badge", "sound", "alert"],
		},
	},
};

export default config;
