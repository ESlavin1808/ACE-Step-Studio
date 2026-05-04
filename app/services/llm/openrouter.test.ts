// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterProvider } from './openrouter';
import { OpenRouterClient } from './openrouterClient';
import { llmStorage } from './storage';
import { OpenRouterError, SongDraft } from './types';

function mockSseResponse(events: object[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n`));
      c.enqueue(encoder.encode('data: [DONE]\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const ALL_PARAMS = [
  'temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty',
  'presence_penalty', 'repetition_penalty', 'max_tokens', 'seed',
  'response_format', 'structured_outputs', 'stream', 'reasoning',
];

function mockModelsResponse(modelId: string, supported: string[] = ALL_PARAMS): Response {
  return new Response(
    JSON.stringify({ data: [{ id: modelId, supported_parameters: supported }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * URL-aware fetch mock: returns model meta for /models, the supplied SSE
 * response for /chat/completions. Use for happy paths and any test that doesn't
 * care about the listModels call's specific shape.
 */
function makeFetchMock(sse: Response, opts: { supported?: string[]; modelId?: string } = {}) {
  return vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith('/models')) {
      return Promise.resolve(mockModelsResponse(opts.modelId || 'anthropic/claude-sonnet-4.5', opts.supported || ALL_PARAMS));
    }
    return Promise.resolve(sse);
  });
}

function fullDraft(): SongDraft {
  return {
    title: 'Test',
    caption: 'rock, drums, male vocals',
    lyrics: '[Verse]\nhi',
    tags: ['rock', 'energetic', 'male vocals'],
    bpm: 120,
    keyScale: 'C major',
    timeSignature: '4/4',
    durationSec: 90,
  };
}

describe('OpenRouterProvider', () => {
  let originalFetch: typeof fetch;
  let listModelsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    localStorage.clear();
    llmStorage.setOpenRouter({ apiKey: 'sk-or-test', model: 'anthropic/claude-sonnet-4.5' });
    // Stub listModels so each test only needs to mock the chat-completions
    // fetch path. Returns a single model whose supported_parameters cover
    // every knob the provider knows about.
    // Return meta entries for both the default test model and `'m'` (used in
    // some tests that override storage). Both expose the full parameter set so
    // the adaptive request builder sends every knob.
    listModelsSpy = vi.spyOn(OpenRouterClient.prototype, 'listModels').mockResolvedValue([
      { id: 'anthropic/claude-sonnet-4.5', supported_parameters: ALL_PARAMS },
      { id: 'm', supported_parameters: ALL_PARAMS },
    ]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    listModelsSpy.mockRestore();
  });

  describe('generate (happy path)', () => {
    it('streams chunks, emits events, returns parsed SongDraft', async () => {
      const draft = fullDraft();
      const fullText = JSON.stringify(draft);
      const events: any[] = [];
      const chunks = [
        { choices: [{ delta: { content: fullText.slice(0, 50) } }] },
        { choices: [{ delta: { content: fullText.slice(50) } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 80 } },
      ];
      globalThis.fetch = makeFetchMock(mockSseResponse(chunks));
      const provider = new OpenRouterProvider();
      const result = await provider.generate(
        { topic: 'rock', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: (e) => events.push(e) }
      );
      expect(result).toEqual(draft);
      expect(events.find(e => e.type === 'firstChunk')).toBeTruthy();
      expect(events.filter(e => e.type === 'chunk').length).toBeGreaterThan(0);
      expect(events.find(e => e.type === 'streamDone')).toBeTruthy();
      expect(events.find(e => e.type === 'usage')).toMatchObject({ promptTokens: 12, completionTokens: 80 });
    });

    it('emits usage with costUsd null when not provided', async () => {
      const draft = fullDraft();
      globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse([
        { choices: [{ delta: { content: JSON.stringify(draft) } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 10 } },
      ]));
      const provider = new OpenRouterProvider();
      const events: any[] = [];
      await provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: (e) => events.push(e) }
      );
      const usage = events.find(e => e.type === 'usage');
      expect(usage.costUsd).toBe(null);
    });

    it('emits usage with costUsd from response when provided', async () => {
      const draft = fullDraft();
      globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse([
        { choices: [{ delta: { content: JSON.stringify(draft) } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 10, cost: 0.0123 } },
      ]));
      const provider = new OpenRouterProvider();
      const events: any[] = [];
      await provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: (e) => events.push(e) }
      );
      const usage = events.find(e => e.type === 'usage');
      expect(usage.costUsd).toBe(0.0123);
    });
  });

  describe('format (happy path)', () => {
    it('uses format prompt and returns SongDraft', async () => {
      const draft = fullDraft();
      globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse([
        { choices: [{ delta: { content: JSON.stringify(draft) } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 50 } },
      ]));
      const provider = new OpenRouterProvider();
      const result = await provider.format(
        { caption: 'old', lyrics: '[Verse]\nold', language: 'en', instrumental: false, primary: 'caption' },
        { signal: new AbortController().signal, onEvent: () => {} }
      );
      expect(result).toEqual(draft);
    });
  });

  describe('config missing key', () => {
    it('throws KEY_MISSING when storage has empty apiKey', async () => {
      llmStorage.setOpenRouter({ apiKey: '' });
      const provider = new OpenRouterProvider();
      await expect(provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: () => {} }
      )).rejects.toMatchObject({ code: 'KEY_MISSING' });
    });
  });

  describe('schema-unsupported fallback', () => {
    it('retries with json_object when first call returns 400', async () => {
      const draft = fullDraft();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
        .mockResolvedValueOnce(mockSseResponse([
          { choices: [{ delta: { content: JSON.stringify(draft) } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
        ]));
      globalThis.fetch = fetchMock;
      const provider = new OpenRouterProvider();
      const result = await provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: () => {} }
      );
      expect(result).toEqual(draft);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Second call should use json_object
      const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
      expect(secondBody.response_format).toEqual({ type: 'json_object' });
    });
  });

  describe('JSON parse fallback', () => {
    it('retries on parse failure of full response', async () => {
      const draft = fullDraft();
      const fetchMock = vi.fn()
        // first call: stream finishes but content is truncated/invalid JSON
        .mockResolvedValueOnce(mockSseResponse([
          { choices: [{ delta: { content: 'not valid json at all' } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
        ]))
        // second call: valid
        .mockResolvedValueOnce(mockSseResponse([
          { choices: [{ delta: { content: JSON.stringify(draft) } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
        ]));
      globalThis.fetch = fetchMock;
      const provider = new OpenRouterProvider();
      const result = await provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: () => {} }
      );
      expect(result).toEqual(draft);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws INVALID_JSON when both attempts fail', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse([
        { choices: [{ delta: { content: 'still garbage' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      ]));
      const provider = new OpenRouterProvider();
      await expect(provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: () => {} }
      )).rejects.toMatchObject({ code: 'INVALID_JSON' });
    });
  });

  describe('field validation', () => {
    it('throws INVALID_JSON when required field is missing', async () => {
      const incomplete = { ...fullDraft() } as any;
      delete incomplete.bpm;
      const fetchMock = vi.fn().mockResolvedValue(mockSseResponse([
        { choices: [{ delta: { content: JSON.stringify(incomplete) } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      ]));
      globalThis.fetch = fetchMock;
      const provider = new OpenRouterProvider();
      // First retry will return same broken result (mock returns same), so 2 attempts both fail
      await expect(provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: () => {} }
      )).rejects.toMatchObject({ code: 'INVALID_JSON' });
    });
  });

  describe('abort handling', () => {
    it('AbortSignal abort propagates and stops streaming', async () => {
      const ctrl = new AbortController();
      const draft = fullDraft();
      // Mock fetch to throw an AbortError when signal is aborted
      globalThis.fetch = vi.fn().mockImplementation((url, init) => {
        if (init?.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        return Promise.resolve(mockSseResponse([
          { choices: [{ delta: { content: JSON.stringify(draft) } }] },
        ]));
      });
      ctrl.abort();
      const provider = new OpenRouterProvider();
      await expect(provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: ctrl.signal, onEvent: () => {} }
      )).rejects.toThrow();
    });
  });

  describe('config knobs forwarded', () => {
    it('forwards temperature, top_p, top_k, min_p, freq/presence/repetition penalty, max_tokens, seed', async () => {
      llmStorage.setOpenRouter({
        apiKey: 'k',
        model: 'm',
        temperature: 1.2,
        topP: 0.95,
        topK: 50,
        minP: 0.05,
        frequencyPenalty: 0.5,
        presencePenalty: 0.3,
        repetitionPenalty: 1.1,
        maxTokens: 1500,
        seed: 42,
      });
      const draft = fullDraft();
      const fetchMock = vi.fn().mockResolvedValue(mockSseResponse([
        { choices: [{ delta: { content: JSON.stringify(draft) } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      ]));
      globalThis.fetch = fetchMock;
      const provider = new OpenRouterProvider();
      await provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: () => {} }
      );
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.temperature).toBe(1.2);
      expect(body.top_p).toBe(0.95);
      expect(body.top_k).toBe(50);
      expect(body.min_p).toBe(0.05);
      expect(body.frequency_penalty).toBe(0.5);
      expect(body.presence_penalty).toBe(0.3);
      expect(body.repetition_penalty).toBe(1.1);
      expect(body.max_tokens).toBe(1500);
      expect(body.seed).toBe(42);
      expect(body.stream).toBe(true);
      expect(body.response_format).toBeDefined();
      expect(body.response_format.type).toBe('json_schema');
    });

    it('omits seed when null', async () => {
      llmStorage.setOpenRouter({ apiKey: 'k', model: 'm', seed: null });
      const draft = fullDraft();
      const fetchMock = vi.fn().mockResolvedValue(mockSseResponse([
        { choices: [{ delta: { content: JSON.stringify(draft) } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      ]));
      globalThis.fetch = fetchMock;
      const provider = new OpenRouterProvider();
      await provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: () => {} }
      );
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.seed).toBeUndefined();
    });
  });

  describe('partial events during stream', () => {
    it('emits chunk events with progressive partial fields', async () => {
      const draft = fullDraft();
      const fullText = JSON.stringify(draft);
      // split into 4 chunks
      const sliceSize = Math.ceil(fullText.length / 4);
      const sseEvents = [];
      for (let i = 0; i < fullText.length; i += sliceSize) {
        sseEvents.push({ choices: [{ delta: { content: fullText.slice(i, i + sliceSize) } }] });
      }
      sseEvents.push({ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
      globalThis.fetch = makeFetchMock(mockSseResponse(sseEvents));
      const events: any[] = [];
      const provider = new OpenRouterProvider();
      await provider.generate(
        { topic: 'x', primary: 'lyrics', language: 'en', instrumental: false },
        { signal: new AbortController().signal, onEvent: (e) => events.push(e) }
      );
      const chunkEvents = events.filter(e => e.type === 'chunk');
      expect(chunkEvents.length).toBeGreaterThan(0);
      // last chunk should have all fields
      const lastChunk = chunkEvents[chunkEvents.length - 1];
      expect(lastChunk.partial.title).toBe(draft.title);
    });
  });
});
