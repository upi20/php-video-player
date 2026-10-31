// Pieces shared by both watch pages (local videos and Telegram), all working on the DOM of
// views/partials/player.php: toast, up-next countdown, resume/progress, theater mode, shortcuts.
import { $, fmtTime, posKey, store } from './util.js';

const UPNEXT_SECONDS = 5;

// ---------- Toast (top-left of the player) ----------
export function createToast() {
  const el = $('toast');
  const text = $('toast-text');
  const action = $('toast-action');
  let timer = null;

  function hide() {
    el.hidden = true;
  }

  function show(message, actionLabel = null, onAction = null, isError = false) {
    clearTimeout(timer);
    el.hidden = false;
    el.classList.toggle('error', isError);
    text.textContent = message;
    action.hidden = !actionLabel;
    action.textContent = actionLabel ?? '';
    action.onclick = onAction;
    timer = setTimeout(hide, isError ? 8000 : 6000);
  }

  return { show, hide };
}

// ---------- Up next: countdown overlay when a video ends ----------
/** go(v) plays the next video; thumbUrl(v) gives its cover image. */
export function createUpNext({ go, thumbUrl }) {
  const els = {
    root: $('upnext'), sec: $('upnext-sec'), bar: $('upnext-bar'), thumb: $('upnext-thumb'),
    title: $('upnext-title'), play: $('upnext-play'), cancel: $('upnext-cancel'),
  };
  let timer = null;
  let pending = null;

  function hide() {
    clearInterval(timer);
    els.root.hidden = true;
    pending = null;
  }

  function show(v) {
    clearInterval(timer);
    pending = v;
    let left = UPNEXT_SECONDS;
    els.thumb.innerHTML = `<img src="${thumbUrl(v)}" alt="">`;
    els.title.textContent = v.title;
    els.sec.textContent = left;
    els.bar.style.animation = 'none';
    void els.bar.offsetWidth; // restart the CSS animation
    els.bar.style.animation = `shrink ${UPNEXT_SECONDS}s linear forwards`;
    els.root.hidden = false;
    timer = setInterval(() => {
      left--;
      els.sec.textContent = left;
      if (left > 0) return;
      hide();
      go(v);
    }, 1000);
  }

  els.play.addEventListener('click', () => {
    const v = pending;
    hide();
    if (v) go(v);
  });
  els.cancel.addEventListener('click', hide);

  return { show, hide };
}

// ---------- Resume, saved progress, playback errors ----------
/**
 * Remembers the position of each video (keyed by posKey(v), so v needs a unique `name`) and
 * resumes it next time. onProgress(v) runs after each save, e.g. to update a watched bar.
 */
export function setupPlayback(video, { current, toast, onProgress = () => {} }) {
  video.addEventListener('loadedmetadata', () => {
    const v = current();
    const pos = store.get(posKey(v), 0);
    if (pos > 10 && pos < video.duration - 15) {
      video.currentTime = pos;
      toast.show(`Dilanjutkan dari ${fmtTime(pos)}`, 'Mulai dari awal', () => {
        video.currentTime = 0;
        toast.hide();
      });
    }
  });

  let lastSave = 0;
  function savePosition(force) {
    const v = current();
    if (!v || !video.duration) return;
    const now = Date.now();
    if (!force && now - lastSave < 3000) return;
    lastSave = now;
    const t = video.currentTime;
    if (t > video.duration - 15) store.del(posKey(v));
    else if (t > 10) store.set(posKey(v), t);
    onProgress(v);
  }

  video.addEventListener('timeupdate', () => savePosition(false));
  video.addEventListener('pause', () => savePosition(true));
  window.addEventListener('pagehide', () => savePosition(true));
  video.addEventListener('ended', () => {
    store.del(posKey(current()));
    onProgress(current());
  });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    toast.show('Video ini tidak bisa diputar di browser (format/codec tidak didukung).', null, null, true);
  });
}

// ---------- Theater mode (remembered) ----------
const THEATER_ICONS = {
  on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="7" width="14" height="10" rx="1.5"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="1.5"/></svg>',
};

/** Wires the theater button; returns the toggle function (for the T shortcut). */
export function setupTheater(watchEl, onToggle = () => {}) {
  const btn = $('c-theater');

  function set(on) {
    watchEl.classList.toggle('theater', on);
    btn.innerHTML = on ? THEATER_ICONS.on : THEATER_ICONS.off;
    btn.title = on ? 'Mode biasa (T)' : 'Mode bioskop (T)';
    store.set('theater', on);
  }

  function toggle() {
    const on = !watchEl.classList.contains('theater');
    set(on);
    if (on) window.scrollTo({ top: 0, behavior: 'smooth' });
    onToggle(on);
  }

  btn.addEventListener('click', toggle);
  set(store.get('theater', false));
  return toggle;
}

// ---------- Keyboard shortcuts ----------
/** Player shortcuts plus page-specific ones in `extra` (key → function). */
export function setupShortcuts(player, extra = {}) {
  const shortcuts = {
    ' ': player.togglePlay,
    k: player.togglePlay,
    j: () => player.seekBy(-10),
    l: () => player.seekBy(10),
    ArrowLeft: () => player.seekBy(-5),
    ArrowRight: () => player.seekBy(5),
    ArrowUp: () => player.changeVolume(0.1),
    ArrowDown: () => player.changeVolume(-0.1),
    f: player.toggleFullscreen,
    m: player.toggleMute,
    ...extra,
  };
  let spaceHandled = false;

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input, select, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const action = shortcuts[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!action) return;
    e.preventDefault();
    action();
    player.wake();
    spaceHandled = e.key === ' ';
  });

  // A focused button would also "click" on Space keyup; the shortcut already handled it.
  document.addEventListener('keyup', (e) => {
    if (e.key !== ' ' || !spaceHandled) return;
    spaceHandled = false;
    e.preventDefault();
  });
}
