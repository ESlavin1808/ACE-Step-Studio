import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Eye, EyeOff, ChevronDown, ChevronRight, RotateCcw, Loader2 } from 'lucide-react';
import { llmStorage, DEFAULT_OR_CONFIG } from '../services/llm/storage';
import { OpenRouterClient } from '../services/llm/openrouterClient';
import { DEFAULT_GENERATE_PROMPT, DEFAULT_FORMAT_PROMPT } from '../services/llm/prompts';
import { EditableSlider } from './EditableSlider';
import { useI18n } from '../context/I18nContext';
import type { OpenRouterConfig } from '../services/llm/types';

export const LmProviderPanel: React.FC = () => {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<OpenRouterConfig>(() => llmStorage.getOpenRouter());
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testError, setTestError] = useState<string>('');
  const [models, setModels] = useState<any[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showSysPromptGen, setShowSysPromptGen] = useState(false);
  const [showSysPromptFmt, setShowSysPromptFmt] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Persist on cfg change
  useEffect(() => { llmStorage.setOpenRouter(cfg); }, [cfg]);

  // Load models lazily when key is present
  useEffect(() => {
    if (!cfg.apiKey) { setModels([]); return; }
    setModelsLoading(true);
    new OpenRouterClient(cfg.apiKey)
      .listModels()
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, [cfg.apiKey]);

  // Click-outside to close picker
  useEffect(() => {
    if (!modelPickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
        setModelQuery('');
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [modelPickerOpen]);

  const recent = llmStorage.getRecentModels();
  const filteredModels = useMemo(() => {
    const q = modelQuery.toLowerCase().trim();
    return (q
      ? models.filter(m =>
          (m.id || '').toLowerCase().includes(q) ||
          (m.name || '').toLowerCase().includes(q)
        )
      : models
    ).slice(0, 50);
  }, [models, modelQuery]);

  const recentModels = useMemo(
    () => recent.map(id => models.find(m => m.id === id)).filter((m): m is any => Boolean(m)),
    [recent, models]
  );

  const maskedKey = cfg.apiKey ? '••••••' + cfg.apiKey.slice(-4) : '';

  const onTestKey = async () => {
    if (!cfg.apiKey) return;
    setTestStatus('testing');
    setTestError('');
    try {
      await new OpenRouterClient(cfg.apiKey).testKey(cfg.apiKey, cfg.model || undefined);
      setTestStatus('ok');
    } catch (e: any) {
      setTestStatus('fail');
      setTestError(e?.code || e?.message || 'failed');
    }
  };

  const selectModel = (id: string) => {
    setCfg({ ...cfg, model: id });
    llmStorage.pushRecentModel(id);
    setModelQuery('');
    setModelPickerOpen(false);
  };

  const formatPrice = (s: string | undefined) => {
    if (!s) return '?';
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return '?';
    return `$${(n * 1e6).toFixed(2)}/M`;
  };

  // Effective values for textareas (default text rendered as initial value)
  const valueGen = cfg.systemPromptGenerate || DEFAULT_GENERATE_PROMPT;
  const valueFmt = cfg.systemPromptFormat || DEFAULT_FORMAT_PROMPT;

  return (
    <div className="space-y-3 p-3 bg-zinc-50 dark:bg-black/20 rounded-lg border border-zinc-200 dark:border-white/5">
      {/* API Key */}
      <div>
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {(t as any)('lmProvider.apiKey') || 'OpenRouter API Key'}
        </label>
        <div className="flex gap-1 mt-1">
          <div className="flex-1 relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={cfg.apiKey}
              onChange={e => { setCfg({ ...cfg, apiKey: e.target.value }); setTestStatus('idle'); }}
              placeholder={cfg.apiKey ? maskedKey : 'sk-or-...'}
              className="w-full bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs pr-7"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              aria-label={showKey ? 'Hide' : 'Show'}
            >
              {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
          <button
            type="button"
            onClick={onTestKey}
            disabled={!cfg.apiKey || testStatus === 'testing'}
            className="px-2 py-1 text-xs bg-pink-600 hover:bg-pink-700 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded transition-colors flex items-center gap-1"
          >
            {testStatus === 'testing' && <Loader2 size={10} className="animate-spin" />}
            {(t as any)('lmProvider.testKey') || 'Test'}
          </button>
          {testStatus === 'ok' && <span className="text-green-500 text-xs px-1 self-center">✓</span>}
          {testStatus === 'fail' && (
            <span className="text-red-500 text-xs px-1 self-center" title={testError}>✗</span>
          )}
        </div>
        <p className="text-[10px] text-zinc-500 mt-1">
          Stored in your browser&apos;s localStorage. Get a key at openrouter.ai/keys.
        </p>
      </div>

      {/* Model picker */}
      <div ref={pickerRef}>
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {(t as any)('lmProvider.modelPicker.search') || 'Model'}
        </label>
        <input
          value={modelPickerOpen ? modelQuery : cfg.model}
          onChange={e => { setModelQuery(e.target.value); setModelPickerOpen(true); }}
          onFocus={() => setModelPickerOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Enter' && modelQuery.trim()) {
              e.preventDefault();
              selectModel(modelQuery.trim());
            }
            if (e.key === 'Escape') {
              setModelPickerOpen(false);
              setModelQuery('');
            }
          }}
          placeholder={modelsLoading ? 'Loading…' : 'anthropic/claude-...'}
          className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs"
        />
        {modelPickerOpen && (
          <div className="mt-1 max-h-64 overflow-y-auto border border-zinc-200 dark:border-white/10 rounded bg-white dark:bg-zinc-900">
            {recentModels.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-800">
                  {(t as any)('lmProvider.modelPicker.recentlyUsed') || 'Recently used'}
                </div>
                {recentModels.map(m => (
                  <button
                    key={`recent-${m.id}`}
                    onClick={() => selectModel(m.id)}
                    type="button"
                    className="w-full text-left px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-white/5"
                  >
                    <div className="font-medium">{m.name || m.id}</div>
                    <div className="text-[10px] text-zinc-500">
                      ctx {m.context_length || '?'} · in {formatPrice(m.pricing?.prompt)} · out {formatPrice(m.pricing?.completion)}
                    </div>
                  </button>
                ))}
              </>
            )}
            {filteredModels.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-800">
                  {modelQuery ? 'Search results' : 'All models'}
                </div>
                {filteredModels.map(m => (
                  <button
                    key={m.id}
                    onClick={() => selectModel(m.id)}
                    type="button"
                    className="w-full text-left px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-white/5"
                  >
                    <div className="font-medium">{m.name || m.id}</div>
                    <div className="text-[10px] text-zinc-500">
                      ctx {m.context_length || '?'} · in {formatPrice(m.pricing?.prompt)} · out {formatPrice(m.pricing?.completion)}
                    </div>
                  </button>
                ))}
              </>
            )}
            {filteredModels.length === 0 && recentModels.length === 0 && (
              <div className="px-2 py-1 text-[10px] text-zinc-500">
                {modelsLoading ? 'Loading…' : (cfg.apiKey ? 'No models found' : 'Enter API key to load models')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sliders */}
      <EditableSlider
        label={(t as any)('lmProvider.temperature') || 'Temperature'}
        value={cfg.temperature}
        min={0}
        max={2}
        step={0.05}
        onChange={v => setCfg({ ...cfg, temperature: v })}
        autoLabel=""
      />
      <EditableSlider
        label={(t as any)('lmProvider.topP') || 'Top P'}
        value={cfg.topP}
        min={0}
        max={1}
        step={0.01}
        onChange={v => setCfg({ ...cfg, topP: v })}
        autoLabel=""
      />
      <EditableSlider
        label={(t as any)('lmProvider.topK') || 'Top K'}
        value={cfg.topK}
        min={0}
        max={200}
        step={1}
        onChange={v => setCfg({ ...cfg, topK: v })}
        autoLabel="off"
      />
      <EditableSlider
        label={(t as any)('lmProvider.minP') || 'Min P'}
        value={cfg.minP}
        min={0}
        max={1}
        step={0.01}
        onChange={v => setCfg({ ...cfg, minP: v })}
        autoLabel="off"
      />
      <EditableSlider
        label={(t as any)('lmProvider.frequencyPenalty') || 'Frequency penalty'}
        value={cfg.frequencyPenalty}
        min={-2}
        max={2}
        step={0.05}
        onChange={v => setCfg({ ...cfg, frequencyPenalty: v })}
        autoLabel=""
      />
      <EditableSlider
        label={(t as any)('lmProvider.presencePenalty') || 'Presence penalty'}
        value={cfg.presencePenalty}
        min={-2}
        max={2}
        step={0.05}
        onChange={v => setCfg({ ...cfg, presencePenalty: v })}
        autoLabel=""
      />
      <EditableSlider
        label={(t as any)('lmProvider.repetitionPenalty') || 'Repetition penalty'}
        value={cfg.repetitionPenalty}
        min={0}
        max={2}
        step={0.05}
        onChange={v => setCfg({ ...cfg, repetitionPenalty: v })}
        autoLabel=""
      />

      {/* Max tokens */}
      <div>
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {(t as any)('lmProvider.maxTokens') || 'Max tokens'}
        </label>
        <input
          type="number"
          value={cfg.maxTokens}
          min={1}
          max={32000}
          onChange={e => {
            const raw = e.target.value;
            if (raw === '') {
              setCfg({ ...cfg, maxTokens: 1 });
              return;
            }
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) {
              setCfg({ ...cfg, maxTokens: Math.max(1, Math.min(32000, n)) });
            }
            // else: keep previous value
          }}
          className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs"
        />
      </div>

      {/* Seed */}
      <div>
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {(t as any)('lmProvider.seed') || 'Seed'}
        </label>
        <input
          type="number"
          value={cfg.seed === null ? '' : cfg.seed}
          onChange={e => {
            const raw = e.target.value;
            if (raw === '') {
              setCfg({ ...cfg, seed: null });
            } else {
              const n = parseInt(raw, 10);
              if (Number.isFinite(n)) {
                setCfg({ ...cfg, seed: n });
              }
              // else: keep previous value (don't update)
            }
          }}
          placeholder="random"
          className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs"
        />
      </div>

      {/* System prompt — Generate */}
      <div>
        <button
          type="button"
          onClick={() => setShowSysPromptGen(!showSysPromptGen)}
          className="flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
        >
          {showSysPromptGen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {(t as any)('lmProvider.systemPromptGenerate') || 'System prompt — Generate'}
          {cfg.systemPromptGenerate && <span className="text-[10px] text-pink-500 ml-1">(custom)</span>}
        </button>
        {showSysPromptGen && (
          <div className="mt-1 space-y-1">
            <textarea
              value={valueGen}
              onChange={e => setCfg({ ...cfg, systemPromptGenerate: e.target.value })}
              rows={20}
              className="w-full bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-[11px] font-mono whitespace-pre"
              spellCheck={false}
            />
            <div className="flex justify-between items-center">
              <p className="text-[10px] text-zinc-500">
                {cfg.systemPromptGenerate
                  ? 'Custom prompt — overrides the default.'
                  : 'Showing the default prompt. Edit to override.'}
              </p>
              {cfg.systemPromptGenerate && (
                <button
                  type="button"
                  onClick={() => setCfg({ ...cfg, systemPromptGenerate: '' })}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-pink-500 transition-colors"
                >
                  <RotateCcw size={10} /> Reset to default
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* System prompt — Format */}
      <div>
        <button
          type="button"
          onClick={() => setShowSysPromptFmt(!showSysPromptFmt)}
          className="flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
        >
          {showSysPromptFmt ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {(t as any)('lmProvider.systemPromptFormat') || 'System prompt — Format'}
          {cfg.systemPromptFormat && <span className="text-[10px] text-pink-500 ml-1">(custom)</span>}
        </button>
        {showSysPromptFmt && (
          <div className="mt-1 space-y-1">
            <textarea
              value={valueFmt}
              onChange={e => setCfg({ ...cfg, systemPromptFormat: e.target.value })}
              rows={20}
              className="w-full bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-[11px] font-mono whitespace-pre"
              spellCheck={false}
            />
            <div className="flex justify-between items-center">
              <p className="text-[10px] text-zinc-500">
                {cfg.systemPromptFormat
                  ? 'Custom prompt — overrides the default.'
                  : 'Showing the default prompt. Edit to override.'}
              </p>
              {cfg.systemPromptFormat && (
                <button
                  type="button"
                  onClick={() => setCfg({ ...cfg, systemPromptFormat: '' })}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-pink-500 transition-colors"
                >
                  <RotateCcw size={10} /> Reset to default
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
