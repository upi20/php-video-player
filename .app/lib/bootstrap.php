<?php
declare(strict_types=1);

// Shared setup for every request: paths, settings and the library functions.
define('APP_DIR', dirname(__DIR__));      // .app
// The videos live in data/, apart from the app's own files; Apache serves them from there.
define('VIDEO_DIR', dirname(__DIR__, 2) . '/data');
const VIDEO_URL = 'data/';                // URL of VIDEO_DIR, relative to the page
const CACHE_DIR = '/cache';               // generated files only: safe to delete at any time
const STATE_DIR = '/state';               // what the viewer did (watched...): must survive, never in CACHE_DIR
const MEDIA_DIR = '/media';               // data/ again, writable: converter, "Simpan ke vid" and Hapus write here
const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv'];
// Files browsers usually can't play; the Konversi page turns them into MP4.
const CONVERT_EXTS = ['ts', 'm2ts', 'mts', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'vob', '3gp'];

require __DIR__ . '/process.php';
require __DIR__ . '/cache.php';
require __DIR__ . '/videos.php';
require __DIR__ . '/loudness.php';
require __DIR__ . '/storyboard.php';
require __DIR__ . '/thumbnail.php';
require __DIR__ . '/convert.php';
require __DIR__ . '/tganalysis.php';
require __DIR__ . '/api.php';
require __DIR__ . '/view.php';
