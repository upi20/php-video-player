<?php /** @var string $page @var string $title @var string[] $styles @var ?string $script @var array $data @var string $content */ ?>
<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d0d10">
<title><?= e($title) ?></title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%238b7bff'/%3E%3Cpath d='M12 9v14l11-7z' fill='white'/%3E%3C/svg%3E">
<link rel="stylesheet" href="<?= e(asset('css/base.css')) ?>">
<?php foreach ($styles as $style): ?>
<link rel="stylesheet" href="<?= e(asset($style)) ?>">
<?php endforeach; ?>
</head>
<body class="page-<?= e($page) ?>">
<?php require APP_DIR . '/views/partials/header.php'; ?>
<?= $content ?>
<script type="application/json" id="app-data"><?= scriptJson($data) ?></script>
<?php if ($script): ?>
<script type="module" src="<?= e(asset($script)) ?>"></script>
<?php endif; ?>
</body>
</html>
