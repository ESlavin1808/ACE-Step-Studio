import { OpenRouterError, type ErrorCode } from './types';

const BASE = 'https://openrouter.ai/api/v1';
const PROJECT_HEADERS = {
  'HTTP-Referer': 'https://github.com/timoncool/ACE-Step-Studio',
  'X-Title': 'ACE-Step Studio',
} as const;

const MODELS_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

export interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  max_tokens?: number;
  seed?: number;
  response_format?:
    | { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: unknown } }
    | { type: 'json_object' };
  stream?: boolean;
}

function mapStatus(status: number): ErrorCode {
  if (status === 401) return 'KEY_INVALID';
  if (status === 402) return 'INSUFFICIENT_FUNDS';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 404 || status === 503) return 'MODEL_UNAVAILABLE';
  if (status === 400) return 'SCHEMA_UNSUPPORTED';
  return 'UNKNOWN';
}

export class OpenRouterClient {
  private modelsCache: { fetchedAt: number; data: any[] } | null = null;

  constructor(private apiKey: string) {}

  private headers(): Record<string, string> {
    if (!this.apiKey) {
      throw new OpenRouterError('KEY_MISSING', 'OpenRouter API key not set');
    }
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...PROJECT_HEADERS,
    };
  }

  async listModels(force: boolean = false): Promise<any[]> {
    if (!force && this.modelsCache && Date.now() - this.modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
      return this.modelsCache.data;
    }
    const res = await fetch(`${BASE}/models`, { headers: this.headers() });
    if (!res.ok) {
      throw new OpenRouterError(mapStatus(res.status), `models list failed: ${res.status}`);
    }
    const json = await res.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    this.modelsCache = { fetchedAt: Date.now(), data };
    return data;
  }

  async testKey(apiKey: string, model = 'openrouter/auto'): Promise<{ ok: true }> {
    const tmp = new OpenRouterClient(apiKey);
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: tmp.headers(),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    if (!res.ok) {
      throw new OpenRouterError(mapStatus(res.status), `key test failed: ${res.status}`);
    }
    return { ok: true };
  }

  async chatCompletion(req: ChatRequest, signal: AbortSignal): Promise<Response> {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OpenRouterError(mapStatus(res.status), `chat completion failed: ${res.status}`, text);
    }
    return res;
  }

  async *streamSse(res: Response): AsyncGenerator<string> {
    if (!res.body) {
      throw new OpenRouterError('NETWORK', 'no response body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          if (data.length > 0) yield data;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
