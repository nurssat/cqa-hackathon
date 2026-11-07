// Export in the organisers' format: CQA_Student_Guide_Appendix_Results.pdf,
// "Формат JSON 1.0". One object per file; one record per dialogue.
import { listEvaluations } from './evaluator.js';
import * as cl from './checklists.js';
import { providerInfo } from './llm.js';
import { score } from '../../shared/scoring.js';

export const SCHEMA_VERSION = '1.0';

// value: true = Да, false = Нет, null = N/A, number = scale step before weight.
export function toValue(answer) {
  if (answer === 'yes') return true;
  if (answer === 'no') return false;
  if (answer === 'na') return null;
  return answer;
}

const code = (k) => k.code || k.id;

/** One result record for a stored evaluation (uses the FINAL answers, after appeals). */
export function resultRecord(ev, checklist) {
  const finalById = Object.fromEntries(ev.final_score.criteria.map((c) => [c.id, c.answer]));
  const modelById = Object.fromEntries(ev.criteria.map((c) => [c.id, c]));
  const criteria = checklist.criteria.map((k) => {
    const m = modelById[k.id] || {};
    const answer = finalById[k.id] ?? m.answer;
    const decided = (ev.appeals || []).filter((a) => a.criterion_id === k.id && a.status === 'changed').at(-1);
    let turns = (m.evidence || []).map((i) => i + 1); // the format numbers turns from 1
    if (!turns.length && m.checked_range) turns = rangeTurns(m.checked_range);
    return {
      criterion_id: code(k),
      value: toValue(answer),
      rationale: decided ? `${m.explanation || ''} Пересмотрено по апелляции: ${decided.decision.reason}`.trim() : (m.explanation || ''),
      evidence_turns: [...new Set(turns)].sort((a, b) => a - b),
    };
  });
  const s = score(checklist, finalById);
  return {
    conversation_id: ev.conversation_id,
    status: 'ok',
    criteria,
    score: { final_score: s.total, critical_flag: s.gross_error },
  };
}

function rangeTurns({ from, to }) {
  const out = [];
  for (let i = from; i <= to && out.length < 50; i++) out.push(i + 1);
  return out;
}

export function errorRecord(conversationId, error) {
  return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error: String(error || 'Оценка не получена.') };
}

/**
 * Build the whole file for a group. `conversationIds` = every ID from the API
 * (so nothing is silently dropped); `errors` = {id: message} from the batch.
 */
export function buildResults({ group, checklistId = 'chat-quality', conversationIds, teamName, errors = {} }) {
  const checklist = cl.get(checklistId);
  const evals = Object.fromEntries(
    listEvaluations(group, checklistId)
      .filter((e) => e.checklist.version === checklist.version)
      .map((e) => [e.conversation_id, e]),
  );
  const models = [...new Set(Object.values(evals).map((e) => String(e.model).replace(/^models\//, '')))];
  const results = conversationIds.map((id) =>
    evals[id] ? resultRecord(evals[id], cl.get(evals[id].checklist.id, evals[id].checklist.version)) : errorRecord(id, errors[id] || 'Диалог не был оценён.'),
  );
  return {
    schema_version: SCHEMA_VERSION,
    team_name: teamName || process.env.TEAM_NAME || 'CQA',
    model: { mode: providerInfo().provider === 'openai' && /localhost|127\.0\.0\.1/.test(process.env.OPENAI_BASE_URL || '') ? 'local' : 'external_api', name: (models.length ? models : [providerInfo().model]).join(', ') },
    results,
  };
}

/** Checks from the "Перед push" list. Returns a list of problems (empty = OK). */
export function validateResults(file, { expectedIds, expectedCount, requiredCodes } = {}) {
  const errs = [];
  if (file.schema_version !== SCHEMA_VERSION) errs.push('schema_version должен быть "1.0"');
  if (!file.team_name) errs.push('нет team_name');
  if (!['local', 'external_api', 'hybrid'].includes(file.model?.mode)) errs.push('model.mode: local | external_api | hybrid');
  if (!file.model?.name) errs.push('нет model.name');
  if (!Array.isArray(file.results)) return [...errs, 'нет массива results'];
  const ids = file.results.map((r) => r.conversation_id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errs.push(`повторяются ID: ${[...new Set(dup)].join(', ')}`);
  if (expectedIds) {
    const missing = expectedIds.filter((id) => !ids.includes(id));
    const extra = ids.filter((id) => !expectedIds.includes(id));
    if (missing.length) errs.push(`нет записей для: ${missing.join(', ')}`);
    if (extra.length) errs.push(`лишние ID: ${extra.join(', ')}`);
  }
  if (expectedCount != null && file.results.length !== expectedCount) errs.push(`записей ${file.results.length}, нужно ровно ${expectedCount}`);
  const DOMAIN = {
    contact: [true, false], discovery: [true, false, null], identification: [true, false, null],
    consultation: [0, 5, 10, 15, 20, null], empathy: [true, false], dialogue: [0, 4, 7, 10],
    closure: [true, false, null], critical: [true, false],
  };
  for (const r of file.results) {
    const at = r.conversation_id;
    if (r.status === 'error') {
      if (r.criteria?.length || r.score !== null || !r.error) errs.push(`${at}: для status "error" нужны criteria: [], score: null и error`);
      continue;
    }
    if (r.status !== 'ok') { errs.push(`${at}: status должен быть "ok" или "error"`); continue; }
    const codes = r.criteria.map((c) => c.criterion_id);
    for (const c of requiredCodes || Object.keys(DOMAIN)) {
      const n = codes.filter((x) => x === c).length;
      if (n !== 1) errs.push(`${at}: критерий ${c} встречается ${n} раз (нужно ровно 1)`);
    }
    for (const c of r.criteria) {
      if (DOMAIN[c.criterion_id] && !DOMAIN[c.criterion_id].includes(c.value)) errs.push(`${at}: ${c.criterion_id} = ${JSON.stringify(c.value)} не из допустимых значений`);
      if (!Array.isArray(c.evidence_turns) || c.evidence_turns.some((t) => !Number.isInteger(t) || t < 1)) errs.push(`${at}: ${c.criterion_id}: evidence_turns — целые числа от 1`);
      if (typeof c.rationale !== 'string') errs.push(`${at}: ${c.criterion_id}: нет rationale`);
    }
    const fs = r.score?.final_score;
    if (!(fs === null || (typeof fs === 'number' && fs >= 0 && fs <= 100 && Math.round(fs * 100) === Math.round(fs * 100 + 1e-9)))) errs.push(`${at}: final_score от 0 до 100`);
    const crit = r.criteria.find((c) => c.criterion_id === 'critical');
    if (crit && r.score?.critical_flag !== crit.value) errs.push(`${at}: critical_flag должен совпадать с critical`);
  }
  return errs;
}
