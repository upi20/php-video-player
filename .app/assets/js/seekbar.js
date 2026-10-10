// The seek bar: a loudness map drawn on a canvas (loud parts highlighted), click/drag to seek,
// and a hover preview frame from the server's storyboard sprite sheets.
import { $, clock, loudnessUrl, storyboardUrl } from './util.js';

const LOUD = 0.8; // top share of this video's loudness range that is marked as loud
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
  let current = null;
  let dragging = false;

  function getJson(url) {
    if (!requests.has(url)) {
      const request = fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
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

  function setStatus(kind) {
    ui.status.classList.toggle('busy', kind === 'busy');
    ui.status.innerHTML = {
      busy: '<span class="label">Menganalisis suara…</span>',
      ready: '<span class="dot"></span><span class="label">Suara keras</span>',
      none: '<span class="label">Tanpa audio</span>',
      error: '<span class="label">Analisis suara gagal</span>',
    }[kind];
  }

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
  /** Shows video v's loudness map and previews; then prepares `next` in the background. */
  function load(v, next) {
    current = v;
    wave.norm = null;
    board.video = v;
    board.meta = null;
    setStatus('busy');
    draw();

    const loudness = getJson(loudnessUrl(v)).then((data) => {
      if (current !== v) return;
      setLoudness(data);
      setStatus(wave.norm ? 'ready' : 'none');
      draw();
    }, () => {
      if (current === v) setStatus('error');
    });

    const storyboard = getJson(storyboardUrl(v)).then((meta) => {
      if (current !== v) return;
      board.meta = meta;
      // Download every sheet now so the first hover is already instant.
      for (let i = 1; i <= meta.sheets; i++) new Image().src = storyboardUrl(v, i);
    }, () => {});

    if (next) Promise.all([loudness, storyboard]).then(() => prefetch(next));
  }

  function prefetch(v) {
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

  return { load, prefetch, draw, isDragging: () => dragging };
}
