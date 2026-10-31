<?php
declare(strict_types=1);

// ?api=<action>&v=<file name>&k=<cache key>
//   loudness                  → {"step":0.5,"values":[LUFS, ...]}
//   storyboard                → {"interval","cols","rows","width","height","sheets","frames"}
//   storyboard&sheet=<n>      → JPEG sprite sheet n (1-based)
//   thumb                     → JPEG cover image
// The cache key in the URL changes whenever the file does, so responses can be cached forever.
//
// Conversion (see convert.php):
//   GET  ?api=jobs                    → {"<name>": status, ...}
//   POST ?api=convert  v=<name>|all=1 → queue conversion(s), then the same as jobs
//   POST ?api=cancel   v=<name>       → stop a queued/running conversion
//
//   POST ?api=delete   v=<name>       → delete the file permanently, with its cache → {"ok":true}
//
// Telegram videos (see tganalysis.php): loudness and storyboard[&sheet=<n>] with tg=<c>_<m>
// instead of v; the first request downloads and analyses the video, which can take a while.
// thumb&tg=… is the first frame, for videos uploaded without a thumbnail.
function handleApi(string $action): void
{
    if (isset($_GET['tg'])) {
        handleTelegramApi($action, (string) $_GET['tg']);
        return;
    }
    if (in_array($action, ['jobs', 'convert', 'cancel'], true)) {
        handleConvertApi($action);
        return;
    }
    if ($action === 'delete') {
        if (!isAppPost()) {
            sendJsonError(405, 'use POST from the app');
            return;
        }
        try {
            deleteVideo((string) ($_POST['v'] ?? ''));
        } catch (RuntimeException $e) {
            sendJsonError(409, $e->getMessage());
            return;
        }
        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        echo '{"ok":true}';
        return;
    }

    $name = (string) ($_GET['v'] ?? '');
    // Thumbnails are also shown for files waiting on the Konversi page.
    $path = videoPath($name) ?? ($action === 'thumb' ? convertSourcePath($name) : null);
    if ($path === null) {
        sendJsonError(404, 'video not found');
        return;
    }
    $key = cacheKey($name, $path);

    switch ($action) {
        case 'loudness':
            $file = loudnessFile($path, $key);
            $file ? sendFile($file, 'application/json') : sendJsonError(500, 'loudness analysis failed');
            return;

        case 'thumb':
            $file = thumbnailFile($path, $key, videoInfo($path, $key)['duration']);
            $file ? sendFile($file, 'image/jpeg') : sendJsonError(500, 'thumbnail failed');
            return;

        case 'storyboard':
            sendStoryboard(storyboardDir($path, $key, videoInfo($path, $key)['duration']));
            return;

        default:
            sendJsonError(404, 'unknown api');
    }
}

function handleTelegramApi(string $action, string $id): void
{
    $key = tgCacheKey($id);
    if ($key === null || !in_array($action, ['loudness', 'storyboard', 'thumb'], true)) {
        sendJsonError(404, 'unknown api');
        return;
    }
    if ($action === 'thumb') {
        $file = tgFirstFrame($id);
        $file ? sendFile($file, 'image/jpeg') : sendJsonError(502, 'thumbnail failed');
        return;
    }
    try {
        tgAnalyse($id, $key);
    } catch (RuntimeException $e) {
        sendJsonError($e->getCode() ?: 500, $e->getMessage());
        return;
    }
    if ($action === 'loudness') {
        $file = cachePath($key, 'loudness.json');
        is_file($file) ? sendFile($file, 'application/json') : sendJsonError(500, 'loudness analysis failed');
        return;
    }
    $dir = cachePath($key, 'storyboard');
    sendStoryboard(is_dir($dir) ? $dir : null);
}

/** meta.json of a storyboard directory, or its sheet n with &sheet=<n>. */
function sendStoryboard(?string $dir): void
{
    if ($dir === null) {
        sendJsonError(500, 'storyboard failed');
        return;
    }
    if (!isset($_GET['sheet'])) {
        sendFile($dir . '/meta.json', 'application/json');
        return;
    }
    $sheet = (int) $_GET['sheet'];
    $file = $dir . '/' . $sheet . '.jpg';
    $sheet >= 1 && is_file($file) ? sendFile($file, 'image/jpeg') : sendJsonError(404, 'sheet not found');
}

function handleConvertApi(string $action): void
{
    if ($action !== 'jobs') {
        if (!isAppPost()) {
            sendJsonError(405, 'use POST from the app');
            return;
        }
        $name = (string) ($_POST['v'] ?? '');
        try {
            if ($action === 'cancel') {
                cancelConversion($name);
            } elseif (!empty($_POST['all'])) {
                foreach (conversionStatuses() as $file => $status) {
                    if (in_array($status['state'], ['idle', 'failed', 'canceled'], true)) {
                        startConversion($file);
                    }
                }
            } else {
                startConversion($name);
            }
        } catch (RuntimeException $e) {
            sendJsonError(400, $e->getMessage());
            return;
        }
    }
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(conversionStatuses(), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
}

// Anything that changes files needs POST plus a header only our own page's fetch() sends.
// Another website can't add that header without a CORS preflight we never answer, so it can't
// delete or convert files through the visitor's browser.
function isAppPost(): bool
{
    return $_SERVER['REQUEST_METHOD'] === 'POST' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') === 'video-player';
}

function sendFile(string $file, string $type): void
{
    header('Content-Type: ' . $type);
    header('Content-Length: ' . filesize($file));
    header('Cache-Control: private, max-age=31536000, immutable');
    readfile($file);
}

function sendJsonError(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message]);
}
