// "Needs review" flags: cheap, deterministic checks that tell the human
// reviewer which AI results to double-check. Nothing here is criterion-specific.
import { providerInfo } from './llm.js';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[«»"“”„'’`]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Is the quote (possibly with "…" gaps) present in any of the cited messages? */
export function quoteFound(quote, texts) {
  const parts = String(quote || '')
    .split(/\.\.\.|…/)
    .map(norm)
    .filter((p) => p.length >= 6);
  if (!parts.length) return true; // nothing checkable
  const hay = texts.map(norm);
  return parts.every((p) => hay.some((h) => h.includes(p)));
}

// Genuine uncertainty anywhere; contrast words only when the model CLEARS a
// flag criterion ("no violation, although the operator disclosed…").
const UNSURE = /(^|[^\p{L}])(возможно|может быть|сложно (определить|сказать|оценить)|неясно|не совсем ясно|спорно|possibly|unclear|ambiguous|hard to tell)(?=[^\p{L}]|$)/iu;
const CONTRAST = /(^|[^\p{L}])(хотя|однако|но при этом|although|however|but|дегенмен|бірақ)(?=[^\p{L}]|$)/iu;

/**
 * A split vote is worth a human look only when it is serious: Yes vs No vs N/A,
 * or scale answers more than one step apart. Neighbouring steps (15 vs 10,
 * 7 vs 10) are normal rater noise and are not flagged.
 */
export function seriousSplit(answers, k) {
  const distinct = [...new Set(answers)];
  if (distinct.length < 2) return false;
  if (k?.type === 'scale' && distinct.every((a) => typeof a === 'number')) {
    const steps = [...k.scale.steps.map((s) => s.value)].sort((a, b) => b - a);
    const idx = distinct.map((a) => steps.indexOf(a));
    return Math.max(...idx) - Math.min(...idx) > 1;
  }
  return true;
}

export function computeReviewFlags(rec, conv, checklist) {
  const flags = [];
  const texts = (idx) => idx.map((i) => conv?.messages?.[i]?.text).filter(Boolean);
  for (const c of rec.criteria) {
    if (c.quote && conv && !quoteFound(c.quote, texts(c.evidence.length ? c.evidence : conv.messages.map((m) => m.idx)))) {
      flags.push({ criterion_id: c.id, code: 'quote_not_found', message: 'Цитата не найдена в указанных репликах — возможна неточность модели.' });
    }
    const isFlagCleared = c.answer === 'no' && checklist?.criteria.find((k) => k.id === c.id)?.type === 'flag';
    if (UNSURE.test(c.explanation || '') || (isFlagCleared && CONTRAST.test(c.explanation || ''))) {
      flags.push({ criterion_id: c.id, code: 'hedged', message: 'Модель сомневается в своём выводе — проверьте ответ.' });
    }
  }
  for (const c of rec.criteria) {
    if (c.votes && c.votes.agree < c.votes.total && seriousSplit(c.votes.answers, checklist?.criteria.find((k) => k.id === c.id)))
      flags.push({ criterion_id: c.id, code: 'split_vote', message: `Прогоны модели разошлись (${c.votes.agree}/${c.votes.total} за итоговый ответ) — проверьте.` });
  }
  if (rec.repairs > 0) flags.push({ criterion_id: null, code: 'repaired', message: `Ответ модели исправлялся ${rec.repairs} раз(а) после проверки кодом.` });
  const primary = providerInfo().model;
  if (rec.model && primary && String(rec.model).replace(/^models\//, '') !== primary)
    flags.push({ criterion_id: null, code: 'fallback_model', message: `Оценено резервной моделью ${rec.model} вместо ${primary}.` });
  return flags;
}
