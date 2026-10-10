// The custom video controls: play/pause, volume, speed, fullscreen, buffering spinner and
// auto-hiding. The seek bar itself lives in seekbar.js.
import { $, clock, store } from './util.js';
import { createSeekbar } from './seekbar.js';

const IDLE_MS = 2500;
const SPEEDS = [1, 1.25, 1.5, 2, 0.5, 0.75];

const svg = (body, attrs = 'fill="currentColor"') => `<svg viewBox="0 0 24 24" ${attrs}>${body}</svg>`;
const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  play: svg('<path d="M7 4v16l13-8z"/>'),
  pause: svg('<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'),
  volume: svg('<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>', STROKE),
  muted: svg('<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="m16 9 6 6M22 9l-6 6"/>', STROKE),
  enterFull: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', STROKE),
  exitFull: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>', STROKE),
};

export function createPlayer() {
  const root = $('player');
  const video = $('video');
  const ui = {
    bar: $('controls-bar'), play: $('c-play'), mute: $('c-mute'), volume: $('c-volume'), time: $('c-time'),
    speed: $('c-speed'), full: $('c-full'), bigPlay: $('big-play'), spinner: $('spinner'),
  };
  const seekbar = createSeekbar(video);
  let loaded = false;

  // ----- Actions (also used by keyboard shortcuts) -----
  function togglePlay() {
    if (!loaded) return;
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
  }

  function seekBy(seconds) {
    if (!video.duration) return;
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
  }

  function changeVolume(delta) {
    if (delta > 0) video.muted = false;
    video.volume = Math.max(0, Math.min(1, video.volume + delta));
  }

  function toggleMute() {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (!video.volume) video.volume = 0.5;
    } else {
      video.muted = true;
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen?.().catch(() => {});
  }

  // ----- Rendering: every frame while playing (smooth playhead), on events otherwise -----
  function updateTime() {
    ui.time.textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
  }

  let raf = 0;
  function tick() {
    seekbar.draw();
    updateTime();
    raf = video.paused ? 0 : requestAnimationFrame(tick);
  }
  video.addEventListener('play', () => { raf ||= requestAnimationFrame(tick); });
  for (const ev of ['timeupdate', 'seeking', 'seeked', 'durationchange', 'progress', 'loadedmetadata', 'emptied']) {
    video.addEventListener(ev, () => {
      if (raf) return;
      seekbar.draw();
      updateTime();
    });
  }

  // ----- Auto-hiding controls -----
  let idleTimer = null;
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused && !seekbar.isDragging() && !ui.bar.matches(':hover')) root.classList.add('idle');
    }, IDLE_MS);
  }

  root.addEventListener('pointermove', wake);
  root.addEventListener('mouseleave', () => {
    if (!video.paused && !seekbar.isDragging()) root.classList.add('idle');
  });

  // ----- Play state -----
  function syncPlayState() {
    const paused = video.paused;
    ui.play.innerHTML = paused ? ICONS.play : ICONS.pause;
    ui.play.title = paused ? 'Putar (K)' : 'Jeda (K)';
    ui.bigPlay.hidden = !paused || !loaded;
    wake();
  }
  for (const ev of ['play', 'pause', 'ended', 'emptied']) video.addEventListener(ev, syncPlayState);

  // On touch, the first tap only reveals the controls; later taps toggle playback.
  let tapRevealsOnly = false;
  video.addEventListener('pointerdown', (e) => {
    tapRevealsOnly = e.pointerType !== 'mouse' && root.classList.contains('idle');
    wake();
  });
  video.addEventListener('click', () => {
    if (!tapRevealsOnly) togglePlay();
  });
  video.addEventListener('dblclick', toggleFullscreen);
  ui.bigPlay.addEventListener('click', togglePlay);
  ui.play.addEventListener('click', togglePlay);

  // Buffering spinner, delayed so quick seeks don't flash it.
  let spinTimer = null;
  video.addEventListener('waiting', () => {
    clearTimeout(spinTimer);
    spinTimer = setTimeout(() => { ui.spinner.hidden = false; }, 250);
  });
  for (const ev of ['playing', 'canplay', 'seeked', 'pause', 'emptied']) {
    video.addEventListener(ev, () => {
      clearTimeout(spinTimer);
      ui.spinner.hidden = true;
    });
  }

  // ----- Volume (remembered) -----
  function syncVolume() {
    ui.volume.value = video.muted ? 0 : video.volume;
    ui.mute.innerHTML = video.muted || video.volume === 0 ? ICONS.muted : ICONS.volume;
  }
  video.volume = store.get('volume', 1);
  video.muted = store.get('muted', false);
  video.addEventListener('volumechange', () => {
    store.set('volume', video.volume);
    store.set('muted', video.muted);
    syncVolume();
  });
  ui.volume.addEventListener('input', () => {
    video.volume = Number(ui.volume.value);
    video.muted = video.volume === 0;
  });
  ui.mute.addEventListener('click', toggleMute);

  // ----- Speed -----
  ui.speed.addEventListener('click', () => {
    const next = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length];
    video.defaultPlaybackRate = next; // keeps the speed when the next video loads
    video.playbackRate = next;
  });
  video.addEventListener('ratechange', () => { ui.speed.textContent = `${video.playbackRate}×`; });

  // ----- Fullscreen -----
  function syncFullscreen() {
    const full = Boolean(document.fullscreenElement);
    ui.full.innerHTML = full ? ICONS.exitFull : ICONS.enterFull;
    ui.full.title = full ? 'Keluar layar penuh (F)' : 'Layar penuh (F)';
    requestAnimationFrame(seekbar.draw);
  }
  ui.full.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', syncFullscreen);

  syncVolume();
  syncPlayState();
  syncFullscreen();

  return {
    video,
    /** Plays video v; `next` is prepared in the background (loudness map, previews). */
    load(v, next) {
      loaded = true;
      video.src = v.url;
      seekbar.load(v, next);
    },
    togglePlay,
    seekBy,
    changeVolume,
    toggleMute,
    toggleFullscreen,
    wake,
  };
}
