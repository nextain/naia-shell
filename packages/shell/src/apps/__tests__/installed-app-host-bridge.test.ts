// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installInstalledAppHostBridge, INSTALLED_APP_ASK_EVENT, INSTALLED_APP_RESPONSE_EVENT, INSTALLED_APP_SPEAK_EVENT, INSTALLED_APP_CANCEL_EVENT, INSTALLED_APP_SPEECH_RESULT_EVENT } from "../generic-installed/installed-app-host-bridge";
vi.mock("../../lib/logger", () => ({ Logger: { debug: vi.fn() } }));
const locale = vi.hoisted(() => ({ current: "ko" }));
vi.mock("../../lib/i18n", () => ({ getLocale: () => locale.current }));
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); locale.current = "ko"; });
function frame(id: string, permissions: string[]) {
 const el = document.createElement("iframe"); document.body.appendChild(el);
 const target = el.contentWindow!; const post = vi.spyOn(target, "postMessage").mockImplementation(() => {});
 disposers.push(installInstalledAppHostBridge(el, "https://asset.localhost/app", id, permissions), () => el.remove());
 return { target, post };
}
function message(source: Window, data: object, origin = "https://asset.localhost") {
 window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
}
describe("installed app host bridge", () => {
 it("scopes replies by app and request and checks the frame source and origin", () => {
  const a = frame("app.a", ["model.ask"]), b = frame("app.b", ["model.ask"]);
  const ask = vi.fn(); window.addEventListener(INSTALLED_APP_ASK_EVENT, ask); disposers.push(() => window.removeEventListener(INSTALLED_APP_ASK_EVENT, ask));
  message(a.target, {type:"naia-app:ask", appId:"app.b", id:"same", prompt:"bad"});
  message(a.target, {type:"naia-app:ask", appId:"app.a", id:"same", prompt:"bad"}, "https://evil.invalid");
  expect(ask).not.toHaveBeenCalled();
  message(a.target, {type:"naia-app:ask", appId:"app.a", id:"same", prompt:"question"});
  message(b.target, {type:"naia-app:ask", appId:"app.b", id:"same", prompt:"question"});
  expect(ask).toHaveBeenCalledTimes(2);
  expect((ask.mock.calls[0][0] as CustomEvent).detail).toMatchObject({appId:"app.a", requestId:"same", prompt:"question"});
  expect((ask.mock.calls[1][0] as CustomEvent).detail).toMatchObject({appId:"app.b", requestId:"same", prompt:"question"});
  window.dispatchEvent(new CustomEvent(INSTALLED_APP_RESPONSE_EVENT, { detail: {appId:"app.a", requestId:"same", text:"answer"} }));
  expect(a.post).toHaveBeenCalledWith(expect.objectContaining({ type:"naia-app:response", id:"same", text:"answer" }), "https://asset.localhost");
  expect(b.post).not.toHaveBeenCalledWith(expect.objectContaining({ type:"naia-app:response" }), expect.anything());
 });
 it("rejects missing permission and invalid or oversized prompts", () => {
  const a = frame("app.a", []), b = frame("app.b", ["model.ask"]);
  message(a.target, {type:"naia-app:ask", appId:"app.a", id:"1", prompt:"hello"});
  expect(a.post).toHaveBeenCalledWith(expect.objectContaining({error:"permission_denied", text:""}), expect.anything());
  message(b.target, {type:"naia-app:ask", appId:"app.b", id:"2", prompt:"x".repeat(9001)});
  expect(b.post).toHaveBeenCalledWith(expect.objectContaining({error:"invalid_prompt", text:""}), expect.anything());
  message(a.target, {type:"naia-app:speak", appId:"app.a", id:"3", text:"hello"});
  expect(a.post).toHaveBeenCalledWith(expect.objectContaining({type:"naia-app:speech-result", id:"3", status:"failed", error:"permission_denied"}), expect.anything());
  const c = frame("app.c", ["speech"]);
  message(c.target, {type:"naia-app:speak", appId:"app.c", id:"4", text:"x".repeat(2001)});
  expect(c.post).toHaveBeenCalledWith(expect.objectContaining({type:"naia-app:speech-result", id:"4", status:"failed", error:"invalid_text"}), expect.anything());
 });
 it("delivers speech completion, cancellation, and locale updates", () => {
  const a = frame("app.a", ["speech", "locale"]); const speak = vi.fn(), cancel = vi.fn();
  window.addEventListener(INSTALLED_APP_SPEAK_EVENT, speak); window.addEventListener(INSTALLED_APP_CANCEL_EVENT, cancel);
  disposers.push(() => {window.removeEventListener(INSTALLED_APP_SPEAK_EVENT, speak); window.removeEventListener(INSTALLED_APP_CANCEL_EVENT, cancel);});
  expect(a.post).toHaveBeenCalledWith({type:"naia-app:locale", locale:"ko"}, expect.anything());
  locale.current = "en"; window.dispatchEvent(new Event("naia:locale-change"));
  expect(a.post).toHaveBeenLastCalledWith({type:"naia-app:locale", locale:"en"}, expect.anything());
  message(a.target, {type:"naia-app:speak", appId:"app.a", id:"1", text:"hello"}); expect(speak).toHaveBeenCalledOnce(); expect((speak.mock.calls[0][0] as CustomEvent).detail).toMatchObject({appId:"app.a", requestId:"1", text:"hello"});
  message(a.target, {type:"naia-app:speak-cancel", appId:"app.a", id:"1"}); expect(cancel).toHaveBeenCalledOnce();
  window.dispatchEvent(new CustomEvent(INSTALLED_APP_SPEECH_RESULT_EVENT, {detail: { appId:"app.a", requestId:"1", status:"cancelled" }}));
  expect(a.post).toHaveBeenCalledWith(expect.objectContaining({ type:"naia-app:speech-result", id:"1", status:"cancelled" }), expect.anything());
 });
 it("rejects duplicate ids while allowing the original ask and speech to finish", () => {
  const a = frame("app.a", ["model.ask", "speech"]);
  const ask = vi.fn(), speak = vi.fn();
  window.addEventListener(INSTALLED_APP_ASK_EVENT, ask); window.addEventListener(INSTALLED_APP_SPEAK_EVENT, speak);
  disposers.push(() => { window.removeEventListener(INSTALLED_APP_ASK_EVENT, ask); window.removeEventListener(INSTALLED_APP_SPEAK_EVENT, speak); });
  const question = {type:"naia-app:ask", appId:"app.a", id:"same", prompt:"question"};
  const speech = {type:"naia-app:speak", appId:"app.a", id:"same", text:"hello"};
  message(a.target, question); message(a.target, question); message(a.target, speech); message(a.target, speech);
  expect(ask).toHaveBeenCalledOnce(); expect(speak).toHaveBeenCalledOnce();
  expect(a.post).toHaveBeenCalledWith({type:"naia-app:response", id:"same", text:"", error:"duplicate_id"}, expect.anything());
  expect(a.post).toHaveBeenCalledWith({type:"naia-app:speech-result", id:"same", status:"failed", error:"duplicate_id"}, expect.anything());
  window.dispatchEvent(new CustomEvent(INSTALLED_APP_RESPONSE_EVENT, { detail: {appId:"app.a", requestId:"same", text:"answer"} }));
  window.dispatchEvent(new CustomEvent(INSTALLED_APP_SPEECH_RESULT_EVENT, { detail: {appId:"app.a", requestId:"same", status:"finished"} }));
  expect(a.post).toHaveBeenCalledWith(expect.objectContaining({type:"naia-app:response", text:"answer"}), expect.anything());
  expect(a.post).toHaveBeenCalledWith(expect.objectContaining({type:"naia-app:speech-result", status:"finished"}), expect.anything());
 });
 it("settles a missing consumer with an empty timeout response", () => {
  vi.useFakeTimers(); const a = frame("app.a", ["model.ask"]);
  message(a.target, {type:"naia-app:ask", appId:"app.a", id:"1", prompt:"hello"}); vi.advanceTimersByTime(120000);
  expect(a.post).toHaveBeenCalledWith(expect.objectContaining({type:"naia-app:response", id:"1", text:"", error:"timeout"}), expect.anything());
 });
});
