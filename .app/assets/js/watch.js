// Watch page for local videos: playlist, switching videos without reloading, delete.
// Toast, up next, resume, theater mode and shortcuts come from stage.js.
import {
  $, appData, deleteWithConfirm, escapeHtml, fmtAgo, fmtSize, fmtTime, highlight, matchesSearch, postApi,
  posKey, searchWords, seenKey, sortVideos, store, thumbHtml, thumbUrl, WATCHED_BADGE, watchedPercent, watchUrl,
} from './util.js';
import { createPlayer } from './player.js';
import { autoplay, createToast, createUpNext, onPlayedEnough, setupPlayback, setupShortcuts, setupTheater } from './stage.js';

const { videos } = appData;
const byName = new Map(videos.map((v) => [v.name, v]));
const els = {
  watch: $('watch'), title: $('title'), chips: $('chips'), list: $('list'), count: $('count'),
  search: $('search'), sort: $('sort'), prev: $('prev'), next: $('next'), autoplay: $('autoplay'), delete: $('delete'),
  watched: $('watched'),
};

const player = createPlayer();
const { video } = player;
const toast = createToast();
const upnext = createUpNext({ go, thumbUrl });

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

function load(v, play) {
  upnext.hide();
  toast.hide();
  current = v;
  document.title = `${v.title} · Video Player`;
  renderNow();
  markActive(true);
  player.load(v, neighbor(1));
  if (play) autoplay(player, toast);
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
  renderWatched(current);
}

// ---------- Ditonton (stored on the server, so every device sees it) ----------
function renderWatched(v) {
  if (v === current) {
    els.watched.setAttribute('aria-pressed', String(Boolean(v.watched)));
    els.watched.querySelector('.label').textContent = v.watched ? 'Sudah ditonton' : 'Tandai ditonton';
  }
  const thumb = itemEls.get(v.name)?.querySelector('.thumb');
  const badge = thumb?.querySelector('.watched-badge');
  if (v.watched && thumb && !badge) thumb.insertAdjacentHTML('beforeend', WATCHED_BADGE);
  if (!v.watched) badge?.remove();
}

/** Saves v.watched on the server; shown right away, undone if it fails. */
async function setWatched(v, on) {
  if (Boolean(v.watched) === on) return;
  const before = v.watched;
  v.watched = on ? Math.floor(Date.now() / 1000) : null;
  renderWatched(v);
  try {
    v.watched = (await postApi('watched', { v: v.name, on: on ? 1 : 0 })).watched;
  } catch (err) {
    v.watched = before;
    toast.show(err.message, null, null, true);
  }
  renderWatched(v);
}

let noAutoMark = null; // unmarked by hand: don't mark it again while it keeps playing

function toggleWatched() {
  if (!current) return;
  const on = !current.watched;
  noAutoMark = on ? null : current;
  if (!on) { // "not watched" empties the bar under the thumbnail too
    store.del(seenKey(current));
    store.del(posKey(current));
    updateWatched(current);
  }
  setWatched(current, on);
}

onPlayedEnough(video, {
  current: () => current,
  onWatched: (v) => {
    if (!v.watched && v !== noAutoMark) setWatched(v, true);
  },
});

window.addEventListener('popstate', () => {
  const v = byName.get(new URLSearchParams(location.search).get('v') ?? '');
  if (v && v !== current) load(v, true);
});

setupPlayback(video, { current: () => current, toast, onProgress: updateWatched });
video.addEventListener('loadedmetadata', renderNow);
video.addEventListener('play', () => els.list.classList.remove('paused'));
video.addEventListener('pause', () => els.list.classList.add('paused'));
video.addEventListener('ended', () => {
  const next = neighbor(1);
  if (next && els.autoplay.checked) upnext.show(next);
});

// ---------- Controls below the video ----------
els.prev.addEventListener('click', () => go(neighbor(-1)));
els.next.addEventListener('click', () => go(neighbor(1)));
els.watched.addEventListener('click', toggleWatched);

// Delete the current video, then continue with the next one (or the previous one at the end).
els.delete.addEventListener('click', async () => {
  const doomed = current;
  const wasPlaying = !video.paused;
  video.pause();
  if (!(await deleteWithConfirm(doomed))) {
    if (wasPlaying) video.play().catch(() => {});
    return;
  }
  const following = neighbor(1) ?? neighbor(-1);
  videos.splice(videos.indexOf(doomed), 1);
  byName.delete(doomed.name);
  if (!following) {
    location.href = './';
    return;
  }
  history.replaceState(null, '', watchUrl(following));
  renderList();
  load(following, wasPlaying); // also highlights it in the rebuilt list
});

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

const toggleTheater = setupTheater(els.watch, () => {
  if (current) itemEls.get(current.name)?.scrollIntoView({ block: 'nearest' });
});

setupShortcuts(player, {
  t: toggleTheater,
  n: () => go(neighbor(1)),
  p: () => go(neighbor(-1)),
  '/': () => els.search.focus(),
  w: toggleWatched,
});

// ---------- Init ----------
current = byName.get(appData.current);
renderList();
load(current, true); // opened by clicking a video: start playing
