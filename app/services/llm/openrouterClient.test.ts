import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterClient } from './openrouterClient';
import { OpenRouterError } from './types';

describe('OpenRouterClient', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  describe('headers and key handling', () => {
    it('throws KEY_MISSING when apiKey is empty for chatCompletion', async () => {
      const c = new OpenRouterClient('');
      await expect(c.chatCompletion({ model: 'm', messages: [] }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'KEY_MISSING' });
    });

    it('throws KEY_MISSING when apiKey is empty for listModels', async () => {
      const c = new OpenRouterClient('');
      await expect(c.listModels()).rejects.toMatchObject({ code: 'KEY_MISSING' });
    });

    it('sends Authorization: Bearer <key> + project headers', async () => {
      const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      globalThis.fetch = f;
      const c = new OpenRouterClient('sk-or-test');
      await c.listModels();
      const callHeaders = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(callHeaders['Authorization']).toBe('Bearer sk-or-test');
      expect(callHeaders['HTTP-Referer']).toBe('https://github.com/timoncool/ACE-Step-Studio');
      expect(callHeaders['X-Title']).toBe('ACE-Step Studio');
    });
  });

  describe('error mapping', () => {
    it('maps 401 to KEY_INVALID', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
      const c = new OpenRouterClient('bad');
      await expect(c.chatCompletion({ model: 'm', messages: [] }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'KEY_INVALID' });
    });

    it('maps 402 to INSUFFICIENT_FUNDS', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('insufficient', { status: 402 }));
      const c = new OpenRouterClient('k');
      await expect(c.chatCompletion({ model: 'm', messages: [] }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    });

    it('maps 429 to RATE_LIMITED', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
      const c = new OpenRouterClient('k');
      await expect(c.chatCompletion({ model: 'm', messages: [] }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('maps 404 to MODEL_UNAVAILABLE', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
      const c = new OpenRouterClient('k');
      await expect(c.chatCompletion({ model: 'm', messages: [] }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    });

    it('maps 503 to MODEL_UNAVAILABLE', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
      const c = new OpenRouterClient('k');
      await expect(c.chatCompletion({ model: 'm', messages: [] }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    });

    it('maps 400 to SCHEMA_UNSUPPORTED', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }));
      const c = new OpenRouterClient('k');
      await expect(c.chatCompletion({ model: 'm', messages: [] }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    });

    it('maps 500 to UNKNOWN', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
      const c = new OpenRouterClient('k');
      await expect(c.chatCompletion({ model: 'm', messages: [] }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'UNKNOWN' });
    });
  });

  describe('listModels', () => {
    it('parses and returns data array', async () => {
      const f = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ data: [{ id: 'm1', name: 'Model 1' }, { id: 'm2', name: 'Model 2' }] }),
        { status: 200 }
      ));
      globalThis.fetch = f;
      const c = new OpenRouterClient('k');
      const list = await c.listModels();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('m1');
    });

    it('caches results within 1 hour', async () => {
      const f = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ data: [{ id: 'm1' }] }),
        { status: 200 }
      ));
      globalThis.fetch = f;
      const c = new OpenRouterClient('k');
      await c.listModels();
      await c.listModels();
      await c.listModels();
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('handles missing data field gracefully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const c = new OpenRouterClient('k');
      const list = await c.listModels();
      expect(list).toEqual([]);
    });
  });

  describe('testKey', () => {
    it('returns ok on 200', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [] }), { status: 200 })
      );
      const c = new OpenRouterClient('whatever');
      const r = await c.testKey('sk-or-test');
      expect(r).toEqual({ ok: true });
    });

    it('throws KEY_INVALID on 401', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
      const c = new OpenRouterClient('whatever');
      await expect(c.testKey('bad')).rejects.toMatchObject({ code: 'KEY_INVALID' });
    });

    it('uses provided model', async () => {
      const f = vi.fn().mockResolvedValue(new Response('{"choices":[]}', { status: 200 }));
      globalThis.fetch = f;
      const c = new OpenRouterClient('whatever');
      await c.testKey('k', 'anthropic/claude-sonnet-4.5');
      const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
      expect(body.model).toBe('anthropic/claude-sonnet-4.5');
      expect(body.max_tokens).toBe(1);
    });
  });

  describe('chatCompletion', () => {
    it('returns Response on success', async () => {
      const ok = new Response('{"choices":[]}', { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(ok);
      const c = new OpenRouterClient('k');
      const r = await c.chatCompletion({ model: 'm', messages: [] }, new AbortController().signal);
      expect(r).toBe(ok);
    });

    it('forwards AbortSignal to fetch', async () => {
      const f = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = f;
      const c = new OpenRouterClient('k');
      const ctrl = new AbortController();
      await c.chatCompletion({ model: 'm', messages: [] }, ctrl.signal);
      const init = f.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBe(ctrl.signal);
    });
  });

  describe('streamSse', () => {
    function mockSseResponse(events: string[]): Response {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(c) {
          for (const e of events) c.enqueue(encoder.encode(`data: ${e}\n`));
          c.enqueue(encoder.encode('data: [DONE]\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }

    it('yields each data line', async () => {
      const c = new OpenRouterClient('k');
      const res = mockSseResponse(['{"a":1}', '{"b":2}']);
      const out: string[] = [];
      for await (const ev of c.streamSse(res)) out.push(ev);
      expect(out).toEqual(['{"a":1}', '{"b":2}']);
    });

    it('stops at [DONE] sentinel', async () => {
      const c = new OpenRouterClient('k');
      const enc = new TextEncoder();
      const res = new Response(new ReadableStream({
        start(s) {
          s.enqueue(enc.encode('data: chunk1\n'));
          s.enqueue(enc.encode('data: [DONE]\n'));
          s.enqueue(enc.encode('data: chunk2\n')); // never reached
          s.close();
        },
      }), { status: 200 });
      const out: string[] = [];
      for await (const ev of c.streamSse(res)) out.push(ev);
      expect(out).toEqual(['chunk1']);
    });

    it('throws NETWORK on missing body', async () => {
      const c = new OpenRouterClient('k');
      const res = new Response(null, { status: 200 });
      const it = c.streamSse(res);
      await expect(it.next()).rejects.toMatchObject({ code: 'NETWORK' });
    });
  });
});
