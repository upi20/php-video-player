<?php
declare(strict_types=1);

function videoExt(string $name): string
{
    $dot = strrpos($name, '.');
    return $dot === false ? '' : strtolower(substr($name, $dot + 1));
}

/** Absolute path of a video in VIDEO_DIR; null for anything else (hidden files, paths, other types). */
function videoPath(string $name): ?string
{
    $path = VIDEO_DIR . '/' . $name;
    if ($name === '' || $name[0] === '.' || strpbrk($name, '/\\') !== false
        || !in_array(videoExt($name), VIDEO_EXTS, true) || !is_file($path)) {
        return null;
    }
    return $path;
}

// Keyed by name, size and mtime, so a replaced file is analysed again.
function cacheKey(string $name, string $path): string
{
    return sha1($name . '|' . filesize($path) . '|' . filemtime($path));
}

/** Duration and resolution from ffprobe, cached. */
function videoInfo(string $path, string $key): array
{
    $empty = ['duration' => 0.0, 'width' => 0, 'height' => 0];
    $file = cachePath($key, 'info.json');
    $built = buildOnce($file, function (string $tmp) use ($path): bool {
        [, $out] = runProcess([
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height:format=duration', '-of', 'json', $path,
        ]);
        $probe = json_decode($out, true) ?: [];
        $info = [
            'duration' => (float) ($probe['format']['duration'] ?? 0),
            'width' => (int) ($probe['streams'][0]['width'] ?? 0),
            'height' => (int) ($probe['streams'][0]['height'] ?? 0),
        ];
        return file_put_contents($tmp, json_encode($info)) !== false;
    });
    $info = $built ? json_decode((string) file_get_contents($file), true) : null;
    return is_array($info) ? $info + $empty : $empty;
}

/**
 * Permanently deletes a video (or a file waiting for conversion) and everything cached for it.
 * Goes through the writable MEDIA_DIR mount; refuses while the file is being converted.
 */
function deleteVideo(string $name): void
{
    $path = videoPath($name) ?? convertSourcePath($name);
    if ($path === null) {
        throw new RuntimeException('File tidak ditemukan');
    }
    $key = cacheKey($name, $path);
    if (convertSourcePath($name) !== null
        && in_array(conversionStatus($name, $path, $key)['state'], ['queued', 'running'], true)) {
        throw new RuntimeException('File ini sedang dikonversi. Batalkan dulu konversinya.');
    }
    if (!@unlink(MEDIA_DIR . '/' . $name)) {
        throw new RuntimeException('File tidak bisa dihapus. Pastikan baris "./data:/media" ada di docker-compose.yml.');
    }
    foreach ([...(glob(CACHE_DIR . "/$key.*") ?: []), ...(glob(JOBS_DIR . "/$key.*") ?: [])] as $cached) {
        removePath($cached);
    }
    if (isset(watchedVideos()[$name])) {
        markWatched($name, false);
    }
}

// ---------- Watched ----------
// name => when it was first played, shown as a badge on every device. In the state folder, not the
// cache: deleting the cache (which is meant to be safe) once wiped these marks.
const WATCHED_FILE = STATE_DIR . '/watched.json';

/** @return array<string, int> */
function watchedVideos(): array
{
    $list = is_file(WATCHED_FILE) ? json_decode((string) file_get_contents(WATCHED_FILE), true) : null;
    return is_array($list) ? array_filter($list, 'is_int') : [];
}

/** Marks video $name as watched (or not); returns when it was watched, null when it isn't. */
function markWatched(string $name, bool $on): ?int
{
    $lock = @fopen(lockPath(WATCHED_FILE), 'c');
    if ($lock === false) {
        throw new RuntimeException('Status ditonton tidak bisa disimpan');
    }
    flock($lock, LOCK_EX); // two pages marking at once must not lose each other's change
    try {
        $list = watchedVideos();
        if ($on) {
            $list[$name] ??= time();
        } else {
            unset($list[$name]);
        }
        $tmp = WATCHED_FILE . '.tmp';
        if (file_put_contents($tmp, json_encode($list, JSON_UNESCAPED_UNICODE)) === false || !rename($tmp, WATCHED_FILE)) {
            throw new RuntimeException('Status ditonton tidak bisa disimpan');
        }
        return $list[$name] ?? null;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** Every playable video in VIDEO_DIR, with what the pages need to show it. */
function listVideos(): array
{
    $watched = watchedVideos();
    $videos = [];
    foreach (scandir(VIDEO_DIR) ?: [] as $name) {
        $path = videoPath($name);
        if ($path === null) {
            continue;
        }
        $key = cacheKey($name, $path);
        $info = videoInfo($path, $key);
        $videos[] = [
            'name' => $name,
            'title' => substr($name, 0, (int) strrpos($name, '.')),
            'url' => VIDEO_URL . rawurlencode($name),
            'ext' => videoExt($name),
            'size' => filesize($path),
            'mtime' => filemtime($path),
            'key' => $key,
            'duration' => round($info['duration'], 2),
            'height' => $info['height'],
            'watched' => $watched[$name] ?? null,
        ];
    }
    return $videos;
}
