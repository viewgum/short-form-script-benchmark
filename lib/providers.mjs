// One plain call to each vendor's own API: no system prompt and default settings for contestants; judges ask for JSON at low effort.

export const APIS = {
  anthropic: { keyEnv: "ANTHROPIC_API_KEY", url: "https://api.anthropic.com/v1/messages" },
  openai: { keyEnv: "OPENAI_API_KEY", url: "https://api.openai.com/v1/responses" },
  google: { keyEnv: "GEMINI_API_KEY", url: "https://generativelanguage.googleapis.com/v1beta/models" },
};

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const list = (value) => (Array.isArray(value) ? value : []);

/** The request for one call: { url, headers, body, read(json) -> { text, usage: { input, output }, stop } }. */
export function request(model, { prompt, system, maxTokens, judge = false }, env = process.env) {
  const api = APIS[model.api];
  if (!api) throw new Error(`${model.id}: unknown api "${model.api}"`);
  const key = env[api.keyEnv] ?? "";
  if (!key) throw new Error(`${model.id}: set ${api.keyEnv}`);
  if (model.api === "anthropic") {
    return {
      url: api.url,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: {
        model: model.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }],
        ...(system ? { system } : {}),
        ...(judge ? { output_config: { effort: "low" } } : {}),
      },
      read: (json) => ({
        text: list(json.content).filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("") || (json.stop_reason === "refusal" ? "[refusal]" : ""),
        usage: { input: num(json.usage?.input_tokens), output: num(json.usage?.output_tokens) },
        stop: String(json.stop_reason ?? ""),
      }),
    };
  }
  if (model.api === "openai") {
    return {
      url: api.url,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: {
        model: model.model, max_output_tokens: maxTokens, input: prompt,
        ...(system ? { instructions: system } : {}),
        ...(judge ? { reasoning: { effort: "low" }, text: { format: { type: "json_object" } } } : {}),
      },
      read: (json) => ({
        // A typed refusal is an answer too: kept as text so it is scored, never retried.
        text: list(json.output).filter((item) => item.type === "message").flatMap((item) => list(item.content))
          .map((part) => (part.type === "output_text" ? String(part.text ?? "") : part.type === "refusal" ? `[refusal] ${String(part.refusal ?? "")}` : "")).join(""),
        usage: { input: num(json.usage?.input_tokens), output: num(json.usage?.output_tokens) },
        stop: String(json.status ?? ""),
      }),
    };
  }
  return {
    url: `${api.url}/${encodeURIComponent(model.model)}:generateContent`,
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: maxTokens, ...(judge ? { responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } } : {}) },
    },
    read: (json) => {
      const candidate = list(json.candidates)[0] ?? {};
      return {
        text: list(candidate.content?.parts).filter((part) => !part.thought).map((part) => String(part.text ?? "")).join("") || (/SAFETY|BLOCK|PROHIBITED/.test(String(candidate.finishReason ?? json.promptFeedback?.blockReason ?? "")) ? `[blocked: ${candidate.finishReason ?? json.promptFeedback?.blockReason}]` : ""),
        usage: { input: num(json.usageMetadata?.promptTokenCount), output: num(json.usageMetadata?.candidatesTokenCount) + num(json.usageMetadata?.thoughtsTokenCount) },
        stop: String(candidate.finishReason ?? ""),
      };
    },
  };
}

/** An answer with an HTTP error status; `status` says whether the vendor could have billed it. */
export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** A request the vendor refused before any work: nothing was billed, and retrying will not help. */
export const refusedBeforeWork = (error) => error instanceof HttpError && [400, 401, 403, 404].includes(error.status);

/** Sends one call; on an HTTP error, throws with the vendor's status and message (never the key). */
export async function call(model, input, { env = process.env, fetchImpl = fetch, timeoutMs = 600_000 } = {}) {
  const wire = request(model, input, env);
  const started = Date.now();
  const res = await fetchImpl(wire.url, { method: "POST", headers: wire.headers, body: JSON.stringify(wire.body), signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(`${model.id}: HTTP ${res.status} ${String(json?.error?.message ?? "").slice(0, 200)}`, res.status);
  return { ...wire.read(json), ms: Date.now() - started };
}

/** USD for a usage at per-million-token rates. */
export const costUsd = (rates, usage) => (usage.input * rates.input + usage.output * rates.output) / 1e6;

/** The most a call could cost: never more input tokens than characters (plus a margin for the request's framing), plus every output token allowed. */
export const worstCaseUsd = (rates, promptChars, maxTokens) => costUsd(rates, { input: promptChars + 200, output: maxTokens });
