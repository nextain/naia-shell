import { MockTtsAdapter } from "../../../adapters/tts/mock-tts-adapter.js";
import { runTtsPortContract } from "./tts-port.contract.js";

// MockTtsAdapter under the shared TtsPort contract.
runTtsPortContract("MockTtsAdapter", () => new MockTtsAdapter());
