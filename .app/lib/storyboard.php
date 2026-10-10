<?php
declare(strict_types=1);

// Hover previews: one frame every few seconds, tiled into sprite sheets (like YouTube's storyboards).
const SB_W = 224;
const SB_H = 126;
const SB_COLS = 8;
const SB_ROWS = 8;
const SB_MAX_FRAMES = 300; // longer videos get a wider interval instead of more frames
const SB_MIN_INTERVAL = 2; // seconds

/** Cached directory with 1.jpg, 2.jpg, ... and meta.json, or null if it could not be made. */
function storyboardDir(string $path, string $key, float $duration): ?string
{
    $dir = cachePath($key, 'storyboard');
    $built = buildOnce($dir, fn (string $tmp): bool => buildStoryboard($path, $tmp, $duration));
    return $built ? $dir : null;
}

// Decodes keyframes only (-skip_frame nokey), so even a 1 GB file takes a couple of seconds.
// Each frame shows the keyframe nearest to its slot, which is close enough for a preview.
function buildStoryboard(string $path, string $dir, float $duration): bool
{
    if ($duration <= 0 || !@mkdir($dir)) {
        return false;
    }
    $interval = max(SB_MIN_INTERVAL, (int) ceil($duration / SB_MAX_FRAMES));
    $filter = sprintf(
        'fps=1/%d,scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2,'
            . 'pad=%d:%d:(ow-iw)/2:(oh-ih)/2,tile=%dx%d',
        $interval, SB_W, SB_H, SB_W, SB_H, SB_COLS, SB_ROWS
    );
    [$code] = runProcess([
        'ffmpeg', '-nostdin', '-v', 'error', '-skip_frame', 'nokey', '-i', $path,
        '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', $filter, '-fps_mode', 'vfr', '-q:v', '5',
        $dir . '/%d.jpg',
    ]);
    $sheets = count(glob($dir . '/*.jpg') ?: []);
    if ($code !== 0 || $sheets === 0) {
        return false;
    }
    $meta = [
        'interval' => $interval,
        'cols' => SB_COLS,
        'rows' => SB_ROWS,
        'width' => SB_W,
        'height' => SB_H,
        'sheets' => $sheets,
        'frames' => (int) floor($duration / $interval) + 1,
    ];
    return file_put_contents($dir . '/meta.json', json_encode($meta)) !== false;
}
