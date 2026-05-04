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
      tags: { type: 'array', minItems: 3, maxItems: 6, items: { type: 'string' } },
      bpm: { type: 'integer', minimum: 40, maximum: 220 },
      keyScale: { type: 'string' },
      timeSignature: { type: 'string' },
      durationSec: { type: 'integer', minimum: 15, maximum: 600 },
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
    return this.runStreamed(messages, opts);
  }

  format(input: FormatInput, opts: RunOpts): Promise<SongDraft> {
    const cfg = llmStorage.getOpenRouter();
    const messages = buildFormat(input, cfg.systemPromptFormat);
    return this.runStreamed(messages, opts);
  }

  private async runStreamed(
    messages: ChatMessage[],
    opts: RunOpts,
    attempt: number = 0,
  ): Promise<SongDraft> {
    const cfg = llmStorage.getOpenRouter();
    if (!cfg.apiKey) {
      throw new OpenRouterError('KEY_MISSING', 'OpenRouter API key not set');
    }
    const client = new OpenRouterClient(cfg.apiKey);

    const reqBody: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      top_p: cfg.topP,
      frequency_penalty: cfg.frequencyPenalty,
      presence_penalty: cfg.presencePenalty,
      repetition_penalty: cfg.repetitionPenalty,
      max_tokens: cfg.maxTokens,
      stream: true,
      response_format:
        attempt === 0
          ? { type: 'json_schema', json_schema: SCHEMA }
          : { type: 'json_object' },
    };
    if (cfg.topK > 0) reqBody.top_k = cfg.topK;
    if (cfg.minP > 0) reqBody.min_p = cfg.minP;
    if (cfg.seed !== null) reqBody.seed = cfg.seed;

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
        return this.runStreamed(fallbackMessages, opts, 1);
      }
      throw e;
    }

    let firstChunkSeen = false;
    let raw = '';
    let usageEmitted = false;

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

      // Mid-stream sanity check
      if (raw.length >= SANITY_CHECK_THRESHOLD && !raw.trimStart().startsWith('{')) {
        if (attempt === 0) {
          const fallbackMessages: ChatMessage[] = [
            ...messages,
            { role: 'user', content: 'Return JSON only, matching the schema, no prose.' },
          ];
          return this.runStreamed(fallbackMessages, opts, 1);
        }
        throw new OpenRouterError('SCHEMA_NONCOMPLIANT', 'model returned non-JSON content');
      }

      const partResult = extractPartial(raw);
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
      draft = JSON.parse(raw);
    } catch {
      if (attempt === 0) {
        const fallbackMessages: ChatMessage[] = [
          ...messages,
          { role: 'user', content: 'Return JSON only, no prose.' },
        ];
        return this.runStreamed(fallbackMessages, opts, 1);
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
          return this.runStreamed(fallbackMessages, opts, 1);
        }
        throw new OpenRouterError('INVALID_JSON', `missing field: ${field}`);
      }
    }
    return draft;
  }
}
