/**
 * The model seam.
 *
 * The loop talks to a `ModelProvider`, never to a vendor directly. `anthropic()`
 * is the real one the demo runs — a single `fetch` to the Messages API, so the
 * demo inherits the library's zero-dependency stance. `scripted()` is for tests
 * only: it lets CI exercise the whole loop (hops, memory, the HITL pause) with
 * no key and no network. The demo itself never uses it — a real agent is the
 * point.
 */

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

/** An Anthropic Messages API message. `content` is a string or content blocks. */
export interface ApiMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Completion {
  /** The raw content blocks, appended verbatim to the next request so thinking
   *  and tool_use blocks are preserved (required across tool turns). */
  raw: unknown;
  /** Concatenated text the model produced this step. */
  text: string;
  /** Tool calls the model requested this step. */
  toolCalls: ToolCall[];
  stopReason: string;
  usage: { input: number; output: number };
}

export interface ModelProvider {
  readonly name: string;
  complete(system: string, messages: ApiMessage[], tools: ToolSpec[]): Promise<Completion>;
}

// --- the real provider -----------------------------------------------------

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type ContentBlock = TextBlock | ToolUseBlock | { type: string;[k: string]: unknown };
interface MessagesResponse {
  content: ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicOptions {
  apiKey: string;
  /** Any model the key can call. Default is cheap on purpose. */
  model?: string;
  maxTokens?: number;
}

/**
 * The live agent. One POST per step; the loop drives the tool cycle. The key is
 * read server-side only and never reaches the browser.
 */
export function anthropic(opts: AnthropicOptions): ModelProvider {
  const model = opts.model && opts.model.trim() ? opts.model.trim() : 'claude-haiku-5-5';
  const maxTokens = opts.maxTokens ?? 1024;
  return {
    name: model,
    async complete(system, messages, tools) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, tools }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 400)}`);
      }
      const data = (await res.json()) as MessagesResponse;
      const text = data.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = data.content
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return {
        raw: data.content,
        text,
        toolCalls,
        stopReason: data.stop_reason,
        usage: { input: data.usage.input_tokens, output: data.usage.output_tokens },
      };
    },
  };
}

// --- the test provider (never used by the demo) ----------------------------

export interface ScriptStep {
  text?: string;
  toolCalls?: ToolCall[];
}

/** Deterministic provider for tests: replays scripted steps, no key, no network. */
export function scripted(steps: ScriptStep[], name = 'scripted'): ModelProvider {
  let i = 0;
  return {
    name,
    complete(): Promise<Completion> {
      const step = steps[i] ?? {};
      i += 1;
      const toolCalls = step.toolCalls ?? [];
      const raw = [
        ...(step.text ? [{ type: 'text', text: step.text }] : []),
        ...toolCalls.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
      ];
      return Promise.resolve({
        raw,
        text: step.text ?? '',
        toolCalls,
        stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
        usage: { input: 0, output: 0 },
      });
    },
  };
}
