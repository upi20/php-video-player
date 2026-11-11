// Telegram page: setup instructions, login (phone → code → 2FA password), then a grid of the
// videos in the channels you joined.
import { $, confirmDialog, escapeHtml, matchesSearch, notice, searchWords, store } from './util.js';
import { HEART_ICON, tgApi, tgMeta, tgThumbHtml, tgTitleHtml, tgWatchUrl } from './tg.js';
import { createVirtualGrid } from './vgrid.js';
import { onPlayedEnough } from './stage.js';

const panels = { message: $('tg-message'), login: $('tg-login'), browser: $('tg-browser') };
const login = {
  lead: $('tg-login-lead'), form: $('tg-login-form'), label: $('tg-login-label'), input: $('tg-login-input'),
  submit: $('tg-login-submit'), error: $('tg-login-error'),
};
const browser = {
  toolbar: $('tg-toolbar'), pins: $('tg-pins'), channel: $('tg-channel'), pin: $('tg-pin'), pinLabel: $('tg-pin-label'),
  search: $('tg-search'), sort: $('tg-sort'), pager: $('tg-pager'), pageInput: $('tg-page'), pages: $('tg-pages'), count: $('tg-count'),
  account: $('tg-account'), logout: $('tg-logout'), grid: $('tg-grid'), empty: $('tg-empty'),
  summary: $('tg-summary'), summaryText: $('tg-summary-text'),
};

function show(panel) {
  for (const [name, el] of Object.entries(panels)) el.hidden = name !== panel;
}

function showMessage(html) {
  panels.message.innerHTML = html;
  show('message');
}

const SETUP_HTML = `
  <h1>Hubungkan Telegram</h1>
  <p class="tg-lead">Modul ini memutar video dari channel yang Anda ikuti, dan bisa menyimpannya ke folder video. Sekali saja, siapkan dulu kredensial aplikasinya:</p>
  <ol class="tg-steps">
    <li>Buka <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer">my.telegram.org</a>, login dengan nomor Telegram Anda, lalu pilih <strong>API development tools</strong>.</li>
    <li>Buat aplikasi (nama dan isian lainnya bebas). Salin <strong>api_id</strong> dan <strong>api_hash</strong>.</li>
    <li>Di folder <code>~/.vid</code>, salin <code>.env.example</code> menjadi <code>.env</code>, lalu isi <code>TG_API_ID</code> dan <code>TG_API_HASH</code>.</li>
    <li>Jalankan <code>docker compose up -d</code> di folder itu, lalu muat ulang halaman ini.</li>
  </ol>
  <p class="tg-note">Jangan bagikan isi <code>.env</code>. File itu sudah otomatis diabaikan git dan tidak bisa dibuka dari browser.</p>`;

// ---------- Login ----------
const LOGIN_STEPS = {
  phone: {
    field: 'phone',
    lead: 'Masukkan nomor HP akun Telegram Anda, lengkap dengan kode negara.',
    label: 'Nomor HP',
    attrs: { type: 'tel', placeholder: '+62812xxxxxxx', autocomplete: 'tel', inputMode: 'tel' },
  },
  code: {
    field: 'code',
    lead: 'Telegram sudah mengirim kode login ke aplikasi Telegram Anda (biasanya bukan lewat SMS). Masukkan kodenya di sini.',
    label: 'Kode login',
    attrs: { type: 'text', placeholder: '12345', autocomplete: 'one-time-code', inputMode: 'numeric' },
  },
  password: {
    field: 'password',
    lead: 'Akun ini memakai verifikasi 2 langkah. Masukkan kata sandi cloud Telegram Anda.',
    label: 'Kata sandi',
    attrs: { type: 'password', placeholder: '', autocomplete: 'current-password', inputMode: 'text' },
  },
};

let loginStep = 'phone';

function showLogin(step) {
  loginStep = step;
  const s = LOGIN_STEPS[step];
  login.lead.textContent = s.lead;
  login.label.textContent = s.label;
  Object.assign(login.input, s.attrs, { value: '' });
  login.error.hidden = true;
  login.submit.disabled = false;
  show('login');
  login.input.focus();
}

login.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  login.submit.disabled = true;
  login.error.hidden = true;
  try {
    render(await tgApi(`login/${loginStep}`, { [LOGIN_STEPS[loginStep].field]: login.input.value }));
  } catch (err) {
    login.error.textContent = err.message;
    login.error.hidden = false;
    login.submit.disabled = false;
  }
});

// ---------- Browsing ----------
// The grid is virtual (vgrid.js): only the cards near the screen exist, and videos are fetched
// 100 at a time by position, so a channel with thousands of videos stays light and any page can
// be opened directly. The URL follows along (?c=…&q=…&p=<page>), so reloading, going back from
// a video or a bookmark lands on the same page; history.state keeps the exact video.
// Favorit (?fav=1) is the liked videos of every channel, loaded all at once and searched here.
const PAGE = 100;
history.scrollRestoration = 'manual'; // the position comes from the URL instead
const FETCH_DELAY_MS = 150; // wait for fast scrolling to settle before fetching what's on screen
const RETRY_MS = 5000;      // a page that failed to load is tried again after this

const state = {
  channels: [], channel: null, fav: false, query: '', total: 0,
  sort: 'new', seed: 0, // the list's order (?s=), from the tg module's index; "new" is Telegram's own
  items: [],          // index → video, false when unplayable, undefined while not loaded
  pages: new Map(),   // page → 'loading' | 'done' | time of the failure
  request: 0,         // bumped on every channel/search change, to drop older answers
  page: 0,            // page shown in the URL (0-based)
};

const SKELETON = `<div class="card tg-skeleton" aria-hidden="true">
    <div class="thumb"></div>
    <div class="card-body"><h3 class="card-title"></h3><p class="card-meta"></p></div>
  </div>`;

function cardHtml(index) {
  const item = state.items[index];
  if (item === undefined) return SKELETON;
  if (item === false) {
    return `<div class="card tg-unavailable"><div class="thumb"></div>
      <div class="card-body"><h3 class="card-title">Video tidak bisa diputar</h3><p class="card-meta">&nbsp;</p></div></div>`;
  }
  const meta = state.fav && item.channel?.title ? `${escapeHtml(item.channel.title)} · ${tgMeta(item)}` : tgMeta(item);
  return `<a class="card" href="${tgWatchUrl(item, state.fav)}${watchSortSuffix()}" title="${tgTitleHtml(item)}">
      <div class="thumb">${tgThumbHtml(item)}</div>
      <div class="card-body">
        <h3 class="card-title">${tgTitleHtml(item)}</h3>
        <p class="card-meta">${meta}</p>
      </div>
    </a>
    <button class="tg-card-like" aria-pressed="${Boolean(item.liked)}" title="${item.liked ? 'Hapus dari Favorit' : 'Suka: masukkan ke Favorit'}"
      aria-label="${item.liked ? 'Hapus dari Favorit' : 'Suka'}">${HEART_ICON}</button>
    <button class="tg-card-peek" title="Intip di sini (N/P: video lain, W: selesai, Esc: tutup)" aria-label="Intip">${PEEK_ICON}</button>
    <button class="tg-card-tab" title="Tonton di tab baru (W di sana: selesai & tutup tab)" aria-label="Tonton di tab baru">${NEW_TAB_ICON}</button>`;
}

const PEEK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const NEW_TAB_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

const grid = createVirtualGrid(browser.grid, {
  renderItem: cardHtml,
  onRange: onRange,
  inset: () => browser.toolbar.getBoundingClientRect().bottom,
});

// Open a card's video in a new tab, in tab mode (&tab=1): there, W (or Esc, Q, Backspace) closes
// it again. Opened by script, as browsers only let a page close a tab that a script opened.
browser.grid.addEventListener('click', (e) => {
  const btn = e.target.closest('.tg-card-tab');
  if (!btn) return;
  e.preventDefault();
  const item = state.items[Number(btn.closest('.card-wrap').dataset.index)];
  if (item) window.open(`${tgWatchUrl(item, state.fav)}${watchSortSuffix()}&tab=1`, '_blank');
});

// ---------- Peek: a quick look in a modal, without leaving the grid ----------
// The browser's own <video>, streamed directly (no whole download, no analysis): cheap on the
// connection. Closing it stops the stream.
const peek = {
  dialog: $('peek'), video: $('peek-video'), title: $('peek-title'), meta: $('peek-meta'), open: $('peek-open'),
  save: $('peek-save'), index: -1,
};

function openPeek(index) {
  const item = state.items[index];
  if (!item) return;
  peek.index = index;
  peek.title.textContent = item.title;
  peek.meta.innerHTML = tgMeta(item);
  peek.open.href = tgWatchUrl(item, state.fav) + watchSortSuffix();
  peek.video.src = `tg/stream/${item.c}/${item.m}?whole=0`;
  if (!peek.dialog.open) peek.dialog.showModal();
  peek.video.play().catch(() => {});
  renderPeekSave();
  pollPeekSave();
}

// Simpan: queued in the tg module, which downloads in the background (it goes on after the modal
// is closed). While the modal shows that video, its progress is shown on the button.
const SAVE_LABELS = { queued: 'Antre…', done: 'Tersimpan', failed: 'Coba lagi' };
let peekSaveTimer = 0;

function renderPeekSave() {
  const s = state.items[peek.index]?.save ?? { state: 'idle' };
  peek.save.disabled = ['queued', 'running', 'done'].includes(s.state);
  peek.save.querySelector('.label').textContent = s.state === 'running'
    ? `Menyimpan ${Math.round(s.percent ?? 0)}%`
    : SAVE_LABELS[s.state] ?? 'Simpan';
}

function pollPeekSave() {
  clearTimeout(peekSaveTimer);
  const index = peek.index;
  const item = state.items[index];
  if (!peek.dialog.open || !['queued', 'running'].includes(item?.save?.state)) return;
  peekSaveTimer = setTimeout(async () => {
    const all = await tgApi('saves').catch(() => null);
    if (all) item.save = all[`${item.c}:${item.m}`] ?? item.save;
    if (item.save.state === 'done') grid.refresh(index, index + 1); // the card's "Tersimpan" badge
    if (peek.index === index) renderPeekSave();
    pollPeekSave();
  }, 1000);
}

peek.save.addEventListener('click', async () => {
  const index = peek.index;
  const item = state.items[index];
  if (!item) return;
  peek.save.disabled = true;
  try {
    item.save = await tgApi('save', { c: item.c, m: item.m });
  } catch (err) {
    notice(err.message, true);
  }
  if (peek.index === index) renderPeekSave();
  pollPeekSave();
});

/** Next/previous card in the grid's order (step = 1 / -1), loading its page when needed. */
async function stepPeek(step) {
  const i = peek.index + step;
  if (i < 0 || i >= state.total) return;
  if (state.items[i] === undefined) await loadPage(Math.floor(i / PAGE));
  if (state.items[i]) openPeek(i);
  else peek.index = i; // not playable: skipped on the next press
  grid.scrollToIndex(i);
}

async function markPeekWatched() {
  const item = state.items[peek.index];
  if (!item || item.watched) return;
  item.watched = Math.floor(Date.now() / 1000);
  grid.refresh(peek.index, peek.index + 1);
  await tgApi('watched', { c: item.c, m: item.m, on: 1 }).catch(() => {});
}

browser.grid.addEventListener('click', (e) => {
  const btn = e.target.closest('.tg-card-peek');
  if (!btn) return;
  e.preventDefault();
  openPeek(Number(btn.closest('.card-wrap').dataset.index));
});
$('peek-close').addEventListener('click', () => peek.dialog.close());
peek.dialog.addEventListener('click', (e) => { if (e.target === peek.dialog) peek.dialog.close(); }); // the backdrop
peek.dialog.addEventListener('close', () => {
  clearTimeout(peekSaveTimer); // only the display stops: the download goes on
  peek.video.pause();
  peek.video.removeAttribute('src');
  peek.video.load(); // drops the connection
});
onPlayedEnough(peek.video, { current: () => (peek.dialog.open ? peek : null), onWatched: markPeekWatched });
peek.dialog.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const actions = {
    q: () => peek.dialog.close(),
    Backspace: () => peek.dialog.close(),
    n: () => stepPeek(1),
    p: () => stepPeek(-1),
    w: () => markPeekWatched().then(() => peek.dialog.close()),
    Enter: () => location.assign(peek.open.href),
  };
  const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!action) return;
  e.preventDefault();
  action();
});

// ❤ on a card: like/unlike without opening the video (in Favorit the card stays until reload).
browser.grid.addEventListener('click', async (e) => {
  const btn = e.target.closest('.tg-card-like');
  if (!btn) return;
  e.preventDefault();
  const index = Number(btn.closest('.card-wrap').dataset.index);
  const item = state.items[index];
  if (!item) return;
  const before = item.liked;
  const on = !before;
  item.liked = on ? Math.floor(Date.now() / 1000) : null; // show it right away
  grid.refresh(index, index + 1);
  try {
    item.liked = (await tgApi('like', { c: item.c, m: item.m, on: on ? 1 : 0 })).liked;
  } catch (err) {
    item.liked = before;
    notice(err.message, true);
  }
  if (state.items[index] === item) grid.refresh(index, index + 1);
});

let fetchTimer = null;
function onRange({ start, end, first }) {
  if (!state.total) return;
  setPage(Math.floor(first / PAGE), first);
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => {
    for (let p = Math.floor(start / PAGE); p <= Math.floor((end - 1) / PAGE); p++) loadPage(p);
  }, FETCH_DELAY_MS);
}

const pageCount = () => Math.max(1, Math.ceil(state.total / PAGE));

// ---------- Phones: the filters fold into one summary line ----------
// Tapping the line drops them down over the grid; scrolling, picking a channel or tapping
// elsewhere folds them again (not while typing in them). Wider screens always show them (CSS).
const FOLD_AFTER_PX = 40; // scrolled this far since opening → fold
let openedAt = 0;

function setFiltersOpen(open) {
  browser.toolbar.classList.toggle('open', open);
  browser.summary.setAttribute('aria-expanded', String(open));
  openedAt = scrollY;
}

function setCount(text) {
  browser.count.textContent = text;
  renderSummary();
}

function renderSummary() {
  const name = state.fav ? '❤ Favorit' : (state.channels.find((ch) => ch.id === state.channel)?.title ?? 'Telegram');
  const parts = [name];
  if (sorted()) parts.push(browser.sort.selectedOptions[0]?.textContent ?? '');
  if (state.query) parts.push(`“${state.query}”`);
  if (browser.count.textContent) parts.push(browser.count.textContent);
  if (state.total > PAGE) parts.push(`Hal. ${state.page + 1}/${pageCount()}`);
  browser.summaryText.textContent = parts.join(' · ');
}

browser.summary.addEventListener('click', () => setFiltersOpen(!browser.toolbar.classList.contains('open')));

addEventListener('scroll', () => {
  if (!browser.toolbar.classList.contains('open') || browser.toolbar.contains(document.activeElement)) return;
  if (Math.abs(scrollY - openedAt) > FOLD_AFTER_PX) setFiltersOpen(false);
}, { passive: true });

document.addEventListener('pointerdown', (e) => {
  if (browser.toolbar.classList.contains('open') && !browser.toolbar.contains(e.target)) setFiltersOpen(false);
});

/** Shows page p in the toolbar and the URL; index is the exact video at the top. */
function setPage(p, index) {
  if (document.activeElement !== browser.pageInput) browser.pageInput.value = String(p + 1);
  browser.pages.textContent = String(pageCount());
  browser.pageInput.max = String(pageCount());
  const url = new URL(location.href);
  url.searchParams.set('page', 'telegram');
  if (state.fav) {
    url.searchParams.set('fav', '1');
    url.searchParams.delete('c');
  } else {
    url.searchParams.set('c', String(state.channel));
    url.searchParams.delete('fav');
  }
  if (state.query) url.searchParams.set('q', state.query);
  else url.searchParams.delete('q');
  url.searchParams.delete('s');
  url.searchParams.delete('seed');
  for (const [key, value] of Object.entries(sortQuery('s'))) url.searchParams.set(key, value);
  if (p > 0) url.searchParams.set('p', String(p + 1));
  else url.searchParams.delete('p');
  state.page = p;
  history.replaceState({ index }, '', url);
  renderSummary();
}

async function loadPage(p) {
  if (state.fav) return; // Favorit is loaded whole by loadFavorites()
  const status = state.pages.get(p);
  if (status === 'loading' || status === 'done' || (typeof status === 'number' && Date.now() - status < RETRY_MS)) return;
  const request = state.request;
  state.pages.set(p, 'loading');
  try {
    const params = new URLSearchParams({ c: state.channel, q: state.query, index: p * PAGE, limit: PAGE, ...sortQuery() });
    const res = await tgApi(`videos?${params}`);
    if (request !== state.request) return;
    res.items.forEach((item, k) => { state.items[p * PAGE + k] = item ?? false; });
    state.pages.set(p, 'done');
    if (res.total !== state.total) {
      state.total = res.total;
      grid.setCount(res.total);
    }
    grid.refresh(p * PAGE, (p + 1) * PAGE);
    setCount(`${state.total.toLocaleString('id-ID')} video`);
    browser.empty.hidden = state.total > 0;
    if (!state.total) showEmpty(state.query ? 'Tidak ada video yang cocok di channel ini.' : 'Channel ini belum punya video.');
  } catch (err) {
    if (request !== state.request) return;
    state.pages.set(p, Date.now());
    if (!state.total) {
      setCount('');
      showEmpty(err.message);
    } else {
      notice(err.message, true);
    }
  }
}

/** Fills the grid with Favorit (filtered by the search box); keeps the cards in place. */
async function loadFavorites() {
  const request = state.request;
  let likes;
  try {
    likes = await tgApi('likes');
  } catch (err) {
    if (request !== state.request) return;
    setCount('');
    showEmpty(err.message);
    return;
  }
  if (request !== state.request) return;
  const words = searchWords(state.query);
  state.items = likes.filter((item) => matchesSearch({ title: `${item.title} ${item.caption} ${item.file ?? ''} ${item.channel?.title ?? ''}` }, words));
  state.total = state.items.length;
  grid.setCount(state.total);
  grid.refresh(0, state.total);
  setCount(`${state.total.toLocaleString('id-ID')} video`);
  browser.empty.hidden = state.total > 0;
  if (!state.total) {
    showEmpty(state.query ? 'Tidak ada video favorit yang cocok.' : 'Belum ada video favorit. Tekan ❤ Suka saat menonton untuk menambahkannya.');
  }
}

/** Opens the current channel/search, at index (the top video) when given. */
async function openList(index = 0) {
  state.request++;
  state.items = [];
  state.pages = new Map();
  state.total = 0;
  grid.clear();
  scrollTo({ top: 0, behavior: 'instant' });
  browser.empty.hidden = true;
  // The first search in a channel fetches its whole video list on the server (see search() in server.php).
  setCount((state.query || sorted()) && !state.fav ? 'Memuat… (pertama kali di channel ini bisa ±30 detik)' : 'Memuat video…');
  const p = Math.floor(index / PAGE);
  await (state.fav ? loadFavorites() : loadPage(p));
  if (!state.total) return;
  if (p * PAGE >= state.total) { // the URL pointed past the end: go to the last page
    openList((pageCount() - 1) * PAGE);
    return;
  }
  grid.scrollToIndex(index);
  setPage(p, index);
}

async function showBrowser(me) {
  show('browser');
  browser.account.textContent = me?.username ? `@${me.username}` : (me?.name ?? '');
  browser.empty.hidden = true;
  setCount('Memuat channel…');
  try {
    state.channels = await tgApi('channels');
  } catch (err) {
    setCount('');
    showEmpty(err.message);
    return;
  }
  if (!state.channels.length) {
    setCount('');
    browser.channel.hidden = true;
    browser.pin.hidden = true;
    browser.search.hidden = true;
    browser.pager.hidden = true;
    showEmpty('Akun ini belum bergabung ke channel mana pun.');
    return;
  }
  // The hidden first option is what the dropdown shows while Favorit is open.
  browser.channel.innerHTML = '<option value="" hidden>Favorit (semua channel)</option>' + state.channels
    .map((ch) => `<option value="${ch.id}">${escapeHtml(ch.title)}${ch.type === 'supergroup' ? ' (grup)' : ''}</option>`)
    .join('');
  // The URL wins (reload, back, bookmark), then the last channel opened.
  const params = new URLSearchParams(location.search);
  const known = (id) => state.channels.some((ch) => ch.id === id);
  const fromUrl = Number(params.get('c'));
  const remembered = store.get('tg:channel', null);
  state.channel = known(fromUrl) ? fromUrl : known(remembered) ? remembered : state.channels[0].id;
  state.fav = params.get('fav') === '1';
  restoreSort(params);
  state.query = params.get('q') ?? '';
  browser.search.value = state.query;
  browser.channel.value = String(state.channel);
  renderPins();
  const page = Math.max(1, Number(params.get('p')) || 1) - 1;
  const exact = history.state?.index;
  if (Number.isInteger(exact) && Math.floor(exact / PAGE) === page) openList(exact); // back, reload
  else if (params.has('p')) openList(page * PAGE); // a link to a page
  else openList(rememberedScroll()).then(showFocus); // just the channel: where you were in it
}

function showEmpty(text) {
  browser.empty.textContent = text;
  browser.empty.hidden = false;
}

// Favorit and the pinned channels: one button each above the dropdown, plus the star that pins
// the current channel.
function renderPins() {
  const pinned = state.channels.filter((ch) => ch.pinned);
  browser.pins.hidden = false;
  browser.pins.innerHTML = `<button class="chip-btn tg-fav-chip" data-fav aria-pressed="${state.fav}">Favorit</button>`
    + pinned
      .map((ch) => `<button class="chip-btn" data-c="${ch.id}" aria-pressed="${!state.fav && ch.id === state.channel}">${escapeHtml(ch.title)}</button>`)
      .join('');
  browser.channel.value = state.fav ? '' : String(state.channel);
  browser.search.placeholder = state.fav ? 'Cari di Favorit…' : 'Cari di channel ini…';
  browser.pin.hidden = state.fav; // the star pins a channel; Favorit is always there
  browser.sort.hidden = state.fav; // Favorit keeps the order you liked them in
  browser.sort.value = state.sort;
  const current = state.channels.find((ch) => ch.id === state.channel);
  browser.pin.setAttribute('aria-pressed', String(Boolean(current?.pinned)));
  browser.pinLabel.textContent = current?.pinned ? 'Disematkan' : 'Sematkan';
  browser.pin.title = current?.pinned ? 'Hapus tombol channel ini' : 'Jadikan tombol di atas, untuk pindah channel sekali klik';
  renderSummary();
}

// Each channel (and Favorit) remembers the video at the top of the screen, on this device:
// switching away and back lands where you were, not at the newest again. Not for search results.
const scrollKey = () => `tg:scroll:${state.fav ? 'fav' : state.channel}${sorted() ? `:${state.sort}` : ''}`;

function rememberScroll() {
  if (!state.query && state.total) store.set(scrollKey(), grid.firstVisible());
}

const rememberedScroll = () => (state.query ? 0 : store.get(scrollKey(), 0));

addEventListener('pagehide', rememberScroll);

function selectChannel(id) {
  setFiltersOpen(false);
  rememberScroll();
  state.fav = false;
  state.channel = id;
  restoreSort(null);
  store.set('tg:channel', id);
  browser.channel.value = String(id);
  renderPins();
  openList(rememberedScroll());
}

// ---------- Order of the list (per channel, on this device; also in the URL as ?s=) ----------
const sorted = () => !state.fav && state.sort !== 'new';

/** The order as query parameters (sort/seed for the tg module, s/seed in page URLs), or none. */
function sortQuery(name = 'sort') {
  if (!sorted()) return {};
  return state.sort === 'random' ? { [name]: state.sort, seed: state.seed } : { [name]: state.sort };
}

/** For links to a watch page: its playlist and "next" follow this order. */
const watchSortSuffix = () => Object.entries(sortQuery('s')).map(([k, v]) => `&${k}=${v}`).join('');

/** From the URL when it says (reload, back, a link), else this channel's last choice. */
function restoreSort(params) {
  const saved = store.get(`tg:sort:${state.channel}`, { sort: 'new', seed: 0 });
  state.sort = params?.get('s') ?? saved.sort;
  state.seed = Number(params?.get('seed') ?? saved.seed) || 0;
  if (!browser.sort.querySelector(`option[value="${state.sort}"]`)) state.sort = 'new';
  browser.sort.value = state.sort;
}

browser.sort.addEventListener('change', () => {
  rememberScroll();
  state.sort = browser.sort.value;
  if (state.sort === 'random') state.seed = Math.floor(Math.random() * 1e9); // a new shuffle each time it's picked
  store.set(`tg:sort:${state.channel}`, { sort: state.sort, seed: state.seed });
  browser.sort.blur();
  setFiltersOpen(false);
  openList(rememberedScroll());
});

browser.channel.addEventListener('change', () => {
  browser.channel.blur(); // the focus would keep the filters open
  selectChannel(Number(browser.channel.value));
});

browser.pins.addEventListener('click', (e) => {
  if (e.target.closest('[data-fav]')) {
    setFiltersOpen(false);
    if (state.fav) return;
    rememberScroll();
    state.fav = true;
    renderPins();
    openList(rememberedScroll());
    return;
  }
  const chip = e.target.closest('[data-c]');
  if (chip && (state.fav || Number(chip.dataset.c) !== state.channel)) selectChannel(Number(chip.dataset.c));
});

browser.pin.addEventListener('click', async () => {
  const current = state.channels.find((ch) => ch.id === state.channel);
  if (!current) return;
  browser.pin.disabled = true;
  try {
    state.channels = await tgApi('pin', { c: current.id, on: current.pinned ? 0 : 1 });
    renderPins();
  } catch (err) {
    notice(err.message, true);
  } finally {
    browser.pin.disabled = false;
  }
});

// Coming back from a video can restore this page from the back/forward cache, with the cards as
// they were: fetch the pages again so newly watched videos get their badge.
addEventListener('pageshow', async (e) => {
  if (!e.persisted || !state.total) return;
  if (state.fav) {
    await loadFavorites();
  } else {
    state.pages = new Map();
    onRange({ start: grid.firstVisible(), end: grid.firstVisible() + 1, first: grid.firstVisible() });
  }
  showFocus();
});

/**
 * Back from a watch page: scroll to the video it left in focus (tg-watch.js: the one at the top
 * of its playlist when that was scrolled, else the one played last), if it is in this list.
 */
async function showFocus() {
  const focus = store.get('tg:focus', null);
  store.del('tg:focus');
  if (!focus || state.query || Boolean(focus.fav) !== state.fav || (!state.fav && focus.c !== state.channel)) return;
  let index = -1;
  if (state.fav) {
    index = state.items.findIndex((it) => it && it.c === focus.c && it.m === focus.m);
  } else {
    const known = state.items.findIndex((it) => it && it.m === focus.m); // already on a loaded page
    const query = new URLSearchParams({ c: focus.c, m: focus.m, ...sortQuery() });
    index = known >= 0 ? known : ((await tgApi(`position?${query}`).catch(() => null))?.index ?? -1);
  }
  if (index >= 0 && index < state.total) grid.scrollToIndex(index);
}

let searchTimer = null;
browser.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!state.query) rememberScroll(); // where you were before searching, for when it's cleared
    state.query = browser.search.value.trim();
    openList(rememberedScroll());
  }, 400);
});

// Page box: type a page number and press Enter (or leave the box) to jump there.
browser.pager.addEventListener('submit', (e) => {
  e.preventDefault();
  const p = Math.min(pageCount(), Math.max(1, Math.round(Number(browser.pageInput.value)) || 1)) - 1;
  browser.pageInput.blur();
  grid.scrollToIndex(p * PAGE);
});
browser.pageInput.addEventListener('change', () => browser.pager.requestSubmit());

browser.logout.addEventListener('click', async () => {
  const confirmed = await confirmDialog({
    title: 'Keluar dari Telegram?',
    message: 'Sesi login di aplikasi ini akan dihapus. Untuk memakai modul Telegram lagi, Anda perlu login ulang dengan kode.',
    confirmLabel: 'Keluar',
  });
  if (!confirmed) return;
  try {
    render(await tgApi('logout', {}));
  } catch (err) {
    showEmpty(err.message);
  }
});

// The "broken" page's button: logging out resets a session Telegram has ended (server.php, logout()).
panels.message.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reset-session]');
  if (!btn) return;
  btn.disabled = true;
  try {
    render(await tgApi('logout', {}));
  } catch (err) {
    btn.disabled = false;
    notice(err.message, true);
  }
});

// ---------- State machine ----------
function render(status) {
  switch (status.state) {
    case 'unconfigured':
      showMessage(SETUP_HTML);
      break;
    case 'code':
    case 'password':
      showLogin(status.state);
      break;
    case 'signup':
      showMessage('<h1>Nomor belum terdaftar</h1><p class="tg-lead">Nomor ini belum punya akun Telegram. Daftar dulu lewat aplikasi Telegram, lalu muat ulang halaman ini.</p>');
      break;
    case 'ready':
      showBrowser(status.me);
      break;
    case 'broken':
      showMessage(`<h1>Sesi Telegram terputus</h1>
        <p class="tg-lead">Telegram memutus sesi login ini, biasanya karena sesi yang sama dipakai di dua tempat
          sekaligus (misalnya backup yang dijalankan di laptop lain). Sesi seperti ini tidak bisa dipakai lagi:
          reset, lalu login ulang. Favorit, tanda ditonton, dan channel yang disematkan tidak hilang.</p>
        <p><button class="btn primary" type="button" data-reset-session>Reset sesi &amp; login ulang</button></p>
        <p class="tg-note">Detail: ${escapeHtml(status.error ?? '')}</p>`);
      break;
    case 'restarting':
      showMessage('<h1>Menyiapkan login ulang…</h1><p class="tg-lead">Modul Telegram dimulai ulang tanpa sesi lama. Tunggu beberapa detik.</p>');
      // tgApi waits while the module restarts (502/503), then the login form appears
      setTimeout(() => tgApi('status').then(render, (err) => showMessage(`<h1>Telegram</h1><p class="tg-error">${escapeHtml(err.message)}</p>`)), 3000);
      break;
    default:
      showLogin('phone');
  }
}

tgApi('status').then(render, (err) => showMessage(`<h1>Telegram</h1><p class="tg-error">${escapeHtml(err.message)}</p>`));
