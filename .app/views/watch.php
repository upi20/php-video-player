<?php
/** @var array $videos @var array $current */
$title = $current['title'] . ' · Video Player';
$styles = ['css/watch.css'];
$script = 'js/watch.js';
$data = ['videos' => $videos, 'current' => $current['name']];
?>
<main class="watch" id="watch">
  <section class="stage">
    <?php require APP_DIR . '/views/partials/player.php'; ?>

    <div class="now">
      <h1 class="now-title" id="title"><?= e($current['title']) ?></h1>
      <div class="now-row">
        <div class="chips" id="chips"></div>
        <div class="now-actions">
          <button class="btn" id="prev" title="Sebelumnya (P)">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg><span class="label">Sebelumnya</span>
          </button>
          <button class="btn" id="next" title="Berikutnya (N)">
            <span class="label">Berikutnya</span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>
          </button>
          <label class="switch" title="Putar otomatis video berikutnya">
            <input type="checkbox" id="autoplay">
            <span class="switch-track"></span>
            Autoplay
          </label>
        </div>
      </div>
      <ul class="shortcuts">
        <li><kbd>K</kbd>/<kbd>Spasi</kbd> putar/jeda</li>
        <li><kbd>J</kbd><kbd>L</kbd> ±10 dtk</li>
        <li><kbd>←</kbd><kbd>→</kbd> ±5 dtk</li>
        <li><kbd>↑</kbd><kbd>↓</kbd> volume</li>
        <li><kbd>T</kbd> mode bioskop</li>
        <li><kbd>F</kbd> layar penuh</li>
        <li><kbd>M</kbd> bisu</li>
        <li><kbd>N</kbd><kbd>P</kbd> berikutnya/sebelumnya</li>
        <li><kbd>/</kbd> cari</li>
      </ul>
    </div>
  </section>

  <aside class="sidebar">
    <div class="sidebar-head">
      <div>
        <h2>Daftar putar</h2>
        <span class="sidebar-count" id="count"></span>
      </div>
      <select class="sort-select" id="sort" aria-label="Urutkan daftar putar">
        <option value="new">Terbaru</option>
        <option value="old">Terlama</option>
        <option value="name">Nama A–Z</option>
        <option value="size">Ukuran terbesar</option>
        <option value="long">Terpanjang</option>
      </select>
    </div>
    <ol class="list" id="list"></ol>
  </aside>
</main>
