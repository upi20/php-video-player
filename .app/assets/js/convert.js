// Konversi page: start/cancel background conversions and show their live progress.
import { $, appData, deleteWithConfirm, escapeHtml, fmtSize, fmtTime, thumbUrl, watchUrl } from './util.js';

const POLL_MS = 1000;
const ACTIVE = new Set(['queued', 'running']);
const STARTABLE = new Set(['idle', 'failed', 'canceled']);
const ORDER = { running: 0, queued: 1, failed: 2, idle: 3, canceled: 3, converted: 4 };

const list = $('jobs');
const empty = $('empty');
const allBtn = $('convert-all');
const rows = new Map(); // name -> { item, status, statusEl, key }

// ---------- Server calls ----------
async function api(action, body) {
  const options = body
    ? { method: 'POST', headers: { 'X-Requested-With': 'video-player' }, body: new URLSearchParams(body) }
    : { cache: 'no-store' };
  const res = await fetch(`?api=${action}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ---------- Rendering ----------
function modeHtml(plan) {
  if (plan.video !== 'copy') return '<span class="mode slow">Encode ulang · lebih lama</span>';
  if (plan.audio === 'encode') return '<span class="mode fast">Cepat · audio di-encode ulang</span>';
  return '<span class="mode fast">Cepat · kualitas tetap</span>';
}

const button = (act, label, style = '') =>
  `<button class="btn${style ? ` ${style}` : ''}" data-act="${act}">${label}</button>`;
const deleteButton = (label = 'Hapus') => button('delete', label, 'danger-ghost');

function statusHtml(item, s) {
  switch (s.state) {
    case 'queued':
      return `<div class="progress indeterminate"><span></span></div>
        <span class="status-text">Dalam antrean…</span>
        <div class="job-actions">${button('cancel', 'Batal')}</div>`;
    case 'running': {
      const parts = [`${s.percent ?? 0}%`];
      if (s.speed) parts.push(`${s.speed.toFixed(1)}×`);
      if (s.eta != null) parts.push(`sisa ${fmtTime(s.eta) || '< 1 dtk'}`);
      return `<div class="progress"><span style="width:${s.percent ?? 0}%"></span></div>
        <span class="status-text">${parts.join(' · ')}</span>
        <div class="job-actions">${button('cancel', 'Batal')}</div>`;
    }
    case 'converted':
      return `<span class="status-text ok">✓ Sudah jadi MP4</span>
        <div class="job-actions">
          ${deleteButton(`Hapus .${escapeHtml(item.ext)}`)}
          <a class="btn" href="${watchUrl({ name: item.output })}">Tonton</a>
        </div>`;
    case 'failed':
      return `<span class="status-text err">Gagal: ${escapeHtml(s.error ?? 'tidak diketahui')}</span>
        <div class="job-actions">${deleteButton()}${button('convert', 'Coba lagi', 'primary')}</div>`;
    case 'canceled':
      return `<span class="status-text">Dibatalkan</span>
        <div class="job-actions">${deleteButton()}${button('convert', 'Konversi', 'primary')}</div>`;
    default:
      return `<span class="status-text">Siap dikonversi</span>
        <div class="job-actions">${deleteButton()}${button('convert', 'Konversi', 'primary')}</div>`;
  }
}

function createRow(item) {
  const li = document.createElement('li');
  li.className = 'job';
  li.dataset.name = item.name;
  const meta = [
    `<span class="ext-flow">${escapeHtml(item.ext.toUpperCase())} → MP4</span>`,
    modeHtml(item.plan),
    `<span class="chip">${fmtSize(item.size)}</span>`,
    item.duration ? `<span class="chip">${fmtTime(item.duration)}</span>` : '',
    item.height ? `<span class="chip">${item.height}p</span>` : '',
    `<span class="chip">${escapeHtml([item.codecs.video, item.codecs.audio].filter(Boolean).join(' + ').toUpperCase())}</span>`,
  ].join('');
  li.innerHTML = `
    <div class="thumb"><img src="${thumbUrl(item)}" alt="" loading="lazy" decoding="async"></div>
    <div>
      <h2 class="job-title" title="${escapeHtml(item.name)}">${escapeHtml(item.title)}</h2>
      <div class="job-meta">${meta}</div>
    </div>
    <div class="job-status"></div>`;
  return li;
}

/** Updates rows from a {name: status} map; only touches rows whose status changed. */
function applyStatuses(statuses) {
  for (const [name, status] of Object.entries(statuses)) {
    const row = rows.get(name);
    if (!row) continue;
    const key = JSON.stringify(status);
    if (key === row.key) continue;
    row.key = key;
    row.status = status;
    row.el.classList.toggle('converted', status.state === 'converted');
    row.el.querySelector('.job-status').innerHTML = statusHtml(row.item, status);
  }

  const states = [...rows.values()].map((r) => r.status.state);
  allBtn.hidden = states.filter((s) => STARTABLE.has(s)).length < 2;

  // Keep the header badge in sync with what still needs converting.
  const pending = states.filter((s) => s !== 'converted').length;
  const badge = document.querySelector('.nav-badge');
  if (badge) {
    badge.textContent = pending;
    badge.hidden = pending === 0;
  }
  return states.some((s) => ACTIVE.has(s));
}

// ---------- Polling while something is queued or running ----------
let pollTimer = null;

function schedulePoll(active) {
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(poll, POLL_MS);
}

async function poll() {
  try {
    schedulePoll(applyStatuses(await api('jobs')));
  } catch {
    schedulePoll(true); // e.g. the container restarting: try again
  }
}

function showRowError(name, message) {
  const row = rows.get(name);
  if (!row) return;
  row.key = null; // the next poll redraws this row
  row.el.querySelector('.status-text').className = 'status-text err';
  row.el.querySelector('.status-text').textContent = message;
}

// ---------- Actions ----------
list.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const name = btn.closest('.job').dataset.name;
  if (btn.dataset.act === 'delete') {
    removeFile(name);
    return;
  }
  btn.disabled = true;
  try {
    schedulePoll(applyStatuses(await api(btn.dataset.act, { v: name })));
  } catch (err) {
    showRowError(name, `Gagal: ${err.message}`);
    btn.disabled = false;
  }
});

async function removeFile(name) {
  const row = rows.get(name);
  const { item } = row;
  const message = row.status.state === 'converted'
    ? `File asli "${item.name}" (${fmtSize(item.size)}) akan dihapus permanen. "${item.output}" tetap ada dan bisa diputar.`
    : undefined;
  if (!(await deleteWithConfirm(item, message))) return;
  row.el.remove();
  rows.delete(name);
  empty.hidden = rows.size > 0;
  applyStatuses({}); // refresh the "Konversi semua" button and the header badge
}

allBtn.addEventListener('click', async () => {
  allBtn.disabled = true;
  try {
    schedulePoll(applyStatuses(await api('convert', { all: 1 })));
  } finally {
    allBtn.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});

// ---------- Init ----------
const items = [...appData.items].sort((a, b) =>
  (ORDER[a.status.state] ?? 3) - (ORDER[b.status.state] ?? 3) || a.title.localeCompare(b.title, 'id', { numeric: true }));

for (const item of items) {
  const el = createRow(item);
  rows.set(item.name, { item, el, status: item.status, key: null });
  list.append(el);
}
empty.hidden = items.length > 0;
schedulePoll(applyStatuses(Object.fromEntries(items.map((i) => [i.name, i.status]))));
