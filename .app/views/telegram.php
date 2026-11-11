<?php
$title = 'Telegram · Video Player';
$styles = ['css/home.css', 'css/telegram.css'];
$script = 'js/telegram.js';
$data = [];
?>
<main class="tg">
  <section class="tg-panel" id="tg-message" hidden></section>

  <section class="tg-panel" id="tg-login" hidden>
    <h1>Masuk ke Telegram</h1>
    <p class="tg-lead" id="tg-login-lead"></p>
    <form class="tg-form" id="tg-login-form">
      <label for="tg-login-input" id="tg-login-label"></label>
      <div class="tg-form-row">
        <input id="tg-login-input" required autocomplete="off">
        <button class="btn primary" type="submit" id="tg-login-submit">Lanjut</button>
      </div>
      <p class="tg-error" id="tg-login-error" hidden></p>
    </form>
    <p class="tg-note">
      Login memakai akun Telegram Anda sendiri lewat API resmi. Sesi loginnya disimpan di volume Docker,
      di luar folder video, dan tidak pernah bisa dibuka dari browser.
    </p>
  </section>

  <section class="tg-browser" id="tg-browser" hidden>
    <div class="tg-toolbar" id="tg-toolbar">
      <!-- Phones: one summary line; tapping it drops the filters down over the grid -->
      <button class="tg-summary" id="tg-summary" type="button" aria-expanded="false" aria-controls="tg-filters">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
        <span class="tg-summary-text" id="tg-summary-text">Memuat…</span>
        <svg class="tg-summary-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="tg-filters" id="tg-filters">
      <div class="tg-pins" id="tg-pins" role="toolbar" aria-label="Channel yang disematkan" hidden></div>
      <div class="tg-channel-row">
        <select class="tg-select" id="tg-channel" aria-label="Pilih channel"></select>
        <button class="btn tg-pin" id="tg-pin" aria-pressed="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg><span class="label" id="tg-pin-label">Sematkan</span>
        </button>
      </div>
      <input class="tg-search" id="tg-search" type="search" placeholder="Cari di channel ini…" autocomplete="off">
      <select class="tg-select tg-sort" id="tg-sort" aria-label="Urutkan" title="Urutkan (diingat per channel)">
        <option value="new">Terbaru</option>
        <option value="old">Terlama</option>
        <option value="funny">Paling lucu 😂</option>
        <option value="popular">Paling banyak ditonton</option>
        <option value="unwatched">Belum ditonton dulu</option>
        <option value="short">Terpendek</option>
        <option value="long">Terpanjang</option>
        <option value="small">Terkecil</option>
        <option value="big">Terbesar</option>
        <option value="title">Judul A–Z</option>
        <option value="random">Acak</option>
      </select>
      <form class="tg-pager" id="tg-pager">
        <label for="tg-page">Hal.</label>
        <input id="tg-page" type="number" min="1" value="1" inputmode="numeric" enterkeyhint="go" aria-label="Lompat ke halaman">
        <span>/ <span id="tg-pages">1</span></span>
      </form>
      <span class="tg-count" id="tg-count"></span>
      <span class="tg-account">
        <span id="tg-account"></span>
        <button class="btn ghost" id="tg-logout">Keluar</button>
      </span>
      </div>
    </div>
    <ul class="grid" id="tg-grid"></ul>
    <p class="empty" id="tg-empty" hidden></p>
  </section>

  <!-- Peek: a quick look at a video over the grid (the browser's own player, streamed directly) -->
  <dialog class="peek" id="peek">
    <video id="peek-video" controls playsinline></video>
    <div class="peek-bar">
      <div class="peek-info">
        <p class="peek-title" id="peek-title"></p>
        <p class="peek-meta" id="peek-meta"></p>
      </div>
      <button class="btn" id="peek-save" title="Simpan ke folder vid: diunduh di latar, tetap jalan walau ini ditutup">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg><span class="label">Simpan</span>
      </button>
      <a class="btn" id="peek-open" title="Buka di halaman tonton (Enter)">Buka</a>
      <button class="btn ghost" id="peek-close" title="Tutup (Esc / Q)" aria-label="Tutup">✕</button>
    </div>
  </dialog>
</main>
