import { describe, it, expect } from 'vitest';
import { extractPartial } from './partialJson';

describe('extractPartial', () => {
  it('returns empty closed for empty input', () => {
    expect(extractPartial('')).toEqual({ closed: {} });
  });

  it('returns empty closed for whitespace input', () => {
    expect(extractPartial('   \n  ')).toEqual({ closed: {} });
  });

  it('extracts a closed string field', () => {
    const r = extractPartial('{"title": "Hello", "lyrics": "wo');
    expect(r.closed.title).toBe('Hello');
  });

  it('exposes a currently-open string field with name and unescaped valueSoFar', () => {
    const r = extractPartial('{"title": "Hello", "lyrics": "wo');
    expect(r.openStringField).toEqual({ name: 'lyrics', valueSoFar: 'wo' });
  });

  it('unescapes \\n in open string', () => {
    const r = extractPartial('{"lyrics": "line1\\nline2');
    expect(r.openStringField?.valueSoFar).toBe('line1\nline2');
  });

  it('unescapes \\\" in open string', () => {
    const r = extractPartial('{"lyrics": "say \\"hi\\" t');
    expect(r.openStringField?.valueSoFar).toBe('say "hi" t');
  });

  it('unescapes \\\\ in open string', () => {
    const r = extractPartial('{"lyrics": "back\\\\slash');
    expect(r.openStringField?.valueSoFar).toBe('back\\slash');
  });

  it('unescapes \\u00e9 in open string', () => {
    const r = extractPartial('{"lyrics": "caf\\u00e9 noir');
    expect(r.openStringField?.valueSoFar).toBe('café noir');
  });

  it('withholds lone trailing backslash (half-escape)', () => {
    const r = extractPartial('{"lyrics": "abc\\');
    expect(r.openStringField?.valueSoFar).toBe('abc');
  });

  it('withholds incomplete \\u escape (less than 4 hex digits)', () => {
    const r = extractPartial('{"lyrics": "abc\\u00');
    expect(r.openStringField?.valueSoFar).toBe('abc');
  });

  it('extracts a closed array (tags)', () => {
    const r = extractPartial('{"tags": ["rock", "metal"], "title": "T');
    expect(r.closed.tags).toEqual(['rock', 'metal']);
    expect(r.openStringField?.name).toBe('title');
  });

  it('does not surface a tags array still open', () => {
    const r = extractPartial('{"tags": ["rock", "met');
    expect(r.closed.tags).toBeUndefined();
  });

  it('extracts a closed integer field', () => {
    const r = extractPartial('{"bpm": 174, "title": "T');
    expect(r.closed.bpm).toBe(174);
  });

  it('does not surface an incomplete number', () => {
    const r = extractPartial('{"bpm": 17');
    expect(r.closed.bpm).toBeUndefined();
  });

  it('handles full valid JSON: all closed fields, no openStringField', () => {
    const full = JSON.stringify({
      title: 'T', caption: 'rock, drums', lyrics: '[Verse]\nhi', tags: ['rock'],
      bpm: 120, keyScale: 'C major', timeSignature: '4/4', durationSec: 90,
    });
    const r = extractPartial(full);
    expect(r.closed.title).toBe('T');
    expect(r.closed.caption).toBe('rock, drums');
    expect(r.closed.lyrics).toBe('[Verse]\nhi');
    expect(r.closed.tags).toEqual(['rock']);
    expect(r.closed.bpm).toBe(120);
    expect(r.closed.keyScale).toBe('C major');
    expect(r.closed.timeSignature).toBe('4/4');
    expect(r.closed.durationSec).toBe(90);
    expect(r.openStringField).toBeUndefined();
  });

  it('does not surface fields not in SongDraft', () => {
    const r = extractPartial('{"unknownField": "x", "title": "T", "another": "y');
    expect((r.closed as any).unknownField).toBeUndefined();
    // openStringField could be 'another' — but that's not a SongDraft key, so suppressed
    expect(r.openStringField).toBeUndefined();
  });

  it('returns no openStringField when the same field is also already closed', () => {
    // edge case: weird input where the parser sees a closed `lyrics` and then an open one
    // we trust the parser-extracted closed value, suppress the duplicate open
    const r = extractPartial('{"lyrics": "first"');
    // here lyrics is fully closed; openStringField should NOT also be 'lyrics'
    expect(r.closed.lyrics).toBe('first');
    expect(r.openStringField?.name).not.toBe('lyrics');
  });
});
