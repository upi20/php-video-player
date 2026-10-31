// Watch page for a Telegram video: streams it through the tg module (seekable), lists the
// channel's other videos, and saves the current one into the video folder in the background.
import { $, appData, escapeHtml, fmtSize, fmtTime, fmtAgo, store, watchedPercent } from './util.js';
import { createPlayer } from './player.js';
import { createToast, createUpNext, setupPlayback, setupShortcuts, setupTheater } from './stage.js';
import { autoLoadMore, telegramLink, tgApi, tgMeta, tgThumbHtml, tgThumbUrl, tgTitleHtml, tgWatchUrl, toVideo } from './tg.js';

const SAVE_POLL_MS = 1000;
const PLAYING_HTML = '<span class="playing"><span><span class="eq"><i></i><i></i><i></i></span>Diputar</span></span>';

const els = {
  watch: $('watch'), title: $('title'), channel: $('channel'), chips: $('chips'), prev: $('prev'), next: $('next'),
  save: $('save'), openTg: $('open-tg'), autoplay: $('autoplay'), saveStatus: $('save-status'), caption: $('caption'),
  list: $('list'), count: $('count'), more: $('more'),
};

const player = createPlayer();
const { video } = player;
const toast = createToast();
const upnext = createUpNext({ go, thumbUrl: (v) => tgThumbUrl(v.item) });

const { c } = appData;
let channel = null;        // {title, username}
let current = null;        // toVideo(item)
const items = [];          // the channel's videos loaded so far, newest first
let nextOffset = 0;
const itemEls = new Map(); // message id -> playlist <button>

// ---------- Channel playlist ----------
function appendItems(newItems) {
  for (const item of newItems) {
    if (itemEls.has(item.m)) continue;
    items.push(item);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'item';
    btn.title = item.title;
    btn.innerHTML = `
      <div class="thumb">${tgThumbHtml(item)}${PLAYING_HTML}</div>
      <div>
        <div class="item-title">${tgTitleHtml(item)}</div>
        <div class="item-meta">${tgMeta(item)}</div>
      </div>`;
    btn.addEventListener('click', () => go(toVideo(item)));
    itemEls.set(item.m, btn);
    li.append(btn);
    els.list.append(li);
  }
  markActive(false);
}

async function loadMore() {
  els.more.disabled = true;
  let loaded = false;
  try {
    const page = await tgApi(`videos?${new URLSearchParams({ c, offset: nextOffset })}`);
    appendItems(page.items);
    nextOffset = page.next;
    els.more.hidden = !page.next;
    els.count.textContent = `${page.total} video`;
    loaded = true;
  } catch (err) {
    toast.show(err.message, null, null, true);
  } finally {
    els.more.disabled = false;
  }
  if (loaded) autoMore();
}

function markActive(scroll) {
  for (const [m, el] of itemEls) el.classList.toggle('active', m === current?.item.m);
  const active = current && itemEls.get(current.item.m);
  if (active && scroll) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  els.prev.disabled = !neighbor(-1);
  els.next.disabled = !neighbor(1);
}

/** +1 = older (next in the list), -1 = newer. Null when the current video isn't in the loaded list. */
function neighbor(step) {
  if (!current) return null;
  const i = items.findIndex((it) => it.m === current.item.m);
  const item = i < 0 ? null : items[i + step];
  return item ? toVideo(item) : null;
}

function updateWatched(v) {
  const thumb = itemEls.get(v.item.m)?.querySelector('.thumb');
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
  history.pushState(null, '', tgWatchUrl(v.item));
  load(v, true);
}

function load(v, autoplay) {
  upnext.hide();
  toast.hide();
  current = v;
  document.title = `${v.title} · Telegram · Video Player`;
  renderNow();
  markActive(true);
  player.load(v);
  if (autoplay) video.play().catch(() => {});
  pollSave();
}

function renderNow() {
  const item = current.item;
  const height = video.videoHeight || item.height;
  const chips = [
    height ? `${height}p` : null,
    fmtTime(video.duration || item.duration),
    item.size ? fmtSize(item.size) : null,
    item.date ? `diunggah ${fmtAgo(item.date)}` : null,
  ].filter(Boolean);
  els.title.textContent = item.title;
  els.channel.textContent = channel?.title ?? '';
  els.channel.hidden = !channel?.title;
  els.chips.innerHTML = chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('');
  // The title is the caption's first line; show the full caption when there is more.
  const more = item.caption && item.caption.trim() !== item.title;
  els.caption.textContent = more ? item.caption : '';
  els.caption.hidden = !more;
  els.openTg.href = telegramLink(item, channel);
  els.openTg.hidden = false;
  renderSave(item.save ?? { state: 'idle' });
}

window.addEventListener('popstate', async () => {
  const m = Number(new URLSearchParams(location.search).get('m'));
  if (!m || m === current?.item.m) return;
  const item = items.find((it) => it.m === m) ?? (await tgApi(`video?c=${c}&m=${m}`).catch(() => null));
  if (item) load(toVideo(item), true);
});

setupPlayback(video, { current: () => current, toast, onProgress: updateWatched });
video.addEventListener('loadedmetadata', renderNow);
video.addEventListener('play', () => els.list.classList.remove('paused'));
video.addEventListener('pause', () => els.list.classList.add('paused'));
video.addEventListener('ended', () => {
  const next = neighbor(1);
  if (next && els.autoplay.checked) upnext.show(next);
});

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
      item.save = all[`${c}:${item.m}`] ?? { state: 'idle' };
      if (current?.item === item) renderSave(item.save);
      if (item.save.state === 'done') itemEls.get(item.m)?.querySelector('.thumb')?.insertAdjacentHTML('beforeend', '<span class="tg-saved">Tersimpan</span>');
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
    item.save = await tgApi('save', { c, m: item.m });
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
    item.save = await tgApi('save/cancel', { c, m: item.m });
    renderSave(item.save);
    pollSave();
  } catch (err) {
    toast.show(err.message, null, null, true);
  }
});

// ---------- Controls ----------
els.prev.addEventListener('click', () => go(neighbor(-1)));
els.next.addEventListener('click', () => go(neighbor(1)));
const autoMore = autoLoadMore(els.more, loadMore);
els.more.addEventListener('click', loadMore);
els.autoplay.checked = store.get('autoplay', true);
els.autoplay.addEventListener('change', () => store.set('autoplay', els.autoplay.checked));

const toggleTheater = setupTheater(els.watch, () => {
  if (current) itemEls.get(current.item.m)?.scrollIntoView({ block: 'nearest' });
});

setupShortcuts(player, {
  t: toggleTheater,
  n: () => go(neighbor(1)),
  p: () => go(neighbor(-1)),
});

// ---------- Init ----------
(async () => {
  try {
    const item = await tgApi(`video?c=${c}&m=${appData.m}`);
    channel = item.channel;
    els.channel.href = `?page=telegram&c=${c}`;
    load(toVideo(item), false);
  } catch (err) {
    els.title.textContent = err.message;
    return;
  }
  loadMore();
})();
