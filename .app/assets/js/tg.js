// Talking to the Telegram module (the "tg" container, which Apache proxies under /tg/).
import { escapeHtml, fmtAgo, fmtSize, fmtTime, watchedPercent } from './util.js';

// Telegram's error codes (from MTProto), in plain language.
const ERRORS = {
  PHONE_NUMBER_INVALID: 'Nomor HP tidak valid. Pakai format internasional, misalnya +62812xxxxxxx.',
  PHONE_NUMBER_BANNED: 'Nomor ini diblokir oleh Telegram.',
  PHONE_CODE_INVALID: 'Kode login salah. Periksa lagi kode dari aplikasi Telegram.',
  PHONE_CODE_EXPIRED: 'Kode login sudah kedaluwarsa. Muat ulang halaman dan minta kode baru.',
  PHONE_CODE_EMPTY: 'Kode login belum diisi.',
  PASSWORD_HASH_INVALID: 'Kata sandi verifikasi 2 langkah salah.',
  CHANNEL_PRIVATE: 'Channel ini privat atau Anda sudah keluar dari channel ini.',
  CHANNEL_INVALID: 'Channel tidak ditemukan.',
  MSG_ID_INVALID: 'Video tidak ditemukan di channel ini.',
  AUTH_KEY_UNREGISTERED: 'Sesi login tidak berlaku lagi. Silakan login ulang.',
};

export function friendlyError(code) {
  const wait = String(code ?? '').match(/^FLOOD_WAIT_(\d+)/);
  if (wait) return `Terlalu banyak permintaan ke Telegram. Coba lagi dalam ${wait[1]} detik.`;
  return ERRORS[code] ?? code ?? 'Terjadi kesalahan';
}

/** GET tg/<path>, or POST when a body is given. Throws an Error with a readable message. */
export async function tgApi(path, body) {
  let res;
  try {
    res = await fetch(`tg/${path}`, body
      ? { method: 'POST', headers: { 'X-Requested-With': 'video-player' }, body: new URLSearchParams(body) }
      : { cache: 'no-store' });
  } catch {
    throw new Error('Tidak bisa terhubung ke server.');
  }
  const data = await res.json().catch(() => null);
  // Apache answers with an HTML error page when the tg container isn't running.
  if (data === null) throw new Error('Modul Telegram tidak berjalan. Jalankan "docker compose up -d" di folder ~/.vid.');
  if (!res.ok) throw new Error(friendlyError(data.error));
  return data;
}

// Loads the next page by itself once the "Muat lebih banyak" button comes near the screen, so
// the list keeps going as you scroll. The button stays for clicking after a failed load.
// Call the returned function after each successful load: if the new page didn't fill the
// screen, the button is still near and the observer won't fire again on its own.
const AUTO_MORE_MARGIN = 800; // px before the button is actually visible

export function autoLoadMore(button, load) {
  const check = () => {
    if (button.hidden || button.disabled) return;
    const r = button.getBoundingClientRect();
    if (r.top < innerHeight + AUTO_MORE_MARGIN && r.bottom > -AUTO_MORE_MARGIN) load();
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(check, { rootMargin: `${AUTO_MORE_MARGIN}px 0px` }).observe(button);
  }
  return check;
}

// ---------- URLs ----------
// Videos uploaded without a thumbnail get their first frame, made by the player's ffmpeg.
export const tgThumbUrl = (item) => (item.thumb
  ? `tg/thumb/${item.c}/${item.m}`
  : `?api=thumb&tg=${item.c}_${item.m}&k=${item.size ?? 0}`);
export const tgStreamUrl = (item) => `tg/stream/${item.c}/${item.m}`;
export const tgWatchUrl = (item) => `?page=tg-watch&c=${item.c}&m=${item.m}`;

/** t.me link to the message: by username for public channels, by id otherwise. */
export function telegramLink(item, channel) {
  if (channel?.username) return `https://t.me/${channel.username}/${item.m}`;
  return `https://t.me/c/${String(item.c).replace(/^-100/, '')}/${item.m}`;
}

// Bigger videos aren't analysed (loudness map, hover previews) while streaming: the server would
// have to download all of it first. Same limit as TG_ANALYSE_MAX_BYTES in tganalysis.php.
const ANALYSE_MAX_BYTES = 300 * 1024 * 1024;

/**
 * A Telegram video in the shape the player and stage.js expect. `name` is unique so resume
 * positions work; `api` and `key` address its loudness map and previews (?api=…&tg=…);
 * `remote` tells the seek bar it is too big to have them.
 */
export function toVideo(item) {
  return {
    name: `tg:${item.c}:${item.m}`,
    title: item.title,
    url: tgStreamUrl(item),
    duration: item.duration,
    height: item.height,
    api: `tg=${item.c}_${item.m}`,
    key: String(item.size ?? 0),
    remote: (item.size ?? 0) > ANALYSE_MAX_BYTES,
    item,
  };
}

// ---------- Rendering ----------
// A Telegram thumbnail that fails to load (the module was busy or restarting) is tried again a
// couple of times, then replaced by the placeholder icon.
const THUMB_RETRIES = 2;
const THUMB_RETRY_MS = 1500;

document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.tgThumb) return;
  const attempt = Number(img.dataset.retry ?? 0) + 1;
  if (attempt > THUMB_RETRIES) {
    img.replaceWith(document.createRange().createContextualFragment(NO_THUMB));
    return;
  }
  img.dataset.retry = String(attempt);
  const url = img.dataset.tgThumb;
  setTimeout(() => { img.src = `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`; }, THUMB_RETRY_MS * attempt);
}, true); // error events don't bubble: listen in the capture phase

const NO_THUMB = '<span class="tg-nothumb"><svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M7 4v16l13-8z"/></svg></span>';

/** Inner HTML of a .thumb for a Telegram video. */
export function tgThumbHtml(item) {
  const watched = watchedPercent(toVideo(item));
  return `<img src="${tgThumbUrl(item)}" data-tg-thumb="${tgThumbUrl(item)}" alt="" loading="lazy" decoding="async">`
    + (item.duration ? `<span class="duration">${fmtTime(item.duration)}</span>` : '')
    + (watched ? `<span class="watched" style="width:${watched}%"></span>` : '')
    + (item.save?.state === 'done' ? '<span class="tg-saved">Tersimpan</span>' : '');
}

export function tgMeta(item) {
  return [item.height ? `${item.height}p` : null, item.size ? fmtSize(item.size) : null, item.date ? fmtAgo(item.date) : null]
    .filter(Boolean).join(' · ');
}

export const tgTitleHtml = (item) => escapeHtml(item.title);
