import { isValidStoreAppId, normalizeCanonicalWebAppId } from "../app-catalog";

export const WEB_APP_INSTALL_PARAM = "installApp";

export function readWebAppInstallId(params: URLSearchParams): string | null {
	const values = params.getAll(WEB_APP_INSTALL_PARAM);
	if (values.length !== 1) return null;
	const appId = normalizeCanonicalWebAppId(values[0]);
	return isValidStoreAppId(appId) ? appId : null;
}
