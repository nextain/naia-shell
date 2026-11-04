import {describe,it,expect,vi} from "vitest";
import {createLocalContainerFetch} from "../../../../web-worker/local-container-fetch";
describe("local container sampling boundary",()=>{
 it("sets default0 while preserving URL, messages, stream, headers and cancellation",async()=>{
  const transport=vi.fn().mockResolvedValue(new Response("ok"));const call=createLocalContainerFetch(transport);const controller=new AbortController();
  const body={model:"gemma2:9b-instruct-q4_K_M",messages:[{role:"user",content:"안녕"}],stream:true,stream_options:{include_usage:true}};
  const init={method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:controller.signal};
  await call("http://127.0.0.1/local-llm/v1/chat/completions",init);
  const [url,forwarded]=transport.mock.calls[0];expect(url).toBe("http://127.0.0.1/local-llm/v1/chat/completions");
  expect(JSON.parse(forwarded.body)).toEqual({...body,temperature:0});expect(forwarded.signal).toBe(controller.signal);expect(forwarded.headers).toBe(init.headers);expect(forwarded.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual(body);controller.abort();expect(forwarded.signal.aborted).toBe(true);
 });
 it("preserves an explicit sampling value and propagates transport failure",async()=>{
  const transport=vi.fn().mockRejectedValue(new Error("offline"));const call=createLocalContainerFetch(transport);
  await expect(call("/local",{body:JSON.stringify({temperature:.4,stream:true})})).rejects.toThrow("offline");expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({temperature:.4,stream:true});
 });
 it("rejects malformed bodies before any transport call",()=>{
  const transport=vi.fn();const call=createLocalContainerFetch(transport);
  expect(()=>call("/local",{body:"[]"})).toThrow();expect(transport).not.toHaveBeenCalled();
 });
});
