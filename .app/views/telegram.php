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
      <div class="tg-pins" id="tg-pins" role="toolbar" aria-label="Channel yang disematkan" hidden></div>
      <div class="tg-channel-row">
        <select class="tg-select" id="tg-channel" aria-label="Pilih channel"></select>
        <button class="btn tg-pin" id="tg-pin" aria-pressed="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg><span class="label" id="tg-pin-label">Sematkan</span>
        </button>
      </div>
      <input class="tg-search" id="tg-search" type="search" placeholder="Cari di channel ini…" autocomplete="off">
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
    <ul class="grid" id="tg-grid"></ul>
    <p class="empty" id="tg-empty" hidden></p>
  </section>
</main>
