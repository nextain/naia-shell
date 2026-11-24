import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { localizeStoreProduct } from "../lib/app-catalog";
import { loadInstalledApps } from "../lib/app-loader";
import { appRegistry } from "../lib/app-registry";
import {
	AppStoreHttpError,
	type StoreProductSummary,
	buildWebStoreUrl,
	getPlatformAppStoreAdapter,
} from "../lib/app-store-adapter";
import { NAIA_WEB_BASE_URL } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { getWebAdkStatus, subscribeWebAdkStatus } from "../lib/web-runtime/web-adk-status";
import { isWebMode } from "../lib/web-runtime/web-assets";
import {
	readWebAppInstallId,
	WEB_APP_INSTALL_PARAM,
} from "../lib/web-runtime/web-app-install-link";
import { openWebLoginPrompt } from "../lib/web-runtime/web-login-prompt";
import { useAppStore } from "../stores/app";

type CatalogState =
	| { status: "loading" | "unavailable" | "failed" }
	| { status: "ready"; item: StoreProductSummary };

const ENGLISH_COPY = {
	title: "Open an app in Naia",
	loading: "Finding the app…",
	checking: "Checking app access…",
	accept: "Install and open",
	cancel: "Cancel",
	shop: "Back to the App Store",
	unavailable: "This app is unavailable in the web shell.",
	notOwned: "This app is not in your library. Get it from the App Store.",
	signIn: "Sign in to check access to this app.",
	failed: "Could not open this app. Try again.",
};

const KOREAN_COPY: typeof ENGLISH_COPY = {
	title: "나이아에서 앱 열기",
	loading: "앱을 찾는 중…",
	checking: "앱 사용 권한을 확인하는 중…",
	accept: "설치하고 열기",
	cancel: "취소",
	shop: "앱스토어로 돌아가기",
	unavailable: "웹판에서 열 수 없는 앱입니다.",
	notOwned: "아직 보유하지 않은 앱입니다. 앱스토어에서 받으세요.",
	signIn: "앱 사용 권한을 확인하려면 로그인하세요.",
	failed: "앱을 열지 못했습니다. 다시 시도하세요.",
};

export function WebAppInstallLink({ ready }: { ready: boolean }) {
	const [dismissedSearch, setDismissedSearch] = useState<string | null>(null);
	const workspace = useSyncExternalStore(subscribeWebAdkStatus, getWebAdkStatus);
	if (
		!ready ||
		workspace.phase !== "ready" ||
		!isWebMode() ||
		isKioskDemo() ||
		typeof window === "undefined"
	) return null;

	const search = window.location.search;
	const params = new URLSearchParams(search);
	if (search === dismissedSearch || !params.has(WEB_APP_INSTALL_PARAM)) return null;

	const close = () => {
		const url = new URL(window.location.href);
		url.searchParams.delete(WEB_APP_INSTALL_PARAM);
		window.history.replaceState(window.history.state, "", url);
		setDismissedSearch(search);
	};

	return (
		<InstallConfirmation
			key={search}
			appId={readWebAppInstallId(params)}
			onClose={close}
		/>
	);
}

function InstallConfirmation({
	appId,
	onClose,
}: {
	appId: string | null;
	onClose: () => void;
}) {
	const [catalog, setCatalog] = useState<CatalogState>({
		status: appId ? "loading" : "unavailable",
	});
	const [attempt, setAttempt] = useState(0);
	const [busy, setBusy] = useState(false);
	const [issue, setIssue] = useState<"signIn" | "notOwned" | "failed" | null>(null);
	const busyRef = useRef(false);
	const dialogRef = useRef<HTMLElement>(null);
	const setActiveApp = useAppStore((state) => state.setActiveApp);
	useAppStore((state) => state.appListVersion);

	useEffect(() => {
		dialogRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!appId) return;
		let active = true;
		const adapter = getPlatformAppStoreAdapter();
		if (adapter.kind !== "web-http") return;
		void adapter.listCatalog().then(
			(entries) => {
				if (!active) return;
				const item = entries.find((entry) => entry.appId === appId);
				setCatalog(item ? { status: "ready", item } : { status: "unavailable" });
			},
			() => {
				if (active) setCatalog({ status: "failed" });
			},
		);
		return () => { active = false; };
	}, [appId, attempt]);

	const locale = getLocale();
	const copy = locale === "ko" ? KOREAN_COPY : ENGLISH_COPY;
	const product = catalog.status === "ready" ? localizeStoreProduct(catalog.item, locale) : null;
	const installed = appId ? Boolean(appRegistry.get(appId)) : false;
	const shopUrl = buildWebStoreUrl(`${NAIA_WEB_BASE_URL.replace(/\/$/u, "")}/${locale}/apps`);

	const confirm = async () => {
		if (!appId || catalog.status !== "ready" || busyRef.current) return;
		const adapter = getPlatformAppStoreAdapter();
		if (adapter.kind !== "web-http") return;
		busyRef.current = true;
		setBusy(true);
		setIssue(null);
		try {
			const entries = await adapter.listCatalog();
			if (!entries.some((entry) => entry.appId === appId)) {
				setCatalog({ status: "unavailable" });
				return;
			}
			if (appRegistry.get(appId)) {
				if (!(await adapter.checkEntitlement(appId, { requireExplicit: true }))) {
					setIssue("notOwned");
					return;
				}
			} else {
				await adapter.installApp(appId, { purchaseIfNeeded: false });
				await loadInstalledApps();
				if (!appRegistry.get(appId)) {
					setIssue("failed");
					return;
				}
			}
			setActiveApp(appId);
			onClose();
		} catch (error) {
			if (error instanceof AppStoreHttpError && error.code === "not_entitled") {
				setIssue("notOwned");
			} else if (
				error instanceof AppStoreHttpError &&
				(error.code === "auth_required" || error.code === "unauthorized")
			) {
				setIssue("signIn");
				openWebLoginPrompt("app-store", { reauthenticate: error.code === "unauthorized" });
			} else {
				setIssue("failed");
			}
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const message = issue
		? copy[issue]
		: catalog.status === "unavailable" || catalog.status === "failed"
			? copy[catalog.status]
			: null;

	return (
		<div className="sync-dialog-overlay" style={{ zIndex: 99980 }}>
			<section
				ref={dialogRef}
				tabIndex={-1}
				className="sync-dialog-card web-app-install-link"
				role="dialog"
				aria-modal="true"
				aria-labelledby="web-app-install-title"
				data-testid="web-app-install-confirm"
				onKeyDown={(event) => {
					if (event.key === "Escape" && !busyRef.current) onClose();
				}}
			>
				<h3 id="web-app-install-title">{copy.title}</h3>
				{product && <p><strong>{product.title}</strong>{product.description && <><br />{product.description}</>}</p>}
				{catalog.status === "loading" && <p role="status">{copy.loading}</p>}
				{message && <p role="alert" data-testid="web-app-install-error">{message}</p>}
				<div className="sync-dialog-actions">
					{message && !busy && (
						<a href={shopUrl} data-testid="web-app-install-shop">{copy.shop}</a>
					)}
					<button
						type="button"
						className="app-install-cancel-btn"
						data-testid="web-app-install-cancel"
						disabled={busy}
						onClick={onClose}
					>
						{copy.cancel}
					</button>
					{catalog.status === "failed" && (
						<button
							type="button"
							className="app-install-confirm-btn"
							data-testid="web-app-install-retry"
							onClick={() => {
								setCatalog({ status: "loading" });
								setAttempt((value) => value + 1);
							}}
						>
							{t("common.retry")}
						</button>
					)}
					{catalog.status === "ready" && issue !== "notOwned" && (
						<button
							type="button"
							className="app-install-confirm-btn"
							data-testid="web-app-install-accept"
							disabled={busy}
							onClick={() => void confirm()}
						>
							{busy ? copy.checking : installed ? t("webAppStore.open") : copy.accept}
						</button>
					)}
				</div>
			</section>
		</div>
	);
}
