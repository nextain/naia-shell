export const WEB_ADK_REPO = "nextain/naia-adk";
export const WEB_ADK_COMMIT = "13ea427991542965091f2f3211b9325a36dbd522";
export const WEB_ADK_DIRS = ["projects/naia-template-project"] as const;

export interface WebAdkFileSpec {
	path: string;
	size: number;
	sha1: string;
	base64?: string;
}

export interface WebAdkBundle {
	repo: string;
	commit: string;
	files: readonly WebAdkFileSpec[];
	dirs: readonly string[];
}
