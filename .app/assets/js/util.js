// Helpers shared by the home and watch pages.

export const $ = (id) => document.getElementById(id);

/** Data the PHP view embedded in <script id="app-data">. */
export const appData = JSON.parse($('app-data').textContent);

// localStorage can be unavailable (private mode, blocked storage): never let that break the page.
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('vid:' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem('vid:' + key, JSON.stringify(value)); } catch {}
  },
  del(key) {
    try { localStorage.removeItem('vid:' + key); } catch {}
  },
};

// ---------- Formatting ----------
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export const clock = (sec) => fmtTime(sec) || '0:00';

export function fmtSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${units[i]}`;
}

const rtf = new Intl.RelativeTimeFormat('id', { numeric: 'auto' });
const AGO_UNITS = [
  ['second', 60, 1],
  ['minute', 3600, 60],
  ['hour', 86400, 3600],
  ['day', 604800, 86400],
  ['week', 2629800, 604800],
  ['month', 31557600, 2629800],
  ['year', Infinity, 31557600],
];

export function fmtAgo(unix) {
  const diff = unix - Date.now() / 1000;
  const [unit, , size] = AGO_UNITS.find(([, limit]) => Math.abs(diff) < limit);
  return rtf.format(Math.round(diff / size), unit);
}

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Escaped text with every search word wrapped in <mark>. */
export function highlight(text, words) {
  let html = escapeHtml(text);
  for (const word of words) {
    const pattern = escapeHtml(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
  }
  return html;
}

// ---------- Sorting & search ----------
const SORTS = {
  new: (a, b) => b.mtime - a.mtime,
  old: (a, b) => a.mtime - b.mtime,
  name: (a, b) => a.title.localeCompare(b.title, 'id', { numeric: true, sensitivity: 'base' }),
  size: (a, b) => b.size - a.size,
  long: (a, b) => b.duration - a.duration,
};

export const sortVideos = (videos, sort) => [...videos].sort(SORTS[sort] ?? SORTS.new);
export const searchWords = (query) => query.toLowerCase().split(/\s+/).filter(Boolean);
export const matchesSearch = (video, words) => words.every((w) => video.title.toLowerCase().includes(w));

// ---------- URLs ----------
// The cache key (k) changes whenever the file does, so the server lets browsers cache forever.
// Telegram videos name themselves differently (v.api, see toVideo in tg.js).
const apiUrl = (action, v, extra = '') => `?api=${action}&${v.api ?? `v=${encodeURIComponent(v.name)}`}&k=${v.key}${extra}`;
export const thumbUrl = (v) => apiUrl('thumb', v);
export const loudnessUrl = (v) => apiUrl('loudness', v);
export const storyboardUrl = (v, sheet) => apiUrl('storyboard', v, sheet ? `&sheet=${sheet}` : '');
export const watchUrl = (v) => `?v=${encodeURIComponent(v.name)}`;

// ---------- Watch progress ----------
export const posKey = (v) => `pos:${v.name}`;

export function watchedPercent(v) {
  const pos = store.get(posKey(v), 0);
  return v.duration && pos ? Math.min(100, (pos / v.duration) * 100) : 0;
}

// ---------- Changing files ----------
/** POST to an API action that changes files (the header is checked by isAppPost() in api.php). */
export async function postApi(action, body) {
  const res = await fetch(`?api=${action}`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'video-player' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Modal confirmation using the native <dialog>. Resolves true only when confirmed. */
export function confirmDialog({ title, message, confirmLabel }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'confirm';
  dialog.innerHTML = `
    <form method="dialog">
      <h2></h2>
      <p></p>
      <div class="confirm-actions">
        <button class="btn" value="cancel" autofocus>Batal</button>
        <button class="btn danger" value="ok"></button>
      </div>
    </form>`;
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('p').textContent = message;
  dialog.querySelector('[value="ok"]').textContent = confirmLabel;
  // Clicking the dimmed backdrop cancels, like Escape does.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close('cancel');
  });
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok');
      dialog.remove();
    }, { once: true });
  });
}

let noticeTimer = null;

/** Short message at the bottom of the screen. */
export function notice(text, isError = false) {
  let el = document.querySelector('.notice');
  if (!el) {
    el = document.createElement('div');
    el.className = 'notice';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
}

/**
 * Asks for confirmation, then permanently deletes the file and forgets its watch position.
 * Resolves true when the file is gone.
 */
export async function deleteWithConfirm(file, message) {
  const confirmed = await confirmDialog({
    title: 'Hapus file ini?',
    message: message ?? `"${file.name}" (${fmtSize(file.size)}) akan dihapus permanen dari folder. Tindakan ini tidak bisa dibatalkan.`,
    confirmLabel: 'Hapus permanen',
  });
  if (!confirmed) return false;
  try {
    await postApi('delete', { v: file.name });
  } catch (e) {
    notice(`Gagal menghapus: ${e.message}`, true);
    return false;
  }
  store.del(posKey(file));
  notice(`"${file.title}" dihapus`);
  return true;
}

export const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

/** Inner HTML of a .thumb: cover image, duration badge and watched bar. */
export function thumbHtml(v) {
  const watched = watchedPercent(v);
  return `<img src="${thumbUrl(v)}" alt="" loading="lazy" decoding="async">`
    + (v.duration ? `<span class="duration">${fmtTime(v.duration)}</span>` : '')
    + (watched ? `<span class="watched" style="width:${watched}%"></span>` : '');
}
