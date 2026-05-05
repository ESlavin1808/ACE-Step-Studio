import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, Loader2, Sparkles, Save, RefreshCw, Upload } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { pollinationsStorage } from '../services/pollinations/storage';
import { getPollinationsModels } from '../services/pollinations/client';
import type { PolModelInfo } from '../services/pollinations/types';
import { songsApi } from '../services/api';
import type { Song } from '../types';

/**
 * Manual cover regeneration modal.
 *
 * Minimal UI: model dropdown + prompt textarea + Generate button + preview
 * with history + Save/Try-again. All other Pollinations knobs (width/height,
 * seed mode, enhance/nologo/safe, API key) come from the persisted
 * pollinationsStorage.getConfig() — the user already configured those in the
 * main PollinationsPanel (auto-pipeline). This modal is just a quick way to
 * iterate on a single cover for an already-generated track.
 *
 * On Save, blob is uploaded to /api/songs/:id/regen-cover which writes the
 * file under the same `${userId}/covers/${songId}.{ext}` path that the
 * auto-pipeline uses, so playback / downloads / sidebar all see the new cover
 * without any extra plumbing.
 */
interface Props {
  song: Song;
  token: string;
  onClose: () => void;
  /** Called after successful save with the new cover URL so App.tsx can
   *  update the local songs[] without a full refresh. */
  onCoverSaved: (songId: string, coverUrl: string) => void;
}

interface PreviewItem {
  /** blob: URL for <img src> */
  url: string;
  /** raw blob — used by the save endpoint upload */
  blob: Blob;
  prompt: string;
  model: string;
  /** Pollinations seed used for this generation — surfaced as a small caption
   *  so the user can re-roll knowing what changed. */
  seed: number;
}

const POL_BASE = 'https://gen.pollinations.ai/image';

export const CoverRegenModal: React.FC<Props> = ({ song, token, onClose, onCoverSaved }) => {
  const { t } = useI18n();
  const cfg = pollinationsStorage.getConfig();

  // Prompt prefill — derive a short visual hint from the song's caption / style.
  // The user can override completely; we only seed something useful so that
  // hitting "Generate" right away produces a reasonable image.
  const initialPrompt = useMemo(() => {
    const caption = (song.style || '').trim();
    const bits: string[] = ['square album cover artwork'];
    if (caption) bits.push(caption);
    bits.push('no text, no watermark');
    return bits.join(', ');
  }, [song.style]);

  const [prompt, setPrompt] = useState(initialPrompt);
  const [model, setModel] = useState<string>(cfg.model || '');
  const [models, setModels] = useState<PolModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  // Generation history. Keep latest first; cap at 6 to bound memory (each
  // blob URL pins a 200-600KB Blob until revoked).
  const [history, setHistory] = useState<PreviewItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Mirror history into a ref so the unmount cleanup effect (deps=[]) reads
  // the latest list, not the initial [] frozen at mount time. Without this
  // the cleanup `history.forEach(revoke)` runs against an empty closure-
  // captured array and every blob created during the modal session leaks.
  const historyRef = useRef<PreviewItem[]>([]);
  useEffect(() => { historyRef.current = history; }, [history]);

  // AbortController so we can cancel an in-flight Pollinations call when the
  // modal closes mid-generation; otherwise the bytes still come back and
  // setState fires on an unmounted tree (warning + memory leak).
  const abortRef = useRef<AbortController | null>(null);

  // Hidden <input type=file> for the "Upload from disk" path. We trigger
  // its click programmatically from the styled button so the UI stays clean.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load model list on mount. /image/models is cached for 1h inside the
  // client module so this is essentially free if the user already opened
  // PollinationsPanel earlier in the session.
  useEffect(() => {
    let alive = true;
    setModelsLoading(true);
    getPollinationsModels(cfg.apiKey)
      .then(list => { if (alive) setModels(list); })
      .catch(() => { if (alive) setModels([]); })
      .finally(() => { if (alive) setModelsLoading(false); });
    return () => { alive = false; };
  }, [cfg.apiKey]);

  // Revoke object URLs on unmount to free Blob memory. We read from
  // historyRef so the cleanup sees the latest list (deps=[] would otherwise
  // capture the initial empty array — see the ref-mirror effect above).
  // We do not revoke on every history mutation — the <img> still references
  // the URL while a previous generation is selected.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      historyRef.current.forEach(h => URL.revokeObjectURL(h.url));
    };
  }, []);

  // ESC closes the modal — common modal UX. We don't trap focus or block
  // background scrolling beyond what the backdrop overlay already does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleGenerate = useCallback(async () => {
    setError('');
    if (!prompt.trim()) {
      setError(t('coverRegen.errEmptyPrompt') || 'Prompt is empty');
      return;
    }
    if (!model.trim()) {
      setError(t('coverRegen.errPickModel') || 'Pick a model first');
      return;
    }

    setGenerating(true);

    // Each Generate click uses a fresh random seed — that is what gives the
    // "Try again" feeling. The persisted seedMode='song' is intentionally
    // ignored here: the user is iterating, not reproducing.
    const seed = Math.floor(Math.random() * 0x7fffffff);

    // Build URL — same shape as app/server/src/services/pollinations.ts uses
    // (gen.pollinations.ai/image/{encoded-prompt}?model=…). Keeps behaviour
    // consistent with the auto-pipeline.
    const params = new URLSearchParams();
    params.set('model', model);
    params.set('width', String(cfg.width));
    params.set('height', String(cfg.height));
    params.set('seed', String(seed));
    if (cfg.nologo) params.set('nologo', 'true');
    if (cfg.enhance) params.set('enhance', 'true');
    if (cfg.safe) params.set('safe', 'true');
    const url = `${POL_BASE}/${encodeURIComponent(prompt)}?${params.toString()}`;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const headers: Record<string, string> = { Accept: 'image/jpeg,image/png,image/*' };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('image/')) {
        throw new Error(`Non-image response: ${ct || 'unknown'}`);
      }
      const blob = await res.blob();
      if (blob.size < 256) {
        // Same lower-bound check as the server-side helper; tiny payloads
        // are almost always a placeholder error tile.
        throw new Error('Tiny response — model likely refused the prompt');
      }
      const objectUrl = URL.createObjectURL(blob);

      setHistory(prev => {
        const next = [{ url: objectUrl, blob, prompt, model, seed }, ...prev];
        // Cap at 6 — revoke evicted blobs to free Blob memory.
        const evicted = next.slice(6);
        evicted.forEach(e => URL.revokeObjectURL(e.url));
        return next.slice(0, 6);
      });
      setSelectedIdx(0);
      // Persist the model used as a recent so the dropdown surfaces it next time.
      pollinationsStorage.pushRecentModel(model);
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // benign — user closed/regenerated
      console.warn('[cover-regen] generation failed:', e);
      setError(e?.message || String(e));
    } finally {
      setGenerating(false);
    }
  }, [prompt, model, cfg.apiKey, cfg.width, cfg.height, cfg.nologo, cfg.enhance, cfg.safe, t]);

  // Pick a local file and add it to the history so the existing preview /
  // save flow handles it. We accept image/* here instead of a strict
  // jpeg+png+webp whitelist because browsers' file pickers are inconsistent
  // about MIME — the backend's coverUpload.fileFilter does the strict check
  // and will reject anything else with a 400.
  const handleUploadFile = useCallback((file: File) => {
    setError('');
    if (!file.type.startsWith('image/')) {
      setError(t('coverRegen.errNotImage') || 'File is not an image');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      // Backend cap is 10MB — fail fast in the UI.
      setError(t('coverRegen.errTooLarge') || 'File too large (max 10MB)');
      return;
    }
    const url = URL.createObjectURL(file);
    setHistory(prev => {
      const next = [{
        url,
        blob: file,
        prompt: `[uploaded] ${file.name}`,
        model: 'upload',
        // Synthetic seed for display only — no Pollinations seed exists for uploads.
        seed: 0,
      }, ...prev];
      const evicted = next.slice(6);
      evicted.forEach(e => URL.revokeObjectURL(e.url));
      return next.slice(0, 6);
    });
    setSelectedIdx(0);
  }, [t]);

  const handleSave = useCallback(async () => {
    if (!history[selectedIdx]) return;
    setSaving(true);
    setError('');
    try {
      const item = history[selectedIdx];
      const { coverUrl } = await songsApi.regenCover(song.id, item.blob, token);
      onCoverSaved(song.id, coverUrl);
      onClose();
    } catch (e: any) {
      console.warn('[cover-regen] save failed:', e);
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [history, selectedIdx, song.id, token, onCoverSaved, onClose]);

  const current = history[selectedIdx];

  // Recent + remaining models, dedup. PollinationsPanel does the same thing —
  // we keep the modal lighter and just use a flat <select> for the dropdown,
  // since the modal already has plenty of UI.
  const dropdownModels = useMemo(() => {
    const recent = pollinationsStorage.getRecentModels();
    const seen = new Set<string>();
    const out: PolModelInfo[] = [];
    for (const id of recent) {
      const m = models.find(x => x.id === id);
      if (m && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
    for (const m of models) {
      if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
    return out;
  }, [models]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-zinc-200 dark:border-white/5 flex flex-col max-h-[90vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-white/5">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-pink-500" />
            <h2 className="text-sm font-semibold">
              {t('coverRegen.title') || 'Regenerate cover'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-white/5"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Model dropdown */}
          <div>
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              {t('coverRegen.model') || 'Model'}
            </label>
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              disabled={modelsLoading}
              className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1.5 text-xs"
            >
              {!model && (
                <option value="" disabled>
                  {modelsLoading
                    ? (t('coverRegen.modelsLoading') || 'Loading models…')
                    : (t('coverRegen.modelsPick') || 'Pick a model…')}
                </option>
              )}
              {dropdownModels.map(m => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.description ? ` — ${m.description.slice(0, 60)}` : ''}
                </option>
              ))}
            </select>
            {!cfg.apiKey && (
              <p className="text-[10px] text-zinc-500 mt-1">
                {t('coverRegen.noKeyHint') ||
                  'Anonymous tier — slower, may include watermark. Set API key in the Pollinations panel.'}
              </p>
            )}
          </div>

          {/* Prompt */}
          <div>
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              {t('coverRegen.prompt') || 'Prompt'}
            </label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1.5 text-xs resize-none"
              placeholder={t('coverRegen.promptPlaceholder') || 'Describe the cover image…'}
            />
          </div>

          {/* Generate + Upload buttons. Upload is the secondary action — same
              visual prominence by sharing the row, but neutral background.
              Selecting a file pushes it into history just like a generated
              image, so Save / preview / try-again all work uniformly. */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || saving || !model || !prompt.trim()}
              className="flex-1 px-3 py-2 text-xs font-medium bg-pink-600 hover:bg-pink-700 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded transition-colors flex items-center justify-center gap-2"
            >
              {generating
                ? (<><Loader2 size={12} className="animate-spin" />{t('coverRegen.generating') || 'Generating…'}</>)
                : history.length > 0
                  ? (<><RefreshCw size={12} />{t('coverRegen.tryAgain') || 'Try again'}</>)
                  : (<><Sparkles size={12} />{t('coverRegen.generate') || 'Generate'}</>)
              }
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={generating || saving}
              title={t('coverRegen.uploadTooltip') || 'Upload your own image (JPEG/PNG/WEBP, max 10MB)'}
              className="px-3 py-2 text-xs font-medium bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-700 dark:text-zinc-200 rounded transition-colors flex items-center gap-1.5"
            >
              <Upload size={12} />
              {t('coverRegen.upload') || 'Upload'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                // Reset value so picking the same file twice still fires onChange.
                e.target.value = '';
                if (file) handleUploadFile(file);
              }}
            />
          </div>

          {error && (
            <p className="text-xs text-red-500 px-1">{error}</p>
          )}

          {/* Preview area */}
          {current ? (
            <div className="space-y-2">
              <div className="aspect-square w-full max-w-sm mx-auto bg-zinc-100 dark:bg-black/40 rounded overflow-hidden border border-zinc-200 dark:border-white/5">
                <img
                  src={current.url}
                  alt="Generated cover"
                  className="w-full h-full object-cover"
                />
              </div>
              <p className="text-[10px] text-zinc-500 text-center">
                {current.model} · seed {current.seed}
              </p>

              {/* History thumbs (up to 6) */}
              {history.length > 1 && (
                <div className="grid grid-cols-6 gap-1.5">
                  {history.map((h, i) => (
                    <button
                      key={h.url}
                      type="button"
                      onClick={() => setSelectedIdx(i)}
                      className={`aspect-square rounded overflow-hidden border-2 transition-colors ${i === selectedIdx ? 'border-pink-500' : 'border-transparent hover:border-zinc-300 dark:hover:border-white/10'}`}
                    >
                      <img src={h.url} alt={`Variant ${i + 1}`} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="aspect-square w-full max-w-sm mx-auto rounded border border-dashed border-zinc-300 dark:border-white/10 flex items-center justify-center text-xs text-zinc-500">
              {t('coverRegen.noPreviewYet') || 'Press Generate to start'}
            </div>
          )}
        </div>

        {/* Footer — Save action only enabled when there's something to save */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-white/5">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded border border-zinc-200 dark:border-white/10 hover:bg-zinc-100 dark:hover:bg-white/5 disabled:opacity-50"
          >
            {t('coverRegen.cancel') || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!current || saving || generating}
            className="px-3 py-1.5 text-xs rounded bg-pink-600 hover:bg-pink-700 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white flex items-center gap-1.5 transition-colors"
          >
            {saving
              ? (<><Loader2 size={12} className="animate-spin" />{t('coverRegen.saving') || 'Saving…'}</>)
              : (<><Save size={12} />{t('coverRegen.saveAsCover') || 'Save as cover'}</>)
            }
          </button>
        </div>
      </div>
    </div>
  );
};
