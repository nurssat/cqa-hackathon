// Header indicator for a running batch check, visible on every page.
// Polls the local server: every 3 s while a check runs, every 15 s otherwise.
import { api } from './api.js';
import { h, mount } from './ui.js';

let timer = null;
let lastRunning = null;

export function initBatchPill(container) {
  const pill = h('a.batch-pill', { href: '#/batch', hidden: true, role: 'status', 'aria-live': 'polite' });
  container.prepend(pill);
  const tick = async () => {
    let running = null;
    let finished = null;
    try {
      const jobs = await api.get('/api/batch');
      running = jobs.find((j) => j.status === 'running') || null;
      if (!running && lastRunning) finished = jobs.find((j) => j.id === lastRunning) || null;
    } catch {
      schedule(15000);
      return;
    }
    if (running) {
      const c = running.counts;
      const total = c.pending + c.running + c.done + c.skipped + c.error;
      const done = c.done + c.skipped + c.error;
      const pct = total ? Math.round((done / total) * 100) : 0;
      mount(pill,
        h('span.batch-pill-spin', { 'aria-hidden': true }),
        h('span', `Проверка ${running.group_id}: ${done} / ${total}`),
        h('span.batch-pill-bar', { 'aria-hidden': true }, h('span', { style: { width: `${pct}%` } })));
      pill.className = 'batch-pill';
      pill.title = 'Идёт проверка набора — открыть';
      pill.hidden = false;
      lastRunning = running.id;
      schedule(3000);
      return;
    }
    if (finished) {
      const errs = finished.counts.error;
      mount(pill, h('span', errs ? `Проверка ${finished.group_id} завершена · ошибок: ${errs}` : `Проверка ${finished.group_id} завершена ✓`));
      pill.className = errs ? 'batch-pill warn' : 'batch-pill done';
      pill.title = 'Открыть результаты проверки';
      pill.hidden = false;
      lastRunning = null;
      setTimeout(() => { if (!lastRunning) pill.hidden = true; }, 15000);
    }
    schedule(15000);
  };
  const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
  // A batch started on this page should show up immediately.
  window.addEventListener('cqa:batch-started', () => schedule(300));
  tick();
}

