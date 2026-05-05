import NodeID3 from 'node-id3';
import { generatePollinationsCover, songIdToSeed } from './pollinations.js';

/**
 * Subset of PollinationsConfig that the cover fetcher needs. Sent from the
 * client in the audio-gen payload — we don't read localStorage server-side.
 */
export interface PollinationsCoverConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
  width: number;
  height: number;
  seedMode: 'song' | 'random';
  enhance: boolean;
  nologo: boolean;
  safe: boolean;
  /** Pre-built English cover prompt from buildCoverPrompt(). */
  prompt: string;
}

interface TagOptions {
  title: string;
  artist: string;
  genre?: string;
  year?: number;
  coverBuffer?: Buffer;
  coverMimeType?: string;
  lyrics?: string;
  bpm?: number;
}

/**
 * Write ID3v2 tags to an MP3 buffer. Returns tagged buffer.
 * For non-MP3 files, returns the original buffer unchanged.
 */
export function tagMp3Buffer(buffer: Buffer, options: TagOptions): Buffer {
  const tags: NodeID3.Tags = {
    title: options.title,
    artist: options.artist,
    album: 'ACE-Step Studio',
    performerInfo: options.artist,
    year: String(options.year || new Date().getFullYear()),
    encodedBy: 'ACE-Step Studio',
  };

  if (options.genre) {
    tags.genre = options.genre;
  }

  if (options.bpm) {
    tags.bpm = String(options.bpm);
  }

  if (options.lyrics) {
    tags.unsynchronisedLyrics = {
      language: 'eng',
      text: options.lyrics,
    };
  }

  if (options.coverBuffer) {
    tags.image = {
      mime: options.coverMimeType || 'image/jpeg',
      type: { id: 3, name: 'front cover' },
      description: 'Cover',
      imageBuffer: options.coverBuffer,
    };
  }

  const tagged = NodeID3.write(tags, buffer);
  if (!tagged) {
    console.warn('[ID3] Failed to write tags, returning original buffer');
    return buffer;
  }
  return tagged as Buffer;
}

/**
 * Fetch cover image. Tries Pollinations.ai if enabled in config; falls
 * back to picsum.photos on any failure (preserving previous behavior so
 * audio-gen never breaks because of cover-gen issues).
 *
 * Returns the image buffer for ID3 tag embedding plus an optional
 * `polBuffer` field — when present, the caller should also persist this
 * to disk and write the URL into songs.cover_url so the in-app UI can
 * render a real cover instead of the seeded gradient. We only persist
 * Pollinations-generated covers; picsum stays inside the MP3 tag only,
 * matching pre-existing behavior.
 */
export async function fetchCoverImage(
  songId: string,
  pol?: PollinationsCoverConfig
): Promise<{ buffer: Buffer; mimeType: string; fromPollinations?: boolean } | undefined> {
  // Try Pollinations first when the user opted in and supplied a model.
  if (pol && pol.enabled && pol.model && pol.prompt) {
    const seed = pol.seedMode === 'song' ? songIdToSeed(songId) : undefined;
    const result = await generatePollinationsCover({
      prompt: pol.prompt,
      model: pol.model,
      width: pol.width,
      height: pol.height,
      seed,
      enhance: pol.enhance,
      nologo: pol.nologo,
      safe: pol.safe,
      apiKey: pol.apiKey || undefined,
    });
    if (result) {
      return { buffer: result.buffer, mimeType: result.mimeType, fromPollinations: true };
    }
    // Pollinations failed — log already emitted by the service. Fall through.
    console.warn(`[cover] Pollinations failed for song ${songId}, falling back to picsum`);
  }

  // Fallback: picsum.photos seeded gradient (legacy behavior — used purely
  // for the MP3 ID3 tag image so downloaded files have a thumbnail).
  try {
    const url = `https://picsum.photos/seed/${songId}/400/400`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await res.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), mimeType };
  } catch {
    return undefined;
  }
}
