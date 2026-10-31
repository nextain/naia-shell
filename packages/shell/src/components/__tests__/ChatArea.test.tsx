// @vitest-environment jsdom
import { describe } from "vitest";
import { setupChatAreaTests } from "./chat-area-fixture";
import { registerChatAreaCases01 } from "./chat-area-cases-01";
import { registerChatAreaCases02 } from "./chat-area-cases-02";
import { registerChatAreaCases03 } from "./chat-area-cases-03";
import { registerChatAreaCases04 } from "./chat-area-cases-04";
import { registerChatAreaCases05 } from "./chat-area-cases-05";
import { registerChatAreaCases06 } from "./chat-area-cases-06";
import { registerChatAreaCases07 } from "./chat-area-cases-07";

describe("ChatArea", () => {
	setupChatAreaTests();
	registerChatAreaCases01();
	registerChatAreaCases02();
	registerChatAreaCases03();
	registerChatAreaCases04();
	registerChatAreaCases05();
	registerChatAreaCases06();
	registerChatAreaCases07();
});
