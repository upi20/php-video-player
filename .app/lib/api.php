<?php
declare(strict_types=1);

// ?api=<action>&v=<file name>&k=<cache key>
//   loudness                  → {"step":0.5,"values":[LUFS, ...]}
//   storyboard                → {"interval","cols","rows","width","height","sheets","frames"}
//   storyboard&sheet=<n>      → JPEG sprite sheet n (1-based)
//   thumb                     → JPEG cover image
// The cache key in the URL changes whenever the file does, so responses can be cached forever.
function handleApi(string $action): void
{
    $name = (string) ($_GET['v'] ?? '');
    $path = videoPath($name);
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
            $dir = storyboardDir($path, $key, videoInfo($path, $key)['duration']);
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
            return;

        default:
            sendJsonError(404, 'unknown api');
    }
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
