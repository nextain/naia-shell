/** Local chat has a stable default; Ollama's OpenAI API otherwise substitutes 1.0. */
export function createLocalContainerFetch(doFetch: typeof fetch = fetch): typeof fetch {
 return (input, init) => {
  if (typeof init?.body !== "string") return doFetch(input, init);
  const body = JSON.parse(init.body) as Record<string, unknown>;
  if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("Invalid local container request");
  return doFetch(input, { ...init, body: JSON.stringify({ ...body, temperature: body.temperature ?? 0 }) });
 };
}
