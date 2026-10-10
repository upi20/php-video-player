<?php
declare(strict_types=1);

// Front controller. Videos are streamed by Apache directly (HTTP Range); this only renders
// the pages and answers ?api= requests. The app itself lives in .app/.
require __DIR__ . '/.app/lib/bootstrap.php';

if (isset($_GET['api'])) {
    handleApi((string) $_GET['api']);
    exit;
}

$videos = listVideos();

if (isset($_GET['v'])) {
    $name = (string) $_GET['v'];
    $current = null;
    foreach ($videos as $video) {
        if ($video['name'] === $name) {
            $current = $video;
            break;
        }
    }
    if ($current === null) {
        header('Location: ./');
        exit;
    }
    renderPage('watch', ['videos' => $videos, 'current' => $current]);
    exit;
}

renderPage('home', ['videos' => $videos, 'query' => (string) ($_GET['q'] ?? '')]);
