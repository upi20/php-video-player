// Pieces shared by both watch pages (local videos and Telegram), all working on the DOM of
// views/partials/player.php: toast, up-next countdown, resume/progress, theater mode, shortcuts.
import { $, fmtTime, posKey, seenKey, store } from './util.js';

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

// ---------- Autoplay ----------
/** Plays the loaded video with sound; when the browser holds it back, one tap starts it. */
export async function autoplay(player, toast) {
  if (await player.autoplay() !== 'blocked') return;
  toast.show('Browser menahan autoplay bersuara', 'Putar', () => {
    player.video.play().catch(() => {});
    toast.hide();
  });
}

// ---------- Watched ----------
// Played this long (or half of a shorter video) → it counts as watched. Short clips are common,
// so "played it once" is the useful mark; the resume bar never shows for them.
const WATCHED_AFTER_S = 2;

/** Calls onWatched(v) (on every timeupdate) once the current video has really played long enough. */
export function onPlayedEnough(video, { current, onWatched }) {
  video.addEventListener('timeupdate', () => {
    const v = current();
    if (v && video.duration && !video.paused && video.currentTime >= Math.min(WATCHED_AFTER_S, video.duration / 2)) {
      onWatched(v);
    }
  });
}

// ---------- Resume, saved progress, playback errors ----------
const RECOVER_TRIES = 6;
const RECOVER_STALL_MS = 15000; // waiting this long for data while playing counts as a broken stream

/**
 * Remembers the position of each video (keyed by posKey(v), so v needs a unique `name`) and
 * resumes it next time. onProgress(v) runs after each save, e.g. to update a watched bar.
 * recover: the source is a stream that can break (Telegram, through the tg module, which may be
 * restarting or lose its connection): reconnect a few times and go on where it stopped.
 */
export function setupPlayback(video, { current, toast, onProgress = () => {}, recover = false }) {
  let recovering = false;

  video.addEventListener('loadedmetadata', () => {
    if (recovering) return; // reconnecting: it continues where it broke off, see reconnect()
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
    // Only what was really played: seeking ahead while paused doesn't count.
    if (!video.seeking && (!video.paused || force)) markSeen(v, t / video.duration);
    onProgress(v);
  }

  function markSeen(v, share) {
    const seen = Math.min(1, Math.round(share * 1000) / 1000);
    if (seen > store.get(seenKey(v), 0)) store.set(seenKey(v), seen);
  }

  video.addEventListener('timeupdate', () => savePosition(false));
  video.addEventListener('pause', () => savePosition(true));
  window.addEventListener('pagehide', () => savePosition(true));
  video.addEventListener('ended', () => {
    store.del(posKey(current()));
    markSeen(current(), 1);
    onProgress(current());
  });
  // ----- Reconnecting a broken stream -----
  let tries = 0;
  let lastTime = 0;    // where it was when it broke
  let wantsPlay = false;
  let stallTimer = null;
  let reloadedAt = null; // position a reconnect resumed at, once it loaded fine
  let started = false;    // it has played: a stall from then on is a broken stream, not a slow start

  video.addEventListener('timeupdate', () => {
    if (!recovering && !video.seeking && video.currentTime > 0) lastTime = video.currentTime;
  });
  video.addEventListener('play', () => { wantsPlay = true; });
  video.addEventListener('pause', () => {
    if (!recovering) wantsPlay = false;
  });
  video.addEventListener('emptied', () => {
    if (recovering) return;
    clearTimeout(stallTimer);
    tries = 0; // another video: a fresh start
    lastTime = 0;
    reloadedAt = null;
    started = false;
  });
  video.addEventListener('playing', () => {
    started = true;
    clearTimeout(stallTimer);
    if (!recovering && tries) {
      tries = 0;
      toast.show('Tersambung lagi');
    }
  });
  if (recover) {
    video.addEventListener('waiting', () => {
      clearTimeout(stallTimer);
      if (!started) return; // still starting (a big video can take a while): not stuck
      stallTimer = setTimeout(() => {
        if (!video.paused && video.readyState < 3) streamFailed(false);
      }, RECOVER_STALL_MS);
    });
  }

  /** Loads the same source again and continues at `at` (playing if it was). */
  function reload(at, play, then = () => {}) {
    const src = video.getAttribute('src');
    recovering = true;
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(at, Math.max(0, video.duration - 0.5));
      recovering = false;
      then();
      if (play) video.play().catch(() => {});
    }, { once: true });
    video.src = src;
  }

  function reconnect() {
    const v = current();
    const src = video.getAttribute('src');
    if (!src || tries >= RECOVER_TRIES) return false;
    tries++;
    recovering = true;
    const at = lastTime;
    const play = wantsPlay;
    toast.show(`Koneksi video terputus, menyambung lagi… (${tries}/${RECOVER_TRIES})`);
    setTimeout(() => {
      if (current() !== v || video.getAttribute('src') !== src) {
        recovering = false;
        return;
      }
      reload(at, play, () => { reloadedAt = at; });
    }, 2000 * tries);
    return true;
  }

  /** The file itself is broken around here (e.g. bad audio data): offer to jump past it. */
  function showBroken() {
    recovering = false;
    const at = lastTime;
    toast.show(`Bagian video ini rusak (sekitar ${fmtTime(at) || '0:00'}).`, 'Lewati 5 dtk', () => {
      toast.hide();
      lastTime = at + 5;
      reload(at + 5, true);
    }, true);
  }

  /**
   * The stream failed (an error, or stuck while playing). Bad data, not a lost connection, when
   * the browser says it can't decode it, or when it fails again at the same place right after a
   * reconnect that loaded fine: reconnecting would only hit that spot again. Returns whether it
   * was handled.
   */
  function streamFailed(decodeError) {
    if (decodeError || (reloadedAt !== null && Math.abs(lastTime - reloadedAt) < 3)) {
      showBroken();
      return true;
    }
    return reconnect();
  }

  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    if (recover && streamFailed(video.error?.code === MediaError.MEDIA_ERR_DECODE)) return;
    recovering = false;
    toast.show(recover
      ? 'Video tidak bisa diputar: koneksi ke Telegram gagal, atau format/codec-nya tidak didukung browser.'
      : 'Video ini tidak bisa diputar di browser (format/codec tidak didukung).', null, null, true);
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

// ---------- Back to the list ----------
// Switching videos on a watch page adds a history entry each time; history.state.depth counts
// them, so going back to the list means stepping back depth + 1 entries.

/** For switching videos: a new history entry, one deeper. */
export function pushVideo(url) {
  history.pushState({ depth: (history.state?.depth ?? 0) + 1 }, '', url);
}

/** For replacing the video (e.g. after deleting one) without changing the depth. */
export function replaceVideo(url) {
  history.replaceState(history.state, '', url);
}

/**
 * Shortcuts (Esc, Q, Backspace) back to the list. When this tab came from the list
 * (isList(referrer URL)), it steps back through history: the browser shows the list from its
 * back/forward cache as it was left, scroll included, with no reload. Otherwise (a link, a new
 * tab) it opens url(). In fullscreen, Esc is the browser's own (it leaves fullscreen first).
 */
export function backShortcuts(url, isList) {
  let fromList = false;
  try {
    const ref = new URL(document.referrer);
    fromList = ref.origin === location.origin && isList(ref.searchParams);
  } catch {
    // no referrer
  }
  const back = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    if (fromList) history.go(-((history.state?.depth ?? 0) + 1));
    else location.assign(url());
  };
  return { Escape: back, q: back, Backspace: back };
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
    r: player.rotate,
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
