import { OpenRouterClient } from './openrouterClient';
import { llmStorage } from './storage';
import { buildGenerate, buildFormat, type ChatMessage } from './prompts';
import { extractPartial } from './partialJson';
import {
  OpenRouterError,
  type SongDraft,
  type SongDraftInput,
  type FormatInput,
  type GenEvent,
} from './types';

// OpenAI strict json_schema mode (and providers like Azure-routed Anthropic
// behind OpenRouter) disallow validators beyond the structural set:
// type / properties / required / additionalProperties / enum / items / $ref.
// Numeric min/max and array minItems/maxItems trigger
// `output_config.format.schema: ... not supported`. The prompt enforces
// the value ranges (BPM 40-220, durationSec 15-600, tags 3-6) instead.
const SCHEMA = {
  name: 'SongDraft',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'caption', 'lyrics', 'tags', 'bpm', 'keyScale', 'timeSignature', 'durationSec'],
    properties: {
      title: { type: 'string' },
      caption: { type: 'string' },
      lyrics: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      bpm: { type: 'integer' },
      keyScale: { type: 'string' },
      timeSignature: { type: 'string' },
      durationSec: { type: 'integer' },
    },
  },
} as const;

const REQUIRED_FIELDS = SCHEMA.schema.required;

const SANITY_CHECK_THRESHOLD = 200;

export interface RunOpts {
  signal: AbortSignal;
  onEvent: (e: GenEvent) => void;
}

export class OpenRouterProvider {
  generate(input: SongDraftInput, opts: RunOpts): Promise<SongDraft> {
    const cfg = llmStorage.getOpenRouter();
    const messages = buildGenerate(input, cfg.systemPromptGenerate);
    return this.runStreamed(messages, opts, 0, { thinking: !!input.thinking });
  }

  format(input: FormatInput, opts: RunOpts): Promise<SongDraft> {
    const cfg = llmStorage.getOpenRouter();
    const messages = buildFormat(input, cfg.systemPromptFormat);
    return this.runStreamed(messages, opts, 0, { thinking: !!input.thinking });
  }

  private async runStreamed(
    messages: ChatMessage[],
    opts: RunOpts,
    attempt: number = 0,
    extra: { thinking: boolean } = { thinking: false },
  ): Promise<SongDraft> {
    const cfg = llmStorage.getOpenRouter();
    if (!cfg.apiKey) {
      throw new OpenRouterError('KEY_MISSING', 'OpenRouter API key not set');
    }
    if (!cfg.model) {
      throw new OpenRouterError('MODEL_UNAVAILABLE', 'OpenRouter model not selected — pick one from the list');
    }
    const client = new OpenRouterClient(cfg.apiKey);

    // Adaptive request body: only forward parameters the chosen model declares
    // support for in its OpenRouter `supported_parameters` field. Some providers
    // (e.g. Anthropic via Azure) hard-reject unknown params; others silently
    // ignore them. Looking up the live capability list per model avoids
    // surprises and lets us support any model on OpenRouter without manual
    // knowledge of its constraints.
    let supported: Set<string>;
    try {
      const models = await client.listModels();
      const meta = models.find((m) => m && m.id === cfg.model);
      const list = Array.isArray(meta?.supported_parameters) ? meta.supported_parameters : [];
      supported = new Set<string>(list);
    } catch {
      // If model metadata can't be fetched, fall back to the broadly-supported
      // baseline (OpenAI-compatible core).
      supported = new Set<string>(['temperature', 'top_p', 'max_tokens', 'response_format', 'stream']);
    }

    const reqBody: Record<string, unknown> = {
      model: cfg.model,
      messages,
      stream: true,
    };
    const setIf = (param: string, value: unknown): void => {
      if (supported.has(param)) reqBody[param] = value;
    };

    setIf('temperature', cfg.temperature);
    setIf('top_p', cfg.topP);
    setIf('frequency_penalty', cfg.frequencyPenalty);
    setIf('presence_penalty', cfg.presencePenalty);
    setIf('repetition_penalty', cfg.repetitionPenalty);
    setIf('max_tokens', cfg.maxTokens);
    if (cfg.topK > 0) setIf('top_k', cfg.topK);
    if (cfg.minP > 0) setIf('min_p', cfg.minP);
    if (cfg.seed !== null) setIf('seed', cfg.seed);
    // Reasoning hint (honored by Claude extended-thinking, GPT-5, DeepSeek-R1)
    if (extra.thinking) setIf('reasoning', { effort: 'medium' });

    // Pick the strongest JSON shape this model supports.
    // attempt=0 → try the strongest available; attempt>=1 → step down.
    const hasStructured = supported.has('structured_outputs');
    const hasResponseFormat = supported.has('response_format');
    if (attempt === 0 && hasStructured) {
      reqBody.response_format = { type: 'json_schema', json_schema: SCHEMA };
    } else if (hasResponseFormat) {
      reqBody.response_format = { type: 'json_object' };
    }
    // else: no response_format — rely on the system prompt's explicit JSON
    // contract and our tolerant code-fence-aware parser.

    let res: Response;
    try {
      res = await client.chatCompletion(reqBody as any, opts.signal);
    } catch (e) {
      if (e instanceof OpenRouterError && e.code === 'SCHEMA_UNSUPPORTED' && attempt === 0) {
        const fallbackMessages: ChatMessage[] = [
          ...messages,
          {
            role: 'user',
            content: `Match this exact JSON shape:\n${JSON.stringify(SCHEMA.schema)}`,
          },
        ];
        return this.runStreamed(fallbackMessages, opts, 1, extra);
      }
      throw e;
    }

    let firstChunkSeen = false;
    let raw = '';
    let usageEmitted = false;

    // Strip markdown code fences (```json ... ``` / ``` ... ```) that some
    // models add even when asked for JSON only.
    const stripCodeFence = (s: string): string => {
      const t = s.trimStart();
      if (!t.startsWith('```')) return s;
      const m = t.match(/^```(?:json)?\s*\n?/i);
      if (!m) return s;
      let inner = t.slice(m[0].length);
      const closeIdx = inner.lastIndexOf('```');
      if (closeIdx >= 0) inner = inner.slice(0, closeIdx);
      return inner.trim();
    };

    for await (const sseChunk of client.streamSse(res)) {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        opts.onEvent({ type: 'firstChunk' });
      }

      let parsed: any;
      try {
        parsed = JSON.parse(sseChunk);
      } catch {
        continue;
      }

      const delta: string = parsed?.choices?.[0]?.delta?.content || '';
      if (delta) raw += delta;

      if (parsed?.usage && !usageEmitted) {
        usageEmitted = true;
        const u = parsed.usage;
        opts.onEvent({
          type: 'usage',
          promptTokens: u.prompt_tokens || 0,
          completionTokens: u.completion_tokens || 0,
          costUsd: typeof u.cost === 'number' ? u.cost : null,
        });
      }

      // Compute "view" — raw with leading code fence stripped — so the sanity
      // check + partial parser see clean JSON even when the model wraps the
      // payload in ```json ... ```.
      const view = stripCodeFence(raw);

      // Mid-stream sanity check (against stripped view)
      if (view.length >= SANITY_CHECK_THRESHOLD && !view.trimStart().startsWith('{')) {
        if (attempt === 0) {
          const fallbackMessages: ChatMessage[] = [
            ...messages,
            { role: 'user', content: 'Return JSON only, matching the schema, no prose, no markdown fences.' },
          ];
          return this.runStreamed(fallbackMessages, opts, 1, extra);
        }
        throw new OpenRouterError('SCHEMA_NONCOMPLIANT', 'model returned non-JSON content');
      }

      const partResult = extractPartial(view);
      const ev: GenEvent = {
        type: 'chunk',
        raw,
        partial: partResult.closed,
      };
      if (partResult.openStringField) {
        (ev as any).openStringField = partResult.openStringField;
      }
      opts.onEvent(ev);
    }

    opts.onEvent({ type: 'streamDone', raw });

    let draft: SongDraft;
    try {
      draft = JSON.parse(stripCodeFence(raw));
    } catch {
      if (attempt === 0) {
        const fallbackMessages: ChatMessage[] = [
          ...messages,
          { role: 'user', content: 'Return JSON only, no prose, no markdown fences.' },
        ];
        return this.runStreamed(fallbackMessages, opts, 1, extra);
      }
      throw new OpenRouterError('INVALID_JSON', 'failed to parse model response after retry');
    }

    // Validate required fields
    for (const field of REQUIRED_FIELDS) {
      if (!(field in draft)) {
        if (attempt === 0) {
          const fallbackMessages: ChatMessage[] = [
            ...messages,
            { role: 'user', content: 'Return JSON only, no prose. Include all required fields.' },
          ];
          return this.runStreamed(fallbackMessages, opts, 1, extra);
        }
        throw new OpenRouterError('INVALID_JSON', `missing field: ${field}`);
      }
    }
    return draft;
  }
}
