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
          <button class="btn" id="watched" aria-pressed="false" title="Tandai sudah/belum ditonton (W)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span class="label">Tandai ditonton</span>
          </button>
          <button class="btn danger-ghost" id="delete" title="Hapus video ini dari folder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg><span class="label">Hapus</span>
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
        <li><kbd>R</kbd> putar gambar</li>
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
