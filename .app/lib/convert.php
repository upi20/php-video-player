<?php
declare(strict_types=1);

// Background conversion of files browsers can't play (.ts, .avi, ...) to MP4.
//
// Each job is a small shell script started detached (setsid), so it keeps running after the
// request ends. Jobs wait for each other on a flock, so only one ffmpeg runs at a time.
// Job state lives in CACHE_DIR/jobs/<cache key>.*; the MP4 is written next to the source as a
// hidden ".<name>.mp4.part" and renamed when complete. Nothing is ever overwritten or deleted.

const JOBS_DIR = CACHE_DIR . '/jobs';
const QUEUE_LOCK = JOBS_DIR . '/queue.lock';
const COPY_VIDEO_CODECS = ['h264', 'hevc', 'av1', 'vp9']; // can go into MP4 as they are
const COPY_AUDIO_CODECS = ['aac', 'mp3'];
const SIGTERM_NUMBER = 15;

/** Absolute path of a convertible file in VIDEO_DIR; null for anything else. */
function convertSourcePath(string $name): ?string
{
    $path = VIDEO_DIR . '/' . $name;
    if ($name === '' || $name[0] === '.' || strpbrk($name, '/\\') !== false
        || !in_array(videoExt($name), CONVERT_EXTS, true) || !is_file($path)) {
        return null;
    }
    return $path;
}

function mp4NameFor(string $name): string
{
    return substr($name, 0, (int) strrpos($name, '.')) . '.mp4';
}

/** Files that still need converting (no MP4 next to them yet). Cheap: no probing. */
function pendingConversionCount(): int
{
    $count = 0;
    foreach (scandir(VIDEO_DIR) ?: [] as $name) {
        if (convertSourcePath($name) !== null && !file_exists(VIDEO_DIR . '/' . mp4NameFor($name))) {
            $count++;
        }
    }
    return $count;
}

/** Codec and size of the first video and audio stream, cached. */
function streamCodecs(string $path, string $key): array
{
    $empty = ['video' => '', 'audio' => '', 'width' => 0, 'height' => 0];
    $file = cachePath($key, 'streams.json');
    $built = buildOnce($file, function (string $tmp) use ($path, $empty): bool {
        [, $out] = runProcess([
            'ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', $path,
        ]);
        $codecs = $empty;
        foreach ((json_decode($out, true) ?: [])['streams'] ?? [] as $stream) {
            $type = $stream['codec_type'] ?? '';
            if ($type === 'video' && $codecs['video'] === '') {
                $codecs['video'] = (string) ($stream['codec_name'] ?? '');
                $codecs['width'] = (int) ($stream['width'] ?? 0);
                $codecs['height'] = (int) ($stream['height'] ?? 0);
            } elseif ($type === 'audio' && $codecs['audio'] === '') {
                $codecs['audio'] = (string) ($stream['codec_name'] ?? '');
            }
        }
        return file_put_contents($tmp, json_encode($codecs)) !== false;
    });
    $codecs = $built ? json_decode((string) file_get_contents($file), true) : null;
    return is_array($codecs) ? $codecs + $empty : $empty;
}

/** Per stream: 'copy' (fast, no quality change), 'encode', or 'none' for missing audio. */
function conversionPlan(array $codecs): array
{
    return [
        'video' => in_array($codecs['video'], COPY_VIDEO_CODECS, true) ? 'copy' : 'encode',
        'audio' => $codecs['audio'] === '' ? 'none'
            : (in_array($codecs['audio'], COPY_AUDIO_CODECS, true) ? 'copy' : 'encode'),
    ];
}

function ffmpegConvertArgs(string $src, string $dst, string $progressFile, array $codecs, array $plan): array
{
    $args = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', $src, '-map', '0:v:0', '-map', '0:a:0?'];
    if ($plan['video'] === 'copy') {
        $args = [...$args, '-c:v', 'copy'];
        if ($codecs['video'] === 'hevc') {
            $args = [...$args, '-tag:v', 'hvc1']; // lets Safari/QuickTime play HEVC in MP4
        }
    } else {
        $args = [...$args, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'];
    }
    if ($plan['audio'] !== 'none') {
        $args = [...$args, ...($plan['audio'] === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'])];
    }
    return [...$args, '-sn', '-dn', '-movflags', '+faststart', '-f', 'mp4', '-progress', $progressFile, '-nostats', $dst];
}

function jobBase(string $key): string
{
    return JOBS_DIR . '/' . $key;
}

/** Queues a conversion and returns at once; the job runs detached. */
function startConversion(string $name): void
{
    $path = convertSourcePath($name);
    if ($path === null) {
        throw new RuntimeException('File tidak ditemukan');
    }
    $outName = mp4NameFor($name);
    if (file_exists(VIDEO_DIR . '/' . $outName)) {
        return; // already converted
    }
    $key = cacheKey($name, $path);
    if (in_array(conversionStatus($name, $path, $key)['state'], ['queued', 'running'], true)) {
        return;
    }
    if (!is_dir(JOBS_DIR) && !@mkdir(JOBS_DIR, 0775, true)) {
        throw new RuntimeException('Folder antrean tidak bisa dibuat');
    }

    $job = jobBase($key);
    foreach (['progress', 'log', 'pid'] as $ext) {
        @unlink("$job.$ext");
    }
    $codecs = streamCodecs($path, $key);
    $plan = conversionPlan($codecs);
    $out = MEDIA_DIR . '/' . $outName;
    $part = MEDIA_DIR . '/.' . $outName . '.part';
    $ffmpeg = implode(' ', array_map('escapeshellarg',
        ffmpegConvertArgs(MEDIA_DIR . '/' . $name, $part, "$job.progress", $codecs, $plan)));

    // Paths go into shell variables once (escaped), so file names with quotes or $ are safe.
    // On cancel the whole process group gets SIGTERM: ffmpeg (or the flock wait) stops and the
    // trap cleans up. The MP4 only appears under its real name once it is complete.
    $script = strtr(<<<'SH'
    #!/bin/sh
    PART=%PART%
    OUT=%OUT%
    STATE=%STATE%
    echo $$ > %PID%
    trap 'rm -f "$PART"; echo canceled > "$STATE"; exit 1' TERM INT HUP
    exec 9> %LOCK%
    flock 9
    echo running > "$STATE"
    if %FFMPEG% 2> %LOG% && [ ! -e "$OUT" ] && mv "$PART" "$OUT"; then
      echo done > "$STATE"
    else
      rm -f "$PART"
      echo failed > "$STATE"
    fi
    SH, [
        '%PART%' => escapeshellarg($part),
        '%OUT%' => escapeshellarg($out),
        '%STATE%' => escapeshellarg("$job.state"),
        '%PID%' => escapeshellarg("$job.pid"),
        '%LOCK%' => escapeshellarg(QUEUE_LOCK),
        '%LOG%' => escapeshellarg("$job.log"),
        '%FFMPEG%' => $ffmpeg,
    ]);

    file_put_contents("$job.sh", $script);
    file_put_contents("$job.state", 'queued');
    // setsid: own process group (so cancel reaches ffmpeg too); &: this request returns at once.
    runProcess(['sh', '-c', 'setsid sh "$0" >/dev/null 2>&1 </dev/null &', "$job.sh"]);
}

function cancelConversion(string $name): void
{
    $path = convertSourcePath($name);
    if ($path === null) {
        return;
    }
    $job = jobBase(cacheKey($name, $path));
    $pid = (int) @file_get_contents("$job.pid");
    if ($pid > 1) {
        posix_kill(-$pid, SIGTERM_NUMBER); // the whole group: sh, flock, ffmpeg
    } elseif (trim((string) @file_get_contents("$job.state")) === 'queued') {
        file_put_contents("$job.state", 'canceled'); // not started yet
    }
}

function jobAlive(string $job): bool
{
    $pid = (int) @file_get_contents("$job.pid");
    return $pid > 1 && posix_kill($pid, 0);
}

/** Progress of a running job, from the tail of ffmpeg's -progress output. */
function jobProgress(string $job, float $duration): array
{
    $file = "$job.progress";
    $size = @filesize($file);
    $tail = '';
    if ($size) {
        $fh = fopen($file, 'r');
        fseek($fh, max(0, $size - 4096));
        $tail = (string) stream_get_contents($fh);
        fclose($fh);
    }
    preg_match_all('/^out_time_us=(\d+)/m', $tail, $times);
    preg_match_all('/^speed=\s*([\d.]+)x/m', $tail, $speeds);
    $seconds = $times[1] ? ((int) end($times[1])) / 1e6 : 0.0;
    $speed = $speeds[1] ? (float) end($speeds[1]) : 0.0;
    return [
        'percent' => $duration > 0 ? round(min(99.9, $seconds / $duration * 100), 1) : 0,
        'speed' => $speed,
        'eta' => $speed > 0 && $duration > 0 ? round(max(0, ($duration - $seconds) / $speed)) : null,
    ];
}

/**
 * state: idle | queued | running | converted | failed | canceled
 * plus percent/speed/eta while running and error when failed.
 */
function conversionStatus(string $name, string $path, string $key): array
{
    $converted = file_exists(VIDEO_DIR . '/' . mp4NameFor($name));
    $job = jobBase($key);
    $state = trim((string) @file_get_contents("$job.state"));

    if (in_array($state, ['queued', 'running'], true) && is_file("$job.pid") && !jobAlive($job)) {
        $state = 'failed'; // the container restarted while the job was running
        file_put_contents("$job.state", $state);
        file_put_contents("$job.log", 'Proses terhenti sebelum selesai (container di-restart?)');
    }
    if ($state === 'done' || ($converted && !in_array($state, ['queued', 'running'], true))) {
        return ['state' => 'converted'];
    }
    if ($state === '') {
        return ['state' => 'idle'];
    }
    $status = ['state' => $state];
    if ($state === 'running') {
        $status += jobProgress($job, videoInfo($path, $key)['duration']);
    }
    if ($state === 'failed') {
        $lines = array_filter(array_map('trim', explode("\n", (string) @file_get_contents("$job.log"))));
        $status['error'] = $lines ? (string) end($lines) : 'Konversi gagal';
    }
    return $status;
}

/** Every convertible file with what the page shows, including its current status. */
function listConvertible(): array
{
    $items = [];
    foreach (scandir(VIDEO_DIR) ?: [] as $name) {
        $path = convertSourcePath($name);
        if ($path === null) {
            continue;
        }
        $key = cacheKey($name, $path);
        $codecs = streamCodecs($path, $key);
        $items[] = [
            'name' => $name,
            'title' => substr($name, 0, (int) strrpos($name, '.')),
            'ext' => videoExt($name),
            'size' => filesize($path),
            'mtime' => filemtime($path),
            'key' => $key,
            'duration' => round(videoInfo($path, $key)['duration'], 2),
            'height' => $codecs['height'],
            'codecs' => ['video' => $codecs['video'], 'audio' => $codecs['audio']],
            'plan' => conversionPlan($codecs),
            'output' => mp4NameFor($name),
            'status' => conversionStatus($name, $path, $key),
        ];
    }
    return $items;
}

/** name => status, for polling. */
function conversionStatuses(): array
{
    $statuses = [];
    foreach (scandir(VIDEO_DIR) ?: [] as $name) {
        $path = convertSourcePath($name);
        if ($path !== null) {
            $statuses[$name] = conversionStatus($name, $path, cacheKey($name, $path));
        }
    }
    return $statuses;
}
