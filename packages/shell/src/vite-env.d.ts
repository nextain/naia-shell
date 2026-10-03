/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_NAIA_DISTRIBUTION?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
