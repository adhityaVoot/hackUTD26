// Nemotron client over the OpenAI-compatible chat completions API.
//
// Default endpoint is NVIDIA's hosted API (build.nvidia.com). Point AI_BASE_URL at a NIM
// container inside a bank's own network and nothing else changes: that's the "no data leaves"
// deployment option from the spec. A second provider (AI_FALLBACK_*) is tried when the first
// errors or times out.
//
// The client is synchronous because SpacetimeDB procedures are: ctx.http.fetch blocks.

export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export interface HttpResponseLike {
  status: number;
  text(): string;
}
export interface HttpLike {
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; timeout?: unknown },
  ): HttpResponseLike;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Turns Nemotron's reasoning off. Nemotron 3.x uses chat_template_kwargs.enable_thinking;
   *  the older Llama-based Nemotrons use a "/no_think" system-prompt prefix. The agent loop is
   *  faster without reasoning, and verification catches mistakes either way. */
  noThink: boolean;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatOptions {
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  timeout?: unknown; // TimeDuration inside SpacetimeDB; ignored by test shims
  jsonMode?: boolean;
  /** Blocking sleep (ctx.sleep inside SpacetimeDB). Enables waiting and retrying on HTTP 429/503. */
  sleep?: (ms: number) => void;
}

export interface ChatResult {
  ok: boolean;
  message: ChatMessage | null;
  error: string;
  status: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** True when the endpoint rejected the `tools` parameter, so the caller can switch to the JSON protocol. */
  toolsUnsupported: boolean;
}

/** Removes <think>...</think> reasoning blocks some Nemotron variants emit inline. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

/** Pulls the first JSON object out of model text (handles code fences and leading prose). */
export function extractJson(text: string): unknown {
  const cleaned = stripThinking(text);
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  const candidates = [fence?.[1], cleaned];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    if (start === -1) continue;
    // Walk to the matching close brace, respecting strings.
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export function chat(http: HttpLike, cfg: ModelConfig, messages: ChatMessage[], opts: ChatOptions = {}): ChatResult {
  const msgs = messages.map(m => ({ ...m }));
  const llamaFamily = /llama/i.test(cfg.model);
  if (llamaFamily && cfg.noThink && msgs[0]?.role === 'system' && !String(msgs[0].content).startsWith('/no_think')) {
    msgs[0].content = `/no_think\n${msgs[0].content}`;
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: msgs,
    temperature: opts.temperature ?? 0.2,
    top_p: 0.9,
    // Reasoning tokens count against max_tokens, so leave room when thinking is on.
    max_tokens: cfg.noThink ? opts.maxTokens ?? 1200 : Math.max(opts.maxTokens ?? 1200, 8192),
    stream: false,
  };
  if (!llamaFamily) {
    body.chat_template_kwargs = { enable_thinking: !cfg.noThink };
    if (!cfg.noThink) body.reasoning_budget = 4096;
  }
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const fail = (error: string, status = 0, toolsUnsupported = false): ChatResult => ({
    ok: false,
    message: null,
    error,
    status,
    model: cfg.model,
    promptTokens: 0,
    completionTokens: 0,
    toolsUnsupported,
  });

  let res: HttpResponseLike;
  let text = '';
  // Free-tier endpoints rate-limit bursts (HTTP 429). Wait and retry a few times before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      res = http.fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        timeout: opts.timeout,
      });
    } catch (e) {
      return fail(`network error: ${String(e).slice(0, 200)}`);
    }
    text = res.text();
    if ((res.status === 429 || res.status === 503) && opts.sleep && attempt < RETRY_DELAYS_MS.length) {
      opts.sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    break;
  }
  if (res.status < 200 || res.status >= 300) {
    const toolsUnsupported = res.status === 400 && /tool/i.test(text);
    return fail(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, toolsUnsupported);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('response was not JSON', res.status);
  }
  const msg = json?.choices?.[0]?.message;
  if (!msg) return fail('no choices in response', res.status);
  return {
    ok: true,
    message: {
      role: 'assistant',
      // Some Nemotron builds put the reply in reasoning_content when content is empty.
      content: typeof msg.content === 'string' && msg.content.trim() ? stripThinking(msg.content) : typeof msg.reasoning_content === 'string' && msg.reasoning_content.includes('{') ? stripThinking(msg.reasoning_content) : typeof msg.content === 'string' ? msg.content : null,
      tool_calls: Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined,
    },
    error: '',
    status: res.status,
    model: json.model ?? cfg.model,
    promptTokens: json?.usage?.prompt_tokens ?? 0,
    completionTokens: json?.usage?.completion_tokens ?? 0,
    toolsUnsupported: false,
  };
}
