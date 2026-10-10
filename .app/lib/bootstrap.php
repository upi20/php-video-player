<?php
declare(strict_types=1);

// Shared setup for every request: paths, settings and the library functions.
define('APP_DIR', dirname(__DIR__));      // .app
define('VIDEO_DIR', dirname(__DIR__, 2)); // the folder holding the videos (also the web root)
const CACHE_DIR = '/cache';               // the only writable folder, mounted by docker-compose
const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv'];

require __DIR__ . '/process.php';
require __DIR__ . '/cache.php';
require __DIR__ . '/videos.php';
require __DIR__ . '/loudness.php';
require __DIR__ . '/storyboard.php';
require __DIR__ . '/thumbnail.php';
require __DIR__ . '/api.php';
require __DIR__ . '/view.php';
