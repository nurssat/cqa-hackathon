import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CQA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-r-'));
const cl = await import('../server/lib/checklists.js');
const ev = await import('../server/lib/evaluator.js');
const { buildResults, validateResults, toValue } = await import('../server/lib/results.js');
const { normalizeRecord } = await import('../shared/normalize.js');
cl.seedDefault();
const checklist = cl.get('chat-quality');

const conv = normalizeRecord({ conversation_id: 'r-1', channel: 'agent chat', language: 'RU', transcript: [
  { timestamp: '00:00', speaker: 'client', text: 'Где тариф?' },
  { timestamp: '00:10', speaker: 'operator', text: 'Здравствуйте, я Алина. В «Кабинете».' },
  { timestamp: '00:20', speaker: 'operator', text: 'Хорошего дня!' },
] });
const crit = (id, answer, extra = {}) => ({ id, answer, explanation: `exp ${id}`, evidence: [1], checked_range: null, na_reason: answer === 'na' ? 'r' : null, quote: '', ...extra });
const stub = async () => ({ model: 'gemini-3.5-flash', usage: { input: 1, output: 1 }, text: JSON.stringify({ criteria: [
  crit('01', 'yes'), crit('02', 'na'), crit('03', 'na'), crit('04', '15'),
  crit('05', 'yes'), crit('06', '7'), crit('07', 'no', { evidence: [], checked_range: { from: 1, to: 2 } }), crit('08', 'no'),
] }) });

test('format 1.0: codes, value mapping, 1-based turns, score, error records', async () => {
  await ev.evaluate({ group: 'R', conv, checklist, llm: stub, runs: 1 });
  const file = buildResults({ group: 'R', conversationIds: ['r-1', 'r-missing'], teamName: 'Команда', errors: { 'r-missing': 'Не удалось получить ответ модели.' } });
  assert.equal(file.schema_version, '1.0');
  assert.equal(file.team_name, 'Команда');
  assert.deepEqual(file.model, { mode: 'external_api', name: 'gemini-3.5-flash' });
  const [ok, err] = file.results;
  assert.deepEqual(ok.criteria.map((c) => [c.criterion_id, c.value]), [
    ['contact', true], ['discovery', null], ['identification', null], ['consultation', 15],
    ['empathy', true], ['dialogue', 7], ['closure', false], ['critical', false],
  ]);
  assert.deepEqual(ok.criteria[0].evidence_turns, [2]); // idx 1 → turn 2
  assert.deepEqual(ok.criteria[6].evidence_turns, [2, 3]); // checked range when no evidence
  // applicable: 10 + 20 + 15 + 15 + 5 = 65 → (10 + 15 + 15 + 10.5 + 0) / 65 * 100
  assert.equal(ok.score.final_score, 77.69);
  assert.equal(ok.score.critical_flag, false);
  assert.deepEqual(err, { conversation_id: 'r-missing', status: 'error', criteria: [], score: null, error: 'Не удалось получить ответ модели.' });
  assert.deepEqual(validateResults(file, { expectedIds: ['r-1', 'r-missing'], expectedCount: 2 }), []);
});

test('validator catches what the organisers list before push', () => {
  const bad = { schema_version: '1.0', team_name: 'x', model: { mode: 'cloud', name: 'm' }, results: [
    { conversation_id: 'a', status: 'ok', criteria: [{ criterion_id: 'contact', value: null, rationale: '', evidence_turns: [0] }], score: { final_score: 50, critical_flag: true } },
    { conversation_id: 'a', status: 'error', criteria: [], score: null, error: 'x' },
  ] };
  const e = validateResults(bad, { expectedIds: ['a', 'b'], expectedCount: 10 }).join(' | ');
  assert.match(e, /model.mode/);
  assert.match(e, /повторяются ID: a/);
  assert.match(e, /нет записей для: b/);
  assert.match(e, /нужно ровно 10/);
  assert.match(e, /contact = null не из допустимых/);
  assert.match(e, /evidence_turns — целые числа от 1/);
  assert.match(e, /discovery встречается 0 раз/);
  assert.equal(toValue('na'), null);
});

test('the organisers’ own example in the PDF scores 85.38', async () => {
  const { score } = await import('../shared/scoring.js');
  const r = score(checklist, { '01': 'yes', '02': 'na', '03': 'na', '04': 15, '05': 'yes', '06': 7, '07': 'yes', '08': 'no' });
  assert.equal(r.total, 85.38);
});
