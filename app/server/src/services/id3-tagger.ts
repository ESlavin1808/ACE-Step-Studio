import NodeID3 from 'node-id3';

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
 * Fetch a fast cover image (picsum) for embedding into the MP3 ID3 tag.
 *
 * Pollinations cover generation is NOT done here — it runs out-of-band in
 * `cover-jobs.ts` (kicked off by the status-poll endpoint) so audio-gen
 * pipeline is never blocked by image gen. The only purpose of this fetch
 * now is to give the downloaded MP3 file a thumbnail; the in-app UI cover
 * comes from `songs.cover_url` populated by the background attach.
 *
 * The unused `pol` parameter is kept on the signature for backwards
 * compatibility with callers that still pass it; if/when Pollinations
 * gen is fast enough to embed inline, this could fork on `pol.enabled`
 * again. For now it's ignored.
 */
export async function fetchCoverImage(
  songId: string,
  _pol?: PollinationsCoverConfig
): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
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
