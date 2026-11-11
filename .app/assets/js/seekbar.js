// The seek bar: a loudness map drawn on a canvas (loud parts highlighted), click/drag to seek,
// and a hover preview frame from the server's storyboard sprite sheets.
import { $, clock, loudnessUrl, store, storyboardUrl } from './util.js';

const LOUD = 0.8; // top share of this video's loudness range that is marked as loud
const DEFER_ANALYSIS_S = 30; // seconds of watching before a big Telegram video is analysed

// Telegram stream settings (per device, set on the watch page). Analysing a Telegram video means
// downloading it whole, for the loudness map and the previews alike, so it is one switch; the
// other one prepares (downloads) the next video in the background. Both off = the fast mode.
// Local videos are on disk: they are always analysed and prepared.
export const tgSettings = {
  analysis: () => store.get('tg:analysis', true),
  prefetch: () => store.get('tg:prefetch', true),
};
const BAR_W = 3;
const BAR_GAP = 1;
const MIN_BAR_H = 3;
const COLORS = {
  played: '#8b7bff',
  buffered: 'rgba(255, 255, 255, 0.42)',
  rest: 'rgba(255, 255, 255, 0.22)',
  loudPlayed: '#ffb020',
  loudRest: 'rgba(255, 176, 32, 0.55)',
  head: '#fff',
};

export function createSeekbar(video) {
  const ui = {
    seek: $('seek'), canvas: $('wave'), line: $('seek-line'), preview: $('seek-preview'),
    frame: $('seek-frame'), tip: $('seek-tip'), status: $('c-status'),
  };
  const wave = { norm: null, step: 0.5 };
  const board = { video: null, meta: null };
  const requests = new Map(); // url -> Promise of parsed JSON
  // Requests made for the video on screen (and the next one); dropped when another one is loaded,
  // so they don't hold connections the new video needs.
  let aborter = new AbortController();
  let current = null;
  let dragging = false;

  function getJson(url) {
    if (!requests.has(url)) {
      const request = fetch(url, { signal: aborter.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
      request.catch(() => requests.delete(url));
      requests.set(url, request);
    }
    return requests.get(url);
  }

  // ----- Loudness -----
  // Values are LUFS per step. Scale them between this video's quiet floor (10th percentile) and
  // its loudest moment, so loud parts stand out regardless of how loud the file is overall.
  function setLoudness(data) {
    const values = data?.values ?? [];
    if (!values.length) {
      wave.norm = null;
      return;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const lo = Math.max(-60, sorted[Math.floor(sorted.length * 0.1)]);
    const range = Math.max(sorted[sorted.length - 1] - lo, 1);
    wave.norm = values.map((v) => Math.min(1, Math.max(0, (v - lo) / range)));
    wave.step = data.step;
  }

  /** Loudest normalised level between two points in time (seconds). */
  function levelBetween(t0, t1) {
    if (!wave.norm) return 0;
    const i0 = Math.floor(t0 / wave.step);
    const i1 = Math.max(i0 + 1, Math.ceil(t1 / wave.step));
    let max = 0;
    for (let i = i0; i < i1 && i < wave.norm.length; i++) max = Math.max(max, wave.norm[i]);
    return max;
  }

  function isBuffered(t) {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t <= b.end(i)) return true;
    return false;
  }

  function draw() {
    const { canvas } = ui;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const duration = video.duration || 0;
    const progress = duration ? video.currentTime / duration : 0;
    const count = Math.max(1, Math.floor((w + BAR_GAP) / (BAR_W + BAR_GAP)));
    const barW = (w + BAR_GAP) / count - BAR_GAP;

    for (let i = 0; i < count; i++) {
      const t0 = (i / count) * duration;
      const t1 = ((i + 1) / count) * duration;
      const level = duration ? levelBetween(t0, t1) : 0;
      const played = (i + 0.5) / count <= progress;
      const loud = level >= LOUD;
      ctx.fillStyle = loud
        ? played ? COLORS.loudPlayed : COLORS.loudRest
        : played ? COLORS.played : isBuffered((t0 + t1) / 2) ? COLORS.buffered : COLORS.rest;
      const barH = MIN_BAR_H + level * (h - MIN_BAR_H);
      ctx.fillRect(i * (barW + BAR_GAP), h - barH, barW, barH);
    }

    if (duration) {
      ctx.fillStyle = COLORS.head;
      ctx.fillRect(Math.min(w - 2, Math.max(0, progress * w - 1)), 0, 2, h);
    }
  }

  const SKIP_BTN = '<button class="c-status-btn" data-analysis="skip" title="Lewati analisis video ini (hemat koneksi)" aria-label="Lewati analisis">✕</button>';
  const NOW_BTN = '<button class="c-status-btn" data-analysis="now" title="Buat peta suara dan pratinjau untuk video ini">Analisis</button>';

  /** n: seconds left while waiting. The ✕ only where analysing costs a download of its own. */
  function setStatus(kind, n = 0) {
    phase = kind;
    const skip = current?.item ? SKIP_BTN : '';
    ui.status.classList.toggle('busy', kind === 'busy');
    ui.status.classList.toggle('actionable', ['waiting', 'busy', 'manual', 'skipped'].includes(kind));
    ui.status.innerHTML = {
      busy: `<span class="label">Menganalisis suara…</span>${skip}`,
      waiting: `<span class="label">Peta suara dalam ${n} dtk</span>${skip}`,
      manual: `<span class="label">Peta suara mati</span>${NOW_BTN}`,
      skipped: `<span class="label">Analisis dilewati</span>${NOW_BTN}`,
      ready: '<span class="dot"></span><span class="label">Suara keras</span>',
      none: '<span class="label">Tanpa audio</span>',
      error: '<span class="label">Analisis suara gagal</span>',
      remote: '<span class="label">Video terlalu besar untuk peta suara · simpan ke vid dulu</span>',
    }[kind];
  }

  ui.status.addEventListener('click', (e) => {
    const action = e.target.closest('[data-analysis]')?.dataset.analysis;
    if (action === 'skip') skip();
    else if (action === 'now' && current) analyse(current, currentNext);
  });

  // ----- Storyboard (hover preview frames) -----
  function showFrame(t) {
    const meta = board.meta;
    ui.frame.hidden = !meta;
    if (!meta) return;
    const perSheet = meta.cols * meta.rows;
    const index = Math.max(0, Math.min(Math.floor(t / meta.interval), meta.frames - 1, meta.sheets * perSheet - 1));
    const cell = index % perSheet;
    const scale = ui.frame.clientWidth / meta.width; // the frame is smaller on phones
    const w = meta.width * scale;
    const h = meta.height * scale;
    ui.frame.style.backgroundImage = `url("${storyboardUrl(board.video, Math.floor(index / perSheet) + 1)}")`;
    ui.frame.style.backgroundSize = `${meta.cols * w}px ${meta.rows * h}px`;
    ui.frame.style.backgroundPosition = `${-(cell % meta.cols) * w}px ${-Math.floor(cell / meta.cols) * h}px`;
  }

  // ----- Loading -----
  // ----- Analysis: loudness map + hover previews -----
  // run changes whenever the analysis of the video on screen is started over or dropped (another
  // video, ✕), so answers that arrive late are ignored.
  let run = 0;
  let phase = null;
  let currentNext = null;
  let countdown = null; // stops the countdown of a deferred analysis

  /** Shows video v's loudness map and previews; then prepares `next` in the background. */
  function load(v, next) {
    run++;
    countdown?.();
    aborter.abort();
    aborter = new AbortController();
    current = v;
    currentNext = next;
    wave.norm = null;
    board.video = v;
    board.meta = null;
    draw();
    if (v.remote) {
      // A big Telegram video: no loudness map or previews until it is saved locally.
      setStatus('remote');
      return;
    }
    if (!v.item) {
      analyse(v, next); // a local file: nothing to download
      return;
    }
    // Telegram: analysing means downloading the whole video. Already done before? Then it's free.
    const id = run;
    setStatus('waiting', DEFER_ANALYSIS_S);
    fetch(`${loudnessUrl(v)}&cached=1`).then((r) => {
      r.body?.cancel(); // unread, the response would keep one of the browser's few connections busy
      return r.ok;
    }, () => false).then((cached) => {
      if (id !== run) return;
      if (cached) analyse(v, next);
      else autoAnalyse(v, next);
    });
  }

  /** Follows the setting: no analysis, at once (a small video shares its download), or later. */
  function autoAnalyse(v, next) {
    if (!tgSettings.analysis()) setStatus('manual');
    else if (v.deferAnalysis) startCountdown(v, next);
    else analyse(v, next);
  }

  /**
   * A big Telegram video streams straight from Telegram, and analysing it downloads it whole.
   * Doing that from the start slows the stream, and is wasted when the next video comes a few
   * seconds later: so it waits for DEFER_ANALYSIS_S seconds of actual watching (paused or
   * still loading doesn't count), shown as a countdown with a ✕ to skip it.
   */
  function startCountdown(v, next) {
    const id = run;
    let left = DEFER_ANALYSIS_S;
    const timer = setInterval(() => {
      if (id !== run) return stop();
      if (!video.paused && video.readyState >= 3) left--;
      if (left > 0) {
        setStatus('waiting', left);
        return;
      }
      stop();
      analyse(v, next);
    }, 1000);
    const stop = () => {
      clearInterval(timer);
      if (countdown === stop) countdown = null;
    };
    countdown = stop;
    setStatus('waiting', left);
  }

  /** ✕: drop this video's analysis; the page also stops its download (the analysisskip event). */
  function skip() {
    if (!current) return;
    run++;
    countdown?.();
    aborter.abort();
    aborter = new AbortController();
    setStatus('skipped');
    video.dispatchEvent(new CustomEvent('analysisskip', { detail: current }));
  }

  /** The settings changed: apply them to the video on screen. */
  function settingsChanged() {
    const v = current;
    if (!v?.item || v.remote) return;
    const on = tgSettings.analysis();
    if (!on && (phase === 'waiting' || phase === 'busy')) {
      skip();
      setStatus('manual');
    } else if (on && (phase === 'manual' || phase === 'skipped')) {
      autoAnalyse(v, currentNext);
    }
  }

  function analyse(v, next) {
    run++;
    countdown?.();
    const id = run;
    setStatus('busy');
    const loudness = getJson(loudnessUrl(v)).then((data) => {
      if (id !== run) return;
      setLoudness(data);
      setStatus(wave.norm ? 'ready' : 'none');
      draw();
    }, () => {
      if (id === run) setStatus('error');
    });

    const storyboard = getJson(storyboardUrl(v)).then((meta) => {
      if (id !== run) return;
      board.meta = meta;
      // Download every sheet now so the first hover is already instant.
      for (let i = 1; i <= meta.sheets; i++) new Image().src = storyboardUrl(v, i);
    }, () => {});

    if (next) Promise.all([loudness, storyboard]).then(() => prefetch(next));
  }

  function prefetch(v) {
    // A big Telegram video would be downloaded whole in the background: only small ones, which the
    // tg module then plays from that same download (toVideo() in tg.js).
    if (v.remote || v.prefetch === false || (v.item && !tgSettings.prefetch())) return;
    getJson(loudnessUrl(v)).catch(() => {});
    getJson(storyboardUrl(v)).catch(() => {});
  }

  // ----- Pointer: hover preview and seeking -----
  function fractionAt(clientX) {
    const r = ui.seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }

  function seekTo(clientX) {
    if (!video.duration) return;
    video.currentTime = fractionAt(clientX) * video.duration;
    draw();
  }

  function showHover(clientX) {
    const width = ui.seek.clientWidth;
    const x = fractionAt(clientX) * width;
    const t = fractionAt(clientX) * (video.duration || 0);
    const loud = levelBetween(t, t) >= LOUD;
    ui.tip.innerHTML = `${clock(t)}${loud ? ' <span class="loud">· suara keras</span>' : ''}`;
    ui.preview.hidden = false;
    showFrame(t);
    // Keep the whole preview inside the bar near the edges.
    const half = ui.preview.offsetWidth / 2;
    ui.preview.style.left = `${Math.min(width - half, Math.max(half, x))}px`;
    ui.line.style.left = `${x}px`;
    ui.line.hidden = false;
  }

  function hideHover() {
    ui.preview.hidden = true;
    ui.line.hidden = true;
  }

  ui.seek.addEventListener('pointerdown', (e) => {
    dragging = true;
    ui.seek.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
    showHover(e.clientX);
  });
  ui.seek.addEventListener('pointermove', (e) => {
    showHover(e.clientX);
    if (dragging) seekTo(e.clientX);
  });
  ui.seek.addEventListener('pointerup', (e) => {
    dragging = false;
    if (e.pointerType !== 'mouse') hideHover();
  });
  ui.seek.addEventListener('pointercancel', () => {
    dragging = false;
    hideHover();
  });
  ui.seek.addEventListener('pointerleave', () => {
    if (!dragging) hideHover();
  });

  new ResizeObserver(() => draw()).observe(ui.seek);

  return { load, prefetch, draw, settingsChanged, isDragging: () => dragging };
}
