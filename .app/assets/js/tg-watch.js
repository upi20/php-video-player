// Watch page for a Telegram video: streams it through the tg module (seekable), lists the
// channel's other videos (or, from Favorit, the liked videos of every channel), and saves the
// current one into the video folder in the background.
import { $, appData, escapeHtml, fmtSize, fmtTime, fmtAgo, posKey, seenKey, store, WATCHED_BADGE, watchedPercent } from './util.js';
import { createPlayer } from './player.js';
import { autoplay, createToast, createUpNext, onPlayedEnough, setupPlayback, setupShortcuts, setupTheater } from './stage.js';
import {
  autoLoadMore, LIKED_BADGE, telegramLink, tgApi, tgMeta, tgThumbHtml, tgThumbUrl, tgTitleHtml, tgWatchUrl, toVideo,
} from './tg.js';

const SAVE_POLL_MS = 1000;
const NEWER_AROUND = 10; // newer videos listed above the one opened
const NEWER_PAGE = 40;   // loaded per "Muat video yang lebih baru"
const PLAYING_HTML = '<span class="playing"><span><span class="eq"><i></i><i></i><i></i></span>Diputar</span></span>';

const els = {
  watch: $('watch'), title: $('title'), channel: $('channel'), chips: $('chips'), prev: $('prev'), next: $('next'),
  save: $('save'), like: $('like'), watched: $('watched'), openTg: $('open-tg'), autoplay: $('autoplay'),
  saveStatus: $('save-status'), caption: $('caption'), list: $('list'), count: $('count'), more: $('more'),
};

const player = createPlayer();
const { video } = player;
const toast = createToast();
const upnext = createUpNext({ go, thumbUrl: (v) => tgThumbUrl(v.item) });

const { fav } = appData; // true: the playlist is Favorit, with videos from several channels
let channel = null;        // {title, username} of the channel opened (not used for Favorit)
let current = null;        // toVideo(item)
const items = [];          // the playlist loaded so far
let nextOffset = 0;
let opened = false;        // the first page (around the video opened) is in
const itemEls = new Map(); // "c:m" -> playlist <button>
const keyOf = (item) => `${item.c}:${item.m}`;

// ---------- Playlist ----------
// It opens around the video being played (a few newer ones above it), not at the channel's
// newest: the video may be thousands down. Older ones load at the bottom as you scroll, newer
// ones with the button on top.
const newer = document.createElement('li');
newer.className = 'list-newer';
newer.hidden = true;
newer.innerHTML = '<button class="btn">Muat video yang lebih baru</button>';
els.list.append(newer);
const newerBtn = newer.querySelector('button');
// "Muat lebih banyak" is the list's last item: on wide screens the list scrolls by itself, and
// below it the button would always be in view, loading page after page of a huge channel.
const more = document.createElement('li');
more.className = 'list-more';
more.append(els.more.parentElement);
els.list.append(more);

function appendItems(newItems) {
  const fresh = newItems.filter((item) => !itemEls.has(keyOf(item)));
  items.push(...fresh);
  more.before(...fresh.map(itemLi));
  markActive(false);
}

/** Adds newer videos on top, keeping what's on screen where it is. */
function prependItems(newItems) {
  const fresh = newItems.filter((item) => !itemEls.has(keyOf(item)));
  if (!fresh.length) return;
  const anchor = els.list.querySelector('.item');
  const before = anchor?.getBoundingClientRect().top ?? 0;
  items.unshift(...fresh);
  newer.after(...fresh.map(itemLi));
  if (anchor) {
    const moved = anchor.getBoundingClientRect().top - before;
    if (listScrolls()) els.list.scrollTop += moved;
    else scrollBy(0, moved);
  }
  markActive(false);
}

// The playlist's thumbnails wait until the video can play (or a few seconds): the browser opens
// only 6 connections to the site, and dozens of thumbnails fetched from Telegram at once would
// keep the video's own requests waiting, so it took many seconds to start.
const THUMBS_AFTER_MS = 5000;
let thumbsHeld = true;
function releaseThumbs() {
  if (!thumbsHeld) return;
  thumbsHeld = false;
  for (const img of els.list.querySelectorAll('img[data-held-src]')) {
    img.src = img.dataset.heldSrc;
    img.removeAttribute('data-held-src');
  }
}
video.addEventListener('canplay', releaseThumbs, { once: true });
video.addEventListener('error', releaseThumbs, { once: true });
setTimeout(releaseThumbs, THUMBS_AFTER_MS);

function itemLi(item) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.className = 'item';
  btn.title = item.title;
  const meta = fav && item.channel?.title ? `${escapeHtml(item.channel.title)} · ${tgMeta(item)}` : tgMeta(item);
  const thumb = thumbsHeld ? tgThumbHtml(item).replace('<img src=', '<img data-held-src=') : tgThumbHtml(item);
  btn.innerHTML = `
    <div class="thumb">${thumb}${PLAYING_HTML}</div>
    <div>
      <div class="item-title">${tgTitleHtml(item)}</div>
      <div class="item-meta">${meta}</div>
    </div>`;
  btn.addEventListener('click', () => go(toVideo(item)));
  itemEls.set(keyOf(item), btn);
  li.append(btn);
  return li;
}

async function loadMore() {
  els.more.disabled = true;
  let loaded = false;
  try {
    if (fav) {
      const likes = await tgApi('likes'); // all of them at once: it's a short list
      appendItems(likes);
      els.more.hidden = true;
      els.count.textContent = `${likes.length} video`;
      revealActive(false);
    } else {
      const params = opened
        ? { c: appData.c, offset: nextOffset }
        : { c: appData.c, offset: appData.m, add: -(NEWER_AROUND + 1), limit: NEWER_AROUND + 1 + 40 };
      const page = await tgApi(`videos?${new URLSearchParams(params)}`);
      appendItems(page.items);
      nextOffset = page.next;
      els.more.hidden = !page.next;
      els.count.textContent = `${page.total} video`;
      if (!opened) {
        opened = true;
        // Fewer newer ones than asked for: the list already starts at the channel's newest.
        newer.hidden = page.items.filter((it) => it.m > appData.m).length < NEWER_AROUND;
        revealActive(false);
      }
      loaded = true;
    }
  } catch (err) {
    toast.show(err.message, null, null, true);
  } finally {
    els.more.disabled = false;
  }
  if (loaded) autoMore();
}

async function loadNewer() {
  newerBtn.disabled = true;
  try {
    const page = await tgApi(`videos?${new URLSearchParams({
      c: appData.c, offset: items[0].m, add: -(NEWER_PAGE + 1), limit: NEWER_PAGE,
    })}`);
    prependItems(page.items);
    newer.hidden = !page.items.length;
  } catch (err) {
    toast.show(err.message, null, null, true);
  } finally {
    newerBtn.disabled = false;
  }
}

function markActive(scroll) {
  for (const [key, el] of itemEls) el.classList.toggle('active', Boolean(current) && key === keyOf(current.item));
  if (scroll) revealActive(true);
  els.prev.disabled = !neighbor(-1);
  els.next.disabled = !neighbor(1);
}

// On wide screens the playlist scrolls by itself; on phones it is part of the page.
const listScrolls = () => getComputedStyle(els.list).overflowY !== 'visible';

/**
 * Brings the playing video into view in the playlist: centred when the playlist scrolls by
 * itself. On phones the page only scrolls when switching videos (smooth), not on opening, so
 * the player and title stay in view.
 */
function revealActive(smooth) {
  const active = current && itemEls.get(keyOf(current.item));
  if (!active) return;
  if (listScrolls()) {
    const r = active.getBoundingClientRect();
    const box = els.list.getBoundingClientRect();
    els.list.scrollBy({ top: r.top - box.top - (box.height - r.height) / 2, behavior: smooth ? 'smooth' : 'instant' });
  } else if (smooth) {
    active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/** +1 = next in the list (older), -1 = previous. Null when the current video isn't in the loaded list. */
function neighbor(step) {
  if (!current) return null;
  const i = items.findIndex((it) => keyOf(it) === keyOf(current.item));
  const item = i < 0 ? null : items[i + step];
  return item ? toVideo(item) : null;
}

const thumbOf = (item) => itemEls.get(keyOf(item))?.querySelector('.thumb');

function updateWatched(v) {
  const thumb = thumbOf(v.item);
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
    thumb.append(bar);
  }
  bar.style.width = `${percent}%`;
}

// ---------- Switching videos ----------
function go(v) {
  if (!v || v.name === current?.name) return;
  history.pushState(null, '', tgWatchUrl(v.item, fav));
  load(v, true);
}

function load(v, play) {
  if (current && keyOf(current.item) !== keyOf(v.item)) stopDownload(current.item);
  upnext.hide();
  toast.hide();
  current = v;
  document.title = `${v.title} · Telegram · Video Player`;
  renderNow();
  markActive(true);
  player.load(v, neighbor(1)); // the next one is prepared once this one's analysis is done
  if (play) autoplay(player, toast);
  pollSave();
}

function renderNow() {
  const item = current.item;
  const ch = item.channel ?? channel; // Favorit items carry their own channel
  const height = video.videoHeight || item.height;
  const chips = [
    height ? `${height}p` : null,
    fmtTime(video.duration || item.duration),
    item.size ? fmtSize(item.size) : null,
    item.date ? `diunggah ${fmtAgo(item.date)}` : null,
  ].filter(Boolean);
  els.title.textContent = item.title;
  els.channel.textContent = ch?.title ?? '';
  els.channel.href = `?page=telegram&c=${item.c}`;
  els.channel.hidden = !ch?.title;
  els.chips.innerHTML = chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')
    + (item.dupOf
      ? `<a class="chip dup-chip" href="${tgWatchUrl({ c: item.c, m: item.dupOf })}" title="Buka video aslinya">Duplikat dari #${item.dupOf}</a>`
      : '');
  // The title is the caption's first line; show the full caption when there is more.
  const more = item.caption && item.caption.trim() !== item.title;
  els.caption.textContent = more ? item.caption : '';
  els.caption.hidden = !more;
  els.openTg.href = telegramLink(item, ch);
  els.openTg.hidden = false;
  renderSave(item.save ?? { state: 'idle' });
  renderMarks();
}

window.addEventListener('popstate', async () => {
  const params = new URLSearchParams(location.search);
  const key = `${params.get('c')}:${params.get('m')}`;
  if (!params.get('m') || (current && key === keyOf(current.item))) return;
  const item = items.find((it) => keyOf(it) === key)
    ?? (await tgApi(`video?c=${params.get('c')}&m=${params.get('m')}`).catch(() => null));
  if (item) load(toVideo(item), true);
});

setupPlayback(video, { current: () => current, toast, onProgress: updateWatched, recover: true });
video.addEventListener('loadedmetadata', renderNow);
onPlayedEnough(video, {
  current: () => current,
  onWatched: (v) => {
    if (!v.item.watched && keyOf(v.item) !== noAutoMark) setMark(v.item, 'watched', true);
  },
});
video.addEventListener('play', () => els.list.classList.remove('paused'));
video.addEventListener('pause', () => els.list.classList.add('paused'));
video.addEventListener('ended', () => {
  const next = neighbor(1);
  if (next && els.autoplay.checked) upnext.show(next);
});

// ---------- Background downloads ----------
// The analysis of a video (and the stream of a small one) downloads it whole in the tg module.
// Switching to another video or leaving the page stops the download of the video left behind,
// so it doesn't slow the next one down; only that one, as other tabs may be playing others. A
// video left halfway is fetched again if it is opened again.
function stopDownload(item) {
  fetch('tg/download/cancel', {
    method: 'POST',
    keepalive: true, // still sent while the page is being left
    headers: { 'X-Requested-With': 'video-player' },
    body: new URLSearchParams({ c: item.c, m: item.m }),
  }).then((r) => r.body?.cancel(), () => {}); // unread, it would hold one of the browser's connections
}
window.addEventListener('pagehide', () => {
  if (current) stopDownload(current.item);
});

// ---------- Suka & Ditonton (stored by the tg module, so every device sees them) ----------
const MARKS = {
  liked: { action: 'like', badge: LIKED_BADGE, selector: '.tg-liked' },
  watched: { action: 'watched', badge: WATCHED_BADGE, selector: '.watched-badge' },
};

function renderMarks() {
  const item = current.item;
  els.like.disabled = false;
  els.like.setAttribute('aria-pressed', String(Boolean(item.liked)));
  els.like.querySelector('.label').textContent = item.liked ? 'Disukai' : 'Suka';
  els.watched.disabled = false;
  els.watched.setAttribute('aria-pressed', String(Boolean(item.watched)));
  els.watched.querySelector('.label').textContent = item.watched ? 'Sudah ditonton' : 'Tandai ditonton';
  const thumb = thumbOf(item);
  if (!thumb) return;
  for (const [field, mark] of Object.entries(MARKS)) {
    const badge = thumb.querySelector(mark.selector);
    if (item[field] && !badge) thumb.insertAdjacentHTML('beforeend', mark.badge);
    if (!item[field]) badge?.remove();
  }
}

let noAutoMark = null; // "c:m" unmarked by hand: don't mark it watched again while it keeps playing

/** Sets item.liked or item.watched (field) on the server; shown right away, undone if it fails. */
async function setMark(item, field, on) {
  if (Boolean(item[field]) === on) return;
  // The first video comes from /video, so the playlist has its own copy of it: update both.
  const set = (value) => {
    for (const it of [item, items.find((it) => keyOf(it) === keyOf(item))]) if (it) it[field] = value;
    if (current && keyOf(current.item) === keyOf(item)) renderMarks();
  };
  const before = item[field];
  set(on ? Math.floor(Date.now() / 1000) : null);
  try {
    set((await tgApi(MARKS[field].action, { c: item.c, m: item.m, on: on ? 1 : 0 }))[field]);
  } catch (err) {
    set(before);
    toast.show(err.message, null, null, true);
  }
}

function toggleWatched() {
  if (!current) return;
  const on = !current.item.watched;
  noAutoMark = on ? null : keyOf(current.item);
  if (!on) { // "not watched" empties the bar under the thumbnail too
    store.del(seenKey(current));
    store.del(posKey(current));
    updateWatched(current);
  }
  setMark(current.item, 'watched', on);
}

function toggleLike() {
  if (!current) return;
  const on = !current.item.liked;
  setMark(current.item, 'liked', on);
  toast.show(on ? 'Ditambahkan ke Favorit' : 'Dihapus dari Favorit');
}

// ---------- Simpan ke vid ----------
const SAVE_LABEL = els.save.querySelector('.label');
let saveTimer = null;

function renderSave(s) {
  const box = els.saveStatus;
  const cancel = '<button class="btn ghost" data-save="cancel">Batal</button>';
  els.save.disabled = ['queued', 'running', 'done'].includes(s.state);
  SAVE_LABEL.textContent = { done: 'Tersimpan', failed: 'Coba lagi' }[s.state] ?? 'Simpan ke vid';
  box.hidden = !['queued', 'running', 'done', 'failed'].includes(s.state);
  box.className = `tg-save ${s.state}`;
  switch (s.state) {
    case 'queued':
      box.innerHTML = `<div class="progress indeterminate"><span></span></div><span>Dalam antrean…</span>${cancel}`;
      break;
    case 'running': {
      const speed = s.speed ? ` · ${s.speed.toFixed(1)} Mbit/s` : '';
      box.innerHTML = `<div class="progress"><span style="width:${s.percent ?? 0}%"></span></div>
        <span>Menyimpan ${s.percent ?? 0}%${speed}</span>${cancel}`;
      break;
    }
    case 'done':
      box.innerHTML = `<span>✓ Tersimpan sebagai <strong>${escapeHtml(s.file)}</strong></span>
        <a class="btn" href="?v=${encodeURIComponent(s.file)}">Tonton dari vid</a>`;
      break;
    case 'failed':
      box.innerHTML = `<span>Gagal menyimpan: ${escapeHtml(s.error ?? 'tidak diketahui')}</span>`;
      break;
    default:
      box.innerHTML = '';
  }
}

/** While the current video is queued or being saved, refresh its status every second. */
function pollSave() {
  clearTimeout(saveTimer);
  const item = current?.item;
  if (!item || !['queued', 'running'].includes(item.save?.state)) return;
  saveTimer = setTimeout(async () => {
    try {
      const all = await tgApi('saves');
      item.save = all[keyOf(item)] ?? { state: 'idle' };
      if (current?.item === item) renderSave(item.save);
      if (item.save.state === 'done') thumbOf(item)?.insertAdjacentHTML('beforeend', '<span class="tg-saved">Tersimpan</span>');
    } catch {
      // keep polling; the module may be restarting
    }
    pollSave();
  }, SAVE_POLL_MS);
}

els.save.addEventListener('click', async () => {
  const item = current.item;
  els.save.disabled = true;
  try {
    item.save = await tgApi('save', { c: item.c, m: item.m });
    renderSave(item.save);
    pollSave();
  } catch (err) {
    els.save.disabled = false;
    toast.show(err.message, null, null, true);
  }
});

els.saveStatus.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-save="cancel"]')) return;
  const item = current.item;
  try {
    item.save = await tgApi('save/cancel', { c: item.c, m: item.m });
    renderSave(item.save);
    pollSave();
  } catch (err) {
    toast.show(err.message, null, null, true);
  }
});

// ---------- Controls ----------
els.prev.addEventListener('click', () => go(neighbor(-1)));
els.watched.addEventListener('click', toggleWatched);
els.like.addEventListener('click', toggleLike);
els.next.addEventListener('click', () => go(neighbor(1)));
const autoMore = autoLoadMore(els.more, loadMore, els.list);
els.more.addEventListener('click', loadMore);
newerBtn.addEventListener('click', loadNewer);
els.autoplay.checked = store.get('autoplay', true);
els.autoplay.addEventListener('change', () => store.set('autoplay', els.autoplay.checked));

const toggleTheater = setupTheater(els.watch, () => {
  if (current) itemEls.get(keyOf(current.item))?.scrollIntoView({ block: 'nearest' });
});

setupShortcuts(player, {
  t: toggleTheater,
  n: () => go(neighbor(1)),
  p: () => go(neighbor(-1)),
  w: toggleWatched,
  h: toggleLike,
});

// ---------- Init ----------
(async () => {
  try {
    const item = await tgApi(`video?c=${appData.c}&m=${appData.m}`);
    channel = item.channel;
    load(toVideo(item), true); // opened by clicking a video: start playing
  } catch (err) {
    els.title.textContent = err.message;
    return;
  }
  loadMore();
})();
