export const WEB_ADK_PATH = "opfs://naia-adk";
export const WEB_ADK_OPFS_DIR = "naia-adk";

export function webAdkOpfsPath(relative: string): string {
	if (relative === WEB_ADK_PATH) {
		return WEB_ADK_OPFS_DIR;
	}
	if (relative.startsWith(`${WEB_ADK_PATH}/`)) {
		const sub = relative.slice(WEB_ADK_PATH.length + 1);
		return sub ? `${WEB_ADK_OPFS_DIR}/${sub}` : WEB_ADK_OPFS_DIR;
	}
	if (
		relative === WEB_ADK_OPFS_DIR ||
		relative.startsWith(`${WEB_ADK_OPFS_DIR}/`)
	) {
		return relative;
	}
	const clean = relative.replace(/^\/+/, "");
	return clean ? `${WEB_ADK_OPFS_DIR}/${clean}` : WEB_ADK_OPFS_DIR;
}
