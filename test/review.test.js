import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteFound, computeReviewFlags } from '../server/lib/review.js';

test('quote matching tolerates punctuation, case, ё and "…" gaps', () => {
  const t = ['Здравствуйте, меня зовут Алина. В веб-версии откройте вкладку «Кабинет». Название тарифа будет под вашим ФИО.'];
  assert.equal(quoteFound('меня зовут алина', t), true);
  assert.equal(quoteFound('«Кабинет»… Название тарифа будет', t), true);
  assert.equal(quoteFound('Скиньте деньги мне на карту', t), false);
  assert.equal(quoteFound('', t), true);
});

test('flags: missing quote, hedged explanation, repairs', () => {
  const conv = { messages: [{ idx: 0, text: 'Hello, I am Maya.' }, { idx: 1, text: 'I can see a withdrawal restriction.' }] };
  const rec = {
    model: 'gemini-3.5-flash', repairs: 1,
    criteria: [
      { id: '01', explanation: 'Greeted.', evidence: [0], quote: 'I am Maya' },
      { id: '08', explanation: 'Нарушений нет. Хотя оператор упомянул ограничение…', evidence: [1], quote: 'invented sentence here' },
    ],
  };
  const checklist = { criteria: [{ id: '01', type: 'binary' }, { id: '08', type: 'flag' }] };
  rec.criteria[1].answer = 'no';
  const codes = computeReviewFlags(rec, conv, checklist).map((f) => `${f.criterion_id}:${f.code}`);
  assert.deepEqual(codes.sort(), ['08:hedged', '08:quote_not_found', 'null:repaired']);
});

test('contrast words alone do not flag a normal "No" explanation', () => {
  const checklist = { criteria: [{ id: '02', type: 'binary' }] };
  const rec = { model: 'gemini-3.5-flash', repairs: 0, criteria: [{ id: '02', answer: 'no', explanation: 'Оператор переспросил, хотя клиент уже указал сайт.', evidence: [], quote: '' }] };
  assert.deepEqual(computeReviewFlags(rec, { messages: [] }, checklist), []);
  rec.criteria[0].explanation = 'Возможно, оператор учёл детали.';
  assert.equal(computeReviewFlags(rec, { messages: [] }, checklist)[0].code, 'hedged');
});

test('split votes: only serious disagreements are flagged', async () => {
  const { seriousSplit } = await import('../server/lib/review.js');
  const scale = { type: 'scale', scale: { steps: [{ value: 20 }, { value: 15 }, { value: 10 }, { value: 5 }, { value: 0 }] } };
  assert.equal(seriousSplit([15, 15, 10], scale), false); // neighbouring steps
  assert.equal(seriousSplit([0, 4, 4], { type: 'scale', scale: { steps: [{ value: 10 }, { value: 7 }, { value: 4 }, { value: 0 }] } }), false);
  assert.equal(seriousSplit([20, 20, 10], scale), true); // two steps apart
  assert.equal(seriousSplit([15, 'na', 15], scale), true);
  assert.equal(seriousSplit(['yes', 'no', 'no'], { type: 'binary' }), true);
  assert.equal(seriousSplit(['yes', 'yes', 'yes'], { type: 'binary' }), false);
});
