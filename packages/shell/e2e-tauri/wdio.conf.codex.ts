import { config as chat } from "./wdio.conf.chat.js";

export const config = {
	...chat,
	specs: ["./specs/90-codex-live-chat.spec.ts"],
};
