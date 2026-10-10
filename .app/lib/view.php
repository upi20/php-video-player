<?php
declare(strict_types=1);

function e(mixed $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** URL of a file in .app/assets, versioned by its mtime so browsers pick up changes. */
function asset(string $path): string
{
    $file = APP_DIR . '/assets/' . $path;
    return '.app/assets/' . $path . '?v=' . (is_file($file) ? filemtime($file) : 0);
}

/** JSON that is safe to place inside a <script> element. */
function scriptJson(mixed $data): string
{
    return (string) json_encode(
        $data,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_INVALID_UTF8_SUBSTITUTE
    );
}

/**
 * Renders views/<page>.php inside views/layout.php. The page view sets $title, $styles,
 * $script and $data, which the layout then uses.
 */
function renderPage(string $page, array $vars): void
{
    extract($vars);
    $title = 'Video Player';
    $styles = [];
    $script = null;
    $data = [];
    ob_start();
    require APP_DIR . '/views/' . $page . '.php';
    $content = (string) ob_get_clean();
    require APP_DIR . '/views/layout.php';
}
