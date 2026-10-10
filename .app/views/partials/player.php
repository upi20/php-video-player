<div class="player" id="player">
  <video id="video" playsinline preload="metadata"></video>
  <div class="spinner" id="spinner" hidden></div>
  <button class="big-play" id="big-play" aria-label="Putar" hidden>
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>
  </button>

  <div class="controls-bar" id="controls-bar">
    <div class="seek" id="seek" role="slider" aria-label="Posisi video" tabindex="0">
      <canvas id="wave"></canvas>
      <div class="seek-line" id="seek-line" hidden></div>
      <div class="seek-preview" id="seek-preview" hidden>
        <div class="seek-frame" id="seek-frame" hidden></div>
        <div class="seek-tip" id="seek-tip"></div>
      </div>
    </div>
    <div class="ctrl-row">
      <button class="cbtn" id="c-play" title="Putar (K)"></button>
      <div class="vol">
        <button class="cbtn" id="c-mute" title="Bisu (M)"></button>
        <input type="range" id="c-volume" min="0" max="1" step="0.05" aria-label="Volume">
      </div>
      <span class="c-time" id="c-time">0:00 / 0:00</span>
      <span class="c-spacer"></span>
      <span class="c-status" id="c-status"></span>
      <button class="cbtn c-speed" id="c-speed" title="Kecepatan putar">1×</button>
      <button class="cbtn" id="c-theater" title="Mode bioskop (T)"></button>
      <button class="cbtn" id="c-full" title="Layar penuh (F)"></button>
    </div>
  </div>

  <div class="toast" id="toast" hidden>
    <span id="toast-text"></span>
    <button id="toast-action" hidden></button>
  </div>

  <div class="upnext" id="upnext" hidden>
    <div class="upnext-card">
      <div class="upnext-bar"><span id="upnext-bar"></span></div>
      <div class="upnext-inner">
        <p class="upnext-label">Berikutnya dalam <strong id="upnext-sec">5</strong> detik</p>
        <div class="upnext-body">
          <div class="thumb" id="upnext-thumb"></div>
          <div class="upnext-title" id="upnext-title"></div>
        </div>
        <div class="upnext-actions">
          <button class="btn ghost" id="upnext-cancel">Batal</button>
          <button class="btn primary" id="upnext-play">Putar sekarang</button>
        </div>
      </div>
    </div>
  </div>
</div>
