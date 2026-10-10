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
  <ul class="grid" id="grid"></ul>
  <p class="empty" id="empty" hidden></p>
</main>
