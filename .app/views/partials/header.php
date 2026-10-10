<?php /** @var string $query */ ?>
<header class="topbar">
  <a class="brand" href="./" aria-label="Beranda">
    <span class="brand-mark"><svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><path d="M7 4v16l13-8z"/></svg></span>
    <span class="brand-name">Video Player</span>
  </a>
  <form class="search" action="./" method="get" role="search">
    <label class="sr-only" for="search">Cari video</label>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input id="search" name="q" type="search" placeholder="Cari video…" autocomplete="off" value="<?= e($query ?? '') ?>">
  </form>
</header>
