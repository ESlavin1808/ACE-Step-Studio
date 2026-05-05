/**
 * Cover-generation job tracker — runs Pollinations cover gen in parallel
 * with ACE-Step audio gen. Audio pipeline is NEVER blocked by image gen.
 *
 * State machine per jobId:
 *   idle (not in map)
 *     → kickoff()      ⇒ pending  (Promise inserted)
 *   pending
 *     → resolve         ⇒ ready    (PolImageResult)
 *     → reject/timeout  ⇒ failed   (CoverFailure)
 *
 * The map only holds active jobs; entries are deleted by the consumer
 * (status polling) once it has either persisted the cover or decided to
 * give up. Memory is bounded by the audio-gen queue size.
 */

import { generatePollinationsCover, songIdToSeed } from './pollinations.js';
import type { PollinationsCoverConfig } from './id3-tagger.js';

/**
 * 16 art-style modifiers picked deterministically from the seed. Without
 * this, identical prompts (same caption, same instrumental flag) produce
 * essentially identical covers regardless of seed because Pollinations'
 * sampler is biased and the dataset overrepresents stock-rock-band-on-stage
 * imagery for "energetic pop rock" prompts.
 */
const STYLE_MODIFIERS = [
  'oil painting on canvas, painterly brush strokes',
  'watercolor illustration, soft washes, paper texture',
  'cinematic photography, anamorphic lens, dramatic chiaroscuro',
  'digital matte painting, vibrant gradient sky',
  'mixed-media collage, torn paper, ink splatters',
  'graphic design poster, bold geometric shapes, flat colors',
  'pencil sketch with charcoal shading, sketchbook texture',
  'retro pop art, halftone dots, saturated comic palette',
  'art deco poster, gold accents, symmetrical ornament',
  'minimalist vector illustration, two-tone palette, lots of negative space',
  'surrealist dreamscape, melting forms, impossible architecture',
  'film noir black-and-white photograph, deep shadows, fog',
  'retro 70s film grain, faded color palette, sun flare',
  'hyperrealistic 3D render, octane, subsurface scattering',
  'cyberpunk neon nightscape, holographic accents, rain reflections',
  'isometric pixel art, limited 16-colour palette',
];

export interface CoverReady {
  state: 'ready';
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
  finishedAt: number;
}
export interface CoverFailed {
  state: 'failed';
  reason: string;
  finishedAt: number;
}
export type CoverResult = CoverReady | CoverFailed;

export interface CoverPending {
  state: 'pending';
  startedAt: number;
  promise: Promise<CoverResult>;
}
export type CoverEntry = CoverPending | CoverResult;

const jobs = new Map<string, CoverEntry>();

/** Reset for tests. */
export function _resetCoverJobs(): void {
  jobs.clear();
}

/** Inspect current state for a jobId without consuming it. */
export function getCoverState(jobId: string): CoverEntry | undefined {
  return jobs.get(jobId);
}

/** Drop the entry once consumer has handled it. */
export function consumeCoverState(jobId: string): CoverEntry | undefined {
  const e = jobs.get(jobId);
  jobs.delete(jobId);
  return e;
}

/**
 * Start cover gen for a jobId. Idempotent — re-calling for the same jobId
 * returns the existing entry.
 *
 * Returns the entry (caller can `await entry.promise` if desired, or just
 * fire-and-forget and check getCoverState later).
 */
export function startCoverGen(
  jobId: string,
  pol: PollinationsCoverConfig,
): CoverEntry {
  const existing = jobs.get(jobId);
  if (existing) return existing;

  const startedAt = Date.now();

  const promise: Promise<CoverResult> = (async () => {
    try {
      // Always derive a per-job seed even when seedMode='random' — we use it
      // for the style-modifier index (we want one cover per job, not a
      // cache hit on the previous song's prompt).
      const seedForVariety = songIdToSeed(jobId);
      const seed = pol.seedMode === 'song' ? seedForVariety : undefined;

      // Pick a style modifier deterministically from the seed. This is the
      // PRIMARY source of visual diversity across songs that share a caption
      // (which is most of them, since the LLM tends to converge on similar
      // phrasing for similar music).
      const styleIdx = seedForVariety % STYLE_MODIFIERS.length;
      const styleHint = STYLE_MODIFIERS[styleIdx];
      const enrichedPrompt = `${pol.prompt}, ${styleHint}`;

      const r = await generatePollinationsCover({
        prompt: enrichedPrompt,
        model: pol.model,
        width: pol.width,
        height: pol.height,
        seed,
        enhance: pol.enhance,
        nologo: pol.nologo,
        safe: pol.safe,
        apiKey: pol.apiKey || undefined,
      });
      if (!r) {
        const result: CoverFailed = {
          state: 'failed',
          reason: 'pollinations returned undefined (timeout/error)',
          finishedAt: Date.now(),
        };
        jobs.set(jobId, result);
        return result;
      }
      const result: CoverReady = {
        state: 'ready',
        buffer: r.buffer,
        mimeType: r.mimeType,
        finishedAt: Date.now(),
      };
      jobs.set(jobId, result);
      return result;
    } catch (e: any) {
      const result: CoverFailed = {
        state: 'failed',
        reason: String(e?.message || e),
        finishedAt: Date.now(),
      };
      jobs.set(jobId, result);
      return result;
    }
  })();

  const pending: CoverPending = { state: 'pending', startedAt, promise };
  jobs.set(jobId, pending);
  return pending;
}

/**
 * Wait for the cover-gen entry to resolve, or return null after `timeoutMs`.
 * Useful when the audio pipeline hits the song-INSERT step and wants to
 * attach the cover synchronously if it's already nearly done — but never
 * waste user time on a cold-path Pollinations call.
 */
export async function awaitCoverWithTimeout(
  jobId: string,
  timeoutMs: number,
): Promise<CoverResult | null> {
  const e = jobs.get(jobId);
  if (!e) return null;
  if (e.state !== 'pending') return e;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const winner = await Promise.race([e.promise, timeout]);
    return winner ?? null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
