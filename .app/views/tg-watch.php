<?php
/** @var int $c @var int $m */
$title = 'Telegram · Video Player';
$styles = ['css/watch.css', 'css/telegram.css'];
$script = 'js/tg-watch.js';
$data = ['c' => $c, 'm' => $m];
?>
<main class="watch" id="watch">
  <section class="stage">
    <?php require APP_DIR . '/views/partials/player.php'; ?>

    <div class="now">
      <h1 class="now-title" id="title">Memuat…</h1>
      <a class="tg-channel" id="channel" href="?page=telegram"></a>
      <div class="now-row">
        <div class="chips" id="chips"></div>
        <div class="now-actions">
          <button class="btn" id="prev" title="Video lebih baru (P)" disabled>
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg><span class="label">Sebelumnya</span>
          </button>
          <button class="btn" id="next" title="Video lebih lama (N)" disabled>
            <span class="label">Berikutnya</span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>
          </button>
          <button class="btn primary" id="save" title="Unduh ke folder video" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg><span class="label">Simpan ke vid</span>
          </button>
          <a class="btn" id="open-tg" target="_blank" rel="noopener noreferrer" title="Buka pesan ini di Telegram" hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg><span class="label">Telegram</span>
          </a>
          <label class="switch" title="Putar otomatis video berikutnya">
            <input type="checkbox" id="autoplay">
            <span class="switch-track"></span>
            Autoplay
          </label>
        </div>
      </div>
      <div class="tg-save" id="save-status" hidden></div>
      <p class="tg-caption" id="caption" hidden></p>
    </div>
  </section>

  <aside class="sidebar">
    <div class="sidebar-head">
      <div>
        <h2>Video di channel ini</h2>
        <span class="sidebar-count" id="count"></span>
      </div>
    </div>
    <ol class="list" id="list"></ol>
    <div class="tg-more"><button class="btn" id="more" hidden>Muat lebih banyak</button></div>
  </aside>
</main>
