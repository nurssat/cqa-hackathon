#!/usr/bin/env node
// One command for the hour before the stop-code:
//   npm run results -- <group_id> [--set prod|dev] [--team "Name"] [--runs 3] [--no-push] [--no-eval]
// Fetches the set from the organisers' API, evaluates every dialogue not yet
// evaluated with the current checklist version (with retries), writes
// results/<set>/results.json in the organisers' format, validates it, then
// commits and pushes it to GitHub.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadDotEnv, PROJECT_ROOT } from '../server/lib/store.js';

loadDotEnv();
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const VALUED = new Set(['--set', '--team', '--runs', '--concurrency']);
const group = args.find((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));
if (!group) {
  console.log('Использование: npm run results -- <group_id> [--set prod|dev] [--team "Название"] [--runs 3] [--no-push]');
  process.exit(1);
}
const set = opt('set', group.toUpperCase() === 'DEV' ? 'dev' : 'prod');
const team = opt('team', process.env.TEAM_NAME);
if (opt('runs')) process.env.EVAL_RUNS = opt('runs');

const ds = await import('../server/lib/datasource.js');
const cl = await import('../server/lib/checklists.js');
const batch = await import('../server/lib/batch.js');
const { buildResults, validateResults } = await import('../server/lib/results.js');

const t0 = Date.now();
const elapsed = () => `${Math.round((Date.now() - t0) / 1000)} с`;
const log = (m) => console.log(`[${elapsed()}] ${m}`);

cl.seedDefault();
const checklist = cl.get('chat-quality');
log(`Набор ${group} → results/${set}/results.json · чек-лист «${checklist.name}» v${checklist.version} · прогонов: ${process.env.EVAL_RUNS || 1}`);

// 1. Data from the API (fresh), retried inside fetchGroup.
const g = await ds.fetchGroup(group);
const ids = g.response.data.records.map((r) => r.conversation_id);
log(`Получено диалогов: ${ids.length}`);
if (set === 'prod' && ids.length !== 10) log(`ВНИМАНИЕ: в контрольном наборе ожидалось 10 диалогов, пришло ${ids.length}`);

// 2. Evaluate what is missing; then one more pass for the ones that failed.
const errors = {};
if (!flag('no-eval')) {
  for (let pass = 1; pass <= 2; pass++) {
    const job = await batch.startBatch({ group, checklistId: checklist.id, onlyMissing: true, concurrency: Number(opt('concurrency', 4)) });
    const todo = job.items.filter((i) => i.status === 'pending' || i.status === 'running').length;
    if (!todo) { log('Все диалоги уже оценены этой версией чек-листа.'); break; }
    log(`Проход ${pass}: оцениваем ${todo} диалогов…`);
    let last = '';
    for (;;) {
      const j = batch.getJob(job.id);
      const c = j.counts;
      const line = `готово ${c.done + c.skipped}/${j.items.length}, ошибок ${c.error}`;
      if (line !== last) { log(line); last = line; }
      if (j.status !== 'running') {
        for (const it of j.items) if (it.status === 'error') errors[it.conversation_id] = it.error; else delete errors[it.conversation_id];
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!Object.keys(errors).length) break;
    log(`Не удалось: ${Object.keys(errors).join(', ')}${pass === 1 ? ' — пробуем ещё раз' : ''}`);
  }
}

// 3. Build, validate, write.
const file = buildResults({ group, checklistId: checklist.id, conversationIds: ids, teamName: team, errors });
const problems = validateResults(file, {
  expectedIds: ids,
  expectedCount: set === 'prod' ? 10 : ids.length,
  requiredCodes: checklist.criteria.map((k) => k.code || k.id),
});
const out = path.join(PROJECT_ROOT, 'results', set, 'results.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(file, null, 2) + '\n', 'utf8');
const ok = file.results.filter((r) => r.status === 'ok').length;
log(`Записан ${path.relative(PROJECT_ROOT, out)}: ${file.results.length} записей, оценено ${ok}, ошибок ${file.results.length - ok}`);
if (problems.length) {
  console.log('\nПРОВЕРКА ФОРМАТА НЕ ПРОЙДЕНА:\n- ' + problems.join('\n- '));
  if (!flag('force')) { console.log('\nФайл записан, но не отправлен. Исправьте или запустите с --force.'); process.exit(2); }
}
log('Формат проверен: OK');

// 4. Commit and push (retry the push: the network can blink).
if (flag('no-push')) { log('--no-push: в GitHub не отправлено.'); process.exit(0); }
const git = (...a) => execFileSync('git', a, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const ident = [];
try { git('config', 'user.email'); } catch { ident.push('-c', 'user.email=cqa-team@users.noreply.github.com', '-c', `user.name=${team || 'CQA team'}`); }
git('add', path.relative(PROJECT_ROOT, out));
try {
  git(...ident, 'commit', '-m', `Results: ${set} (${group}), ${ok}/${file.results.length} evaluated`);
} catch (e) {
  if (!/nothing to commit|nothing added/.test(String(e.stdout) + String(e.stderr))) throw e;
  log('Изменений нет — файл уже в коммите.');
}
for (let i = 0; i < 4; i++) {
  try {
    try { git('pull', '--rebase', '--autostash', 'origin', 'main'); } catch {}
    git('push', 'origin', 'HEAD:main');
    log('Отправлено в GitHub ✓  Проверьте: https://github.com/nurssat/cqa-hackathon/blob/main/results/' + set + '/results.json');
    process.exit(0);
  } catch (e) {
    log(`push не удался (${String(e.stderr || e.message).split('\n')[0]}), повтор через ${2 ** (i + 1)} с`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
}
console.log('\nНЕ УДАЛОСЬ ОТПРАВИТЬ. Выполните вручную: git push');
process.exit(3);
