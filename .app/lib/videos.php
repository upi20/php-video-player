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

/** Every playable video in VIDEO_DIR, with what the pages need to show it. */
function listVideos(): array
{
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
            'url' => rawurlencode($name),
            'ext' => videoExt($name),
            'size' => filesize($path),
            'mtime' => filemtime($path),
            'key' => $key,
            'duration' => round($info['duration'], 2),
            'height' => $info['height'],
        ];
    }
    return $videos;
}
