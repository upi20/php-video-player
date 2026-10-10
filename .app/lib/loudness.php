<?php
declare(strict_types=1);

const LOUDNESS_STEP = 0.5;    // seconds per value
const LOUDNESS_FLOOR = -70.0; // LUFS; anything quieter counts as silence

/** Cached {"step":0.5,"values":[LUFS, ...]} file, or null if it could not be written. */
function loudnessFile(string $path, string $key): ?string
{
    $file = cachePath($key, 'loudness.json');
    $built = buildOnce($file, fn (string $tmp): bool => file_put_contents($tmp, json_encode(analyzeLoudness($path))) !== false);
    return $built ? $file : null;
}

// EBU R128 momentary loudness (how loud it sounds to the ear), reduced to the peak per step.
function analyzeLoudness(string $path): array
{
    $peaks = [];
    $time = 0.0;
    streamProcess([
        'ffmpeg', '-nostdin', '-v', 'error', '-i', $path, '-map', '0:a:0?', '-vn', '-sn', '-dn',
        '-af', 'aresample=48000,asetnsamples=n=4800:p=0,ebur128=metadata=1,'
            . 'ametadata=mode=print:key=lavfi.r128.M:file=-',
        '-f', 'null', '-',
    ], function (string $line) use (&$peaks, &$time): void {
        if (str_starts_with($line, 'frame:')) {
            if (preg_match('/pts_time:([\d.]+)/', $line, $m)) {
                $time = (float) $m[1];
            }
        } elseif (str_starts_with($line, 'lavfi.r128.M=')) {
            $i = (int) floor($time / LOUDNESS_STEP);
            $peaks[$i] = max($peaks[$i] ?? LOUDNESS_FLOOR, (float) substr($line, 13));
        }
    });

    $values = [];
    $count = $peaks ? max(array_keys($peaks)) + 1 : 0;
    for ($i = 0; $i < $count; $i++) {
        $values[] = round(max(LOUDNESS_FLOOR, $peaks[$i] ?? LOUDNESS_FLOOR), 1);
    }
    return ['step' => LOUDNESS_STEP, 'values' => $values];
}
