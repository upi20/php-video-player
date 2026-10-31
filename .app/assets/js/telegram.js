// Telegram page: setup instructions, login (phone → code → 2FA password), then a grid of the
// videos in the channels you joined.
import { $, confirmDialog, escapeHtml, notice, store } from './util.js';
import { tgApi, tgMeta, tgThumbHtml, tgTitleHtml, tgWatchUrl } from './tg.js';
import { createVirtualGrid } from './vgrid.js';

const panels = { message: $('tg-message'), login: $('tg-login'), browser: $('tg-browser') };
const login = {
  lead: $('tg-login-lead'), form: $('tg-login-form'), label: $('tg-login-label'), input: $('tg-login-input'),
  submit: $('tg-login-submit'), error: $('tg-login-error'),
};
const browser = {
  toolbar: $('tg-toolbar'), pins: $('tg-pins'), channel: $('tg-channel'), pin: $('tg-pin'), pinLabel: $('tg-pin-label'),
  search: $('tg-search'), pager: $('tg-pager'), pageInput: $('tg-page'), pages: $('tg-pages'), count: $('tg-count'),
  account: $('tg-account'), logout: $('tg-logout'), grid: $('tg-grid'), empty: $('tg-empty'),
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
const PAGE = 100;
history.scrollRestoration = 'manual'; // the position comes from the URL instead
const FETCH_DELAY_MS = 150; // wait for fast scrolling to settle before fetching what's on screen
const RETRY_MS = 5000;      // a page that failed to load is tried again after this

const state = {
  channels: [], channel: null, query: '', total: 0,
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
  return `<a class="card" href="${tgWatchUrl(item)}" title="${tgTitleHtml(item)}">
      <div class="thumb">${tgThumbHtml(item)}</div>
      <div class="card-body">
        <h3 class="card-title">${tgTitleHtml(item)}</h3>
        <p class="card-meta">${tgMeta(item)}</p>
      </div>
    </a>`;
}

const grid = createVirtualGrid(browser.grid, {
  renderItem: cardHtml,
  onRange: onRange,
  inset: () => browser.toolbar.getBoundingClientRect().bottom,
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

/** Shows page p in the toolbar and the URL; index is the exact video at the top. */
function setPage(p, index) {
  if (document.activeElement !== browser.pageInput) browser.pageInput.value = String(p + 1);
  browser.pages.textContent = String(pageCount());
  browser.pageInput.max = String(pageCount());
  const url = new URL(location.href);
  url.searchParams.set('page', 'telegram');
  url.searchParams.set('c', String(state.channel));
  if (state.query) url.searchParams.set('q', state.query);
  else url.searchParams.delete('q');
  if (p > 0) url.searchParams.set('p', String(p + 1));
  else url.searchParams.delete('p');
  state.page = p;
  history.replaceState({ index }, '', url);
}

async function loadPage(p) {
  const status = state.pages.get(p);
  if (status === 'loading' || status === 'done' || (typeof status === 'number' && Date.now() - status < RETRY_MS)) return;
  const request = state.request;
  state.pages.set(p, 'loading');
  try {
    const params = new URLSearchParams({ c: state.channel, q: state.query, index: p * PAGE, limit: PAGE });
    const res = await tgApi(`videos?${params}`);
    if (request !== state.request) return;
    res.items.forEach((item, k) => { state.items[p * PAGE + k] = item ?? false; });
    state.pages.set(p, 'done');
    if (res.total !== state.total) {
      state.total = res.total;
      grid.setCount(res.total);
    }
    grid.refresh(p * PAGE, (p + 1) * PAGE);
    browser.count.textContent = `${state.total.toLocaleString('id-ID')} video`;
    browser.empty.hidden = state.total > 0;
    if (!state.total) showEmpty(state.query ? 'Tidak ada video yang cocok di channel ini.' : 'Channel ini belum punya video.');
  } catch (err) {
    if (request !== state.request) return;
    state.pages.set(p, Date.now());
    if (!state.total) {
      browser.count.textContent = '';
      showEmpty(err.message);
    } else {
      notice(err.message, true);
    }
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
  browser.count.textContent = 'Memuat video…';
  const p = Math.floor(index / PAGE);
  await loadPage(p);
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
  browser.count.textContent = 'Memuat channel…';
  try {
    state.channels = await tgApi('channels');
  } catch (err) {
    browser.count.textContent = '';
    showEmpty(err.message);
    return;
  }
  if (!state.channels.length) {
    browser.count.textContent = '';
    browser.channel.hidden = true;
    browser.pin.hidden = true;
    browser.search.hidden = true;
    browser.pager.hidden = true;
    showEmpty('Akun ini belum bergabung ke channel mana pun.');
    return;
  }
  browser.channel.innerHTML = state.channels
    .map((ch) => `<option value="${ch.id}">${escapeHtml(ch.title)}${ch.type === 'supergroup' ? ' (grup)' : ''}</option>`)
    .join('');
  // The URL wins (reload, back, bookmark), then the last channel opened.
  const params = new URLSearchParams(location.search);
  const known = (id) => state.channels.some((ch) => ch.id === id);
  const fromUrl = Number(params.get('c'));
  const remembered = store.get('tg:channel', null);
  state.channel = known(fromUrl) ? fromUrl : known(remembered) ? remembered : state.channels[0].id;
  state.query = params.get('q') ?? '';
  browser.search.value = state.query;
  browser.channel.value = String(state.channel);
  renderPins();
  const page = Math.max(1, Number(params.get('p')) || 1) - 1;
  const exact = history.state?.index;
  openList(Number.isInteger(exact) && Math.floor(exact / PAGE) === page ? exact : page * PAGE);
}

function showEmpty(text) {
  browser.empty.textContent = text;
  browser.empty.hidden = false;
}

// Pinned channels: one button each above the dropdown, plus the star that pins the current one.
function renderPins() {
  const pinned = state.channels.filter((ch) => ch.pinned);
  browser.pins.hidden = !pinned.length;
  browser.pins.innerHTML = pinned
    .map((ch) => `<button class="chip-btn" data-c="${ch.id}" aria-pressed="${ch.id === state.channel}">${escapeHtml(ch.title)}</button>`)
    .join('');
  const current = state.channels.find((ch) => ch.id === state.channel);
  browser.pin.setAttribute('aria-pressed', String(Boolean(current?.pinned)));
  browser.pinLabel.textContent = current?.pinned ? 'Disematkan' : 'Sematkan';
  browser.pin.title = current?.pinned ? 'Hapus tombol channel ini' : 'Jadikan tombol di atas, untuk pindah channel sekali klik';
}

function selectChannel(id) {
  state.channel = id;
  store.set('tg:channel', id);
  browser.channel.value = String(id);
  renderPins();
  openList(0);
}

browser.channel.addEventListener('change', () => selectChannel(Number(browser.channel.value)));

browser.pins.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-c]');
  if (chip && Number(chip.dataset.c) !== state.channel) selectChannel(Number(chip.dataset.c));
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

let searchTimer = null;
browser.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = browser.search.value.trim();
    openList(0);
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
    default:
      showLogin('phone');
  }
}

tgApi('status').then(render, (err) => showMessage(`<h1>Telegram</h1><p class="tg-error">${escapeHtml(err.message)}</p>`));
