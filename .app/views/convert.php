<?php
/** @var array $items */
$title = 'Konversi ke MP4 · Video Player';
$styles = ['css/convert.css'];
$script = 'js/convert.js';
$data = ['items' => $items];
?>
<main class="convert">
  <div class="convert-head">
    <div>
      <h1>Konversi ke MP4</h1>
      <p>
        File yang tidak bisa diputar browser (seperti <code>.ts</code> dari unduhan HLS) diubah menjadi MP4 di folder yang sama.
        Konversi berjalan di latar belakang satu per satu, jadi halaman ini boleh ditutup. File aslinya tidak diubah.
      </p>
    </div>
    <button class="btn primary" id="convert-all" hidden>Konversi semua</button>
  </div>
  <ul class="jobs" id="jobs"></ul>
  <p class="empty" id="empty" hidden>Tidak ada file yang perlu dikonversi. Semua video di folder ini sudah bisa diputar.</p>
</main>
