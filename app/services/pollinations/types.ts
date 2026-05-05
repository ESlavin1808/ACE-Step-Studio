// Domain types for the Pollinations.ai cover generation provider.
// API reference: https://gen.pollinations.ai/docs (OpenAPI schema at /docs/open-api/generate-schema)
//
// Endpoint: GET https://image.pollinations.ai/prompt/{URL_ENCODED_PROMPT}
//   query:  model, width, height, seed, nologo, enhance, safe, referrer
//   header: Authorization: Bearer <pk_|sk_...>  (optional — anonymous tier works)
//
// /image/models  → string[]  (current live model ids)
// /v1/models     → string[]  (alias)

/**
 * Persisted client config — lives in localStorage at acestep.pollinations.config.
 *
 * apiKey is OPTIONAL: anonymous tier works (1 req/15s, may include a small
 * watermark). With a token (pk_ or sk_ from auth.pollinations.ai) the user
 * gets the seed tier (1 req/5s, no watermark).
 */
export interface PollinationsConfig {
  apiKey: string;        // '' = anonymous tier
  model: string;         // '' until user picks. Live list comes from /image/models.
  width: number;         // default 1024 — square is recommended for album covers
  height: number;        // default 1024
  seedMode: 'song' | 'random'; // 'song' = derive from songId for reproducibility on retake
  enhance: boolean;      // expand short prompts via Pollinations LLM (legacy param, kept for forward compat)
  nologo: boolean;       // strip watermark (legacy param, only effective with auth)
  safe: boolean;         // SFW filter — default true; false requires auth + token tier
}

export type PolErrorCode =
  | 'KEY_INVALID'
  | 'RATE_LIMITED'
  | 'MODEL_UNAVAILABLE'
  | 'PROMPT_REJECTED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UNKNOWN';

export class PollinationsError extends Error {
  constructor(
    public readonly code: PolErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PollinationsError';
  }
}

/** Returned by the /image/models endpoint. May come back as plain string array
 *  (current behavior — `["sana"]` on free tier) or as objects with id/description.
 *  We normalize to a uniform shape. */
export interface PolModelInfo {
  id: string;
  description?: string;
}

/** Raw bytes + content type — the unit of work for cover generation.
 *  Used by the server-side service that calls /prompt/{...} and feeds the
 *  buffer into both ID3 tag embedding and disk persistence. */
export interface PolImageResult {
  buffer: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  // The prompt the model actually saw, after our local enhancement (if any).
  // Useful for logging / debugging — server may persist this for diagnostics.
  effectivePrompt: string;
  // The model that returned the image (may differ from cfg.model — Pollinations
  // silently routes between models on its free tier, see EXIF metadata).
  resolvedModel?: string;
}

/** Input shape for buildCoverPrompt — narrow subset of song meta. */
export interface CoverPromptInput {
  title: string;
  /** ACE-Step caption / style description, e.g. "synthwave, 80s, female vocals" */
  caption: string;
  /** Original user brief (Простой mode topic) — '' if not present. */
  topic: string;
  /** ISO-639-1 language code of the song lyrics. Image prompt stays in English
   *  regardless because diffusion models are predominantly English-trained. */
  language: string;
  /** True for instrumentals — adds a hint about no vocalist persona. */
  instrumental: boolean;
}
