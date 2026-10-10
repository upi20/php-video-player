<?php
declare(strict_types=1);

const THUMB_W = 480;
const THUMB_H = 270;

/** Cached JPEG cover image taken at 20% of the video, or null if it could not be made. */
function thumbnailFile(string $path, string $key, float $duration): ?string
{
    $file = cachePath($key, 'thumb.jpg');
    $built = buildOnce($file, function (string $tmp) use ($path, $duration): bool {
        $at = $duration > 0 ? min($duration * 0.2, 300) : 0;
        [$code] = runProcess([
            'ffmpeg', '-nostdin', '-v', 'error', '-ss', sprintf('%.2f', $at), '-i', $path,
            '-map', '0:v:0', '-frames:v', '1',
            '-vf', sprintf(
                'scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=%d:%d:(ow-iw)/2:(oh-ih)/2',
                THUMB_W, THUMB_H, THUMB_W, THUMB_H
            ),
            '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2', '-update', '1', $tmp,
        ]);
        return $code === 0 && is_file($tmp) && filesize($tmp) > 0;
    });
    return $built ? $file : null;
}
