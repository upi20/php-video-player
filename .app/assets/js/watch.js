// Watch page: playlist, switching videos without reloading, resume, autoplay, keyboard, theater mode.
import {
  $, appData, escapeHtml, fmtAgo, fmtSize, fmtTime, highlight, matchesSearch, posKey, searchWords,
  sortVideos, store, thumbHtml, thumbUrl, watchedPercent, watchUrl,
} from './util.js';
import { createPlayer } from './player.js';

const UPNEXT_SECONDS = 5;

const { videos } = appData;
const byName = new Map(videos.map((v) => [v.name, v]));
const els = {
  watch: $('watch'), title: $('title'), chips: $('chips'), list: $('list'), count: $('count'),
  search: $('search'), sort: $('sort'), prev: $('prev'), next: $('next'), autoplay: $('autoplay'),
  theater: $('c-theater'), toast: $('toast'), toastText: $('toast-text'), toastAction: $('toast-action'),
  upnext: $('upnext'), upnextSec: $('upnext-sec'), upnextBar: $('upnext-bar'), upnextThumb: $('upnext-thumb'),
  upnextTitle: $('upnext-title'), upnextPlay: $('upnext-play'), upnextCancel: $('upnext-cancel'),
};

const player = createPlayer();
const { video } = player;

let current = null;
let order = [];            // the visible playlist (sorted + filtered)
let words = [];            // search words
const itemEls = new Map(); // name -> playlist <button>

// ---------- Playlist ----------
const PLAYING_HTML = '<span class="playing"><span><span class="eq"><i></i><i></i><i></i></span>Diputar</span></span>';

function renderList() {
  order = sortVideos(videos, els.sort.value).filter((v) => matchesSearch(v, words));
  itemEls.clear();
  els.list.replaceChildren(...order.map((v) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'item';
    btn.title = v.title;
    btn.innerHTML = `
      <div class="thumb">${thumbHtml(v)}${PLAYING_HTML}</div>
      <div>
        <div class="item-title">${highlight(v.title, words)}</div>
        <div class="item-meta">${fmtSize(v.size)} · ${fmtAgo(v.mtime)}</div>
      </div>`;
    btn.addEventListener('click', () => go(v));
    itemEls.set(v.name, btn);
    li.append(btn);
    return li;
  }));

  if (!order.length) els.list.innerHTML = '<li class="list-empty">Tidak ada video yang cocok.</li>';
  els.count.textContent = words.length ? `${order.length} dari ${videos.length}` : `${videos.length} video`;
  markActive(false);
}

function markActive(scroll) {
  for (const [name, el] of itemEls) el.classList.toggle('active', name === current?.name);
  const active = current && itemEls.get(current.name);
  if (active && scroll) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  els.prev.disabled = !neighbor(-1);
  els.next.disabled = !neighbor(1);
}

/** Updates just the watched bar, so the cover image isn't re-created while playing. */
function updateWatched(v) {
  const thumb = itemEls.get(v.name)?.querySelector('.thumb');
  if (!thumb) return;
  const percent = watchedPercent(v);
  let bar = thumb.querySelector('.watched');
  if (!percent) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('span');
    bar.className = 'watched';
    thumb.querySelector('img').after(bar);
  }
  bar.style.width = `${percent}%`;
}

// Next/previous follow the visible playlist; if the current video is filtered out, the full sorted list.
function neighbor(step) {
  if (!current) return null;
  const list = order.includes(current) ? order : sortVideos(videos, els.sort.value);
  return list[list.indexOf(current) + step] ?? null;
}

// ---------- Switching videos ----------
function go(v) {
  if (!v || v === current) return;
  history.pushState(null, '', watchUrl(v));
  load(v, true);
}

function load(v, autoplay) {
  hideUpNext();
  hideToast();
  current = v;
  document.title = `${v.title} · Video Player`;
  renderNow();
  markActive(true);
  player.load(v, neighbor(1));
  if (autoplay) video.play().catch(() => {});
}

function renderNow() {
  const height = video.videoHeight || current.height;
  const chips = [
    height ? `${height}p` : null,
    fmtTime(video.duration || current.duration),
    fmtSize(current.size),
    current.ext.toUpperCase(),
    `ditambahkan ${fmtAgo(current.mtime)}`,
  ].filter(Boolean);
  els.title.textContent = current.title;
  els.chips.innerHTML = chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
}

window.addEventListener('popstate', () => {
  const v = byName.get(new URLSearchParams(location.search).get('v') ?? '');
  if (v && v !== current) load(v, true);
});

// ---------- Resume where you left off ----------
video.addEventListener('loadedmetadata', () => {
  const pos = store.get(posKey(current), 0);
  if (pos > 10 && pos < video.duration - 15) {
    video.currentTime = pos;
    showToast(`Dilanjutkan dari ${fmtTime(pos)}`, 'Mulai dari awal', () => {
      video.currentTime = 0;
      hideToast();
    });
  }
  renderNow();
});

let lastSave = 0;
function savePosition(force) {
  if (!current || !video.duration) return;
  const now = Date.now();
  if (!force && now - lastSave < 3000) return;
  lastSave = now;
  const t = video.currentTime;
  if (t > video.duration - 15) store.del(posKey(current));
  else if (t > 10) store.set(posKey(current), t);
  updateWatched(current);
}

video.addEventListener('timeupdate', () => savePosition(false));
video.addEventListener('pause', () => savePosition(true));
window.addEventListener('pagehide', () => savePosition(true));
video.addEventListener('play', () => els.list.classList.remove('paused'));
video.addEventListener('pause', () => els.list.classList.add('paused'));

video.addEventListener('ended', () => {
  store.del(posKey(current));
  updateWatched(current);
  const next = neighbor(1);
  if (next && els.autoplay.checked) showUpNext(next);
});

video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  showToast('Video ini tidak bisa diputar di browser (format/codec tidak didukung).', null, null, true);
});

// ---------- Toast ----------
let toastTimer = null;

function showToast(text, actionLabel, action, isError = false) {
  clearTimeout(toastTimer);
  els.toast.hidden = false;
  els.toast.classList.toggle('error', isError);
  els.toastText.textContent = text;
  els.toastAction.hidden = !actionLabel;
  els.toastAction.textContent = actionLabel ?? '';
  els.toastAction.onclick = action;
  toastTimer = setTimeout(hideToast, isError ? 8000 : 6000);
}

function hideToast() {
  els.toast.hidden = true;
}

// ---------- Up next countdown ----------
let upnextTimer = null;

function showUpNext(v) {
  clearInterval(upnextTimer);
  let left = UPNEXT_SECONDS;
  els.upnextThumb.innerHTML = `<img src="${thumbUrl(v)}" alt="">`;
  els.upnextTitle.textContent = v.title;
  els.upnextSec.textContent = left;
  els.upnextBar.style.animation = 'none';
  void els.upnextBar.offsetWidth; // restart the CSS animation
  els.upnextBar.style.animation = `shrink ${UPNEXT_SECONDS}s linear forwards`;
  els.upnext.hidden = false;
  els.upnext.dataset.name = v.name;
  upnextTimer = setInterval(() => {
    left--;
    els.upnextSec.textContent = left;
    if (left > 0) return;
    hideUpNext();
    go(v);
  }, 1000);
}

function hideUpNext() {
  clearInterval(upnextTimer);
  els.upnext.hidden = true;
}

els.upnextPlay.addEventListener('click', () => go(byName.get(els.upnext.dataset.name)));
els.upnextCancel.addEventListener('click', hideUpNext);

// ---------- Controls below the video ----------
els.prev.addEventListener('click', () => go(neighbor(-1)));
els.next.addEventListener('click', () => go(neighbor(1)));

els.autoplay.checked = store.get('autoplay', true);
els.autoplay.addEventListener('change', () => store.set('autoplay', els.autoplay.checked));

els.sort.value = store.get('sort', 'new');
els.sort.addEventListener('change', () => {
  store.set('sort', els.sort.value);
  renderList();
});

// The header search filters the playlist live; Enter goes to the home page results.
els.search.addEventListener('input', () => {
  words = searchWords(els.search.value);
  renderList();
});

// ---------- Theater mode (remembered) ----------
const THEATER_ICONS = {
  on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="7" width="14" height="10" rx="1.5"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="1.5"/></svg>',
};

function setTheater(on) {
  els.watch.classList.toggle('theater', on);
  els.theater.innerHTML = on ? THEATER_ICONS.on : THEATER_ICONS.off;
  els.theater.title = on ? 'Mode biasa (T)' : 'Mode bioskop (T)';
  store.set('theater', on);
}

function toggleTheater() {
  const on = !els.watch.classList.contains('theater');
  setTheater(on);
  if (on) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (current) itemEls.get(current.name)?.scrollIntoView({ block: 'nearest' });
}

els.theater.addEventListener('click', toggleTheater);
setTheater(store.get('theater', false));

// ---------- Keyboard shortcuts ----------
const SHORTCUTS = {
  ' ': player.togglePlay,
  k: player.togglePlay,
  j: () => player.seekBy(-10),
  l: () => player.seekBy(10),
  ArrowLeft: () => player.seekBy(-5),
  ArrowRight: () => player.seekBy(5),
  ArrowUp: () => player.changeVolume(0.1),
  ArrowDown: () => player.changeVolume(-0.1),
  f: player.toggleFullscreen,
  t: toggleTheater,
  m: player.toggleMute,
  n: () => go(neighbor(1)),
  p: () => go(neighbor(-1)),
  '/': () => els.search.focus(),
};

let spaceHandled = false;

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, select, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const action = SHORTCUTS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
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

// ---------- Init ----------
current = byName.get(appData.current);
renderList();
load(current, false);
