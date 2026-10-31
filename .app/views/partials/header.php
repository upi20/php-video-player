<?php /** @var string $query @var int $convertCount @var string $page */ ?>
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
  <?php $onTelegram = in_array($page, ['telegram', 'tg-watch'], true); ?>
  <a class="nav-link<?= $onTelegram ? ' active' : '' ?>" href="?page=telegram" title="Video dari channel Telegram"<?= $onTelegram ? ' aria-current="page"' : '' ?>>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 3-9.5 18-2.5-8-8-2.5z"/><path d="m22 3-12 10"/></svg>
    <span class="nav-label">Telegram</span>
  </a>
  <a class="nav-link<?= $page === 'convert' ? ' active' : '' ?>" href="?page=convert" title="Konversi ke MP4"<?= $page === 'convert' ? ' aria-current="page"' : '' ?>>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>
    <span class="nav-label">Konversi</span>
    <?php if ($convertCount > 0): ?><span class="nav-badge"><?= $convertCount ?></span><?php endif; ?>
  </a>
</header>
