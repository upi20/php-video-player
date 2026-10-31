<?php
/** @var array $videos */
$title = 'Video Player';
$styles = ['css/home.css'];
$script = 'js/home.js';
$data = ['videos' => $videos];
?>
<main class="home">
  <div class="chips-bar" role="toolbar" aria-label="Urutkan video">
    <button class="chip-btn" data-sort="new">Terbaru</button>
    <button class="chip-btn" data-sort="old">Terlama</button>
    <button class="chip-btn" data-sort="name">Nama A–Z</button>
    <button class="chip-btn" data-sort="size">Ukuran terbesar</button>
    <button class="chip-btn" data-sort="long">Terpanjang</button>
    <span class="chips-count" id="count"></span>
  </div>
  <?php if ($convertCount > 0): ?>
  <a class="convert-banner" href="?page=convert">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>
    <span><strong><?= $convertCount ?> file</strong> belum bisa diputar di browser (misalnya .ts). Ubah ke MP4 di halaman Konversi.</span>
    <span class="convert-banner-cta">Buka</span>
  </a>
  <?php endif; ?>
  <ul class="grid" id="grid"></ul>
  <p class="empty" id="empty" hidden></p>
</main>
