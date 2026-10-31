<?php
declare(strict_types=1);

// Loudness map and hover previews for Telegram videos (?api=loudness|storyboard&tg=<c>_<m>).
// The tg module downloads the video once into the shared cache, it is analysed exactly like a
// local file (loudness.php, storyboard.php), then the copy is removed; only the results stay.
const TG_MODULE = 'http://tg:8080';
const TG_ANALYSE_MAX_BYTES = 300 * 1024 * 1024; // bigger videos: save them to the folder first
const TG_THUMB_DIR = CACHE_DIR . '/tg';         // shared with the tg module's own thumbnails
const TG_THUMB_WIDTH = 480;

/** "<channel>_<message>" → cache key, or null when the id is malformed. */
function tgCacheKey(string $id): ?string
{
    return preg_match('/^-?\d{1,20}_\d{1,12}$/', $id) ? 'tg' . $id : null;
}

/**
 * Makes sure the loudness map and storyboard of Telegram video $id are cached. Several requests
 * at once (loudness, storyboard, its sheets) share one download: the others wait on the lock.
 * @throws RuntimeException with code 413 when the video is too big, 502 when it can't be fetched
 */
function tgAnalyse(string $id, string $key): void
{
    $error = null;
    buildOnce(cachePath($key, 'analysed'), function (string $tmp) use ($id, $key, &$error): bool {
        [$c, $m] = explode('_', $id);
        $video = json_decode((string) @file_get_contents(TG_MODULE . "/video?c=$c&m=$m"), true);
        if (!is_array($video) || !isset($video['size'])) {
            $error = new RuntimeException('Video Telegram tidak bisa dibaca', 502);
            return false;
        }
        if ($video['size'] > TG_ANALYSE_MAX_BYTES) {
            $error = new RuntimeException('Video terlalu besar untuk dianalisis', 413);
            return false;
        }
        $copy = tgDownload((int) $c, (int) $m);
        if ($copy === null) {
            $error = new RuntimeException('Video Telegram gagal diunduh', 502);
            return false;
        }
        try {
            loudnessFile($copy, $key);
            storyboardDir($copy, $key, videoInfo($copy, $key)['duration']);
        } finally {
            @unlink($copy);
        }
        return file_put_contents($tmp, '1') !== false;
    });
    if ($error) {
        throw $error;
    }
}

/**
 * Thumbnail for a Telegram video that was uploaded without one: its first frame, read from the
 * start of the stream only. Saved where the tg module caches thumbnails, so /tg/thumb serves it too.
 */
function tgFirstFrame(string $id): ?string
{
    [$c, $m] = explode('_', $id);
    if (!is_dir(TG_THUMB_DIR)) {
        @mkdir(TG_THUMB_DIR, 0775, true);
    }
    $file = TG_THUMB_DIR . "/{$c}_{$m}.jpg";
    $built = buildOnce($file, function (string $tmp) use ($c, $m): bool {
        [$code] = runProcess([
            'ffmpeg', '-nostdin', '-v', 'error', '-i', TG_MODULE . "/stream/$c/$m",
            '-map', '0:v:0', '-frames:v', '1', '-vf', sprintf("scale='min(%d,iw)':-2", TG_THUMB_WIDTH),
            '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', '-update', '1', '-y', $tmp,
        ]);
        return $code === 0 && is_file($tmp) && filesize($tmp) > 0;
    });
    return $built ? $file : null;
}

/**
 * Asks the tg module to download the whole video into the shared cache (CACHE_DIR/tgtmp), which
 * is much faster than reading its stream. Returns the file's path; the caller deletes it.
 */
function tgDownload(int $c, int $m): ?string
{
    $answer = @file_get_contents(TG_MODULE . '/download', false, stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "Content-Type: application/x-www-form-urlencoded\r\nX-Requested-With: video-player\r\n",
        'content' => http_build_query(['c' => $c, 'm' => $m]),
        'timeout' => 900,
    ]]));
    $name = json_decode((string) $answer, true)['file'] ?? null;
    $path = is_string($name) ? CACHE_DIR . '/tgtmp/' . basename($name) : null;
    return $path !== null && is_file($path) ? $path : null;
}
