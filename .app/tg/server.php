<?php
declare(strict_types=1);

// Telegram bridge for the video player. Logs in as the owner's own account (MTProto, via
// MadelineProto) and answers on an internal port that only the player container can reach;
// Apache there proxies /tg/* to it.
//
//   GET  /status                      → {"state": unconfigured|login|code|password|signup|ready, "me"?}
//   POST /login/phone  phone=…        → sends the login code
//   POST /login/code   code=…         → may continue with /login/password (two-step verification)
//   POST /login/password password=…
//   POST /logout
//   GET  /channels                    → channels and supergroups the account has joined (with "pinned")
//   POST /pin  c=…&on=1|0             → pin/unpin a channel as a quick button; answers like /channels
//   GET  /videos?c=<id>&offset=<msg>  → a page of videos in a channel, newest first (q=… to search)
//   GET  /videos?c=<id>&index=<n>     → the same, starting at the n-th video (0 = newest), for jumping
//                                       anywhere; items stay aligned (null = not playable). limit ≤ 100
//   GET  /video?c=<id>&m=<msg>        → one video, with its channel
//   GET  /thumb/<c>/<m>               → JPEG thumbnail
//   GET  /stream/<c>/<m>              → the video itself, with HTTP Range (seekable)
//   GET  /saves                       → state of "Simpan ke vid" downloads
//   POST /save  c=…&m=…               → download into the video folder (queued, one at a time)
//   POST /save/cancel  c=…&m=…
//   POST /download  c=…&m=…           → fetch the whole video into /cache/tgtmp (parallel, much faster than
//                                       /stream) for the player to analyse → {"file": name}, once it's there
//
// POSTs need the "X-Requested-With: video-player" header, like the player's own API.

use Amp\DeferredCancellation;
use Amp\Http\HttpStatus;
use Amp\Http\Server\DefaultErrorHandler;
use Amp\Http\Server\Request;
use Amp\Http\Server\RequestHandler\ClosureRequestHandler;
use Amp\Http\Server\Response;
use Amp\Http\Server\SocketHttpServer;
use danog\MadelineProto\API;
use danog\MadelineProto\EventHandler\Media\Thumbnail;
use danog\MadelineProto\Logger;
use danog\MadelineProto\RPCErrorException;
use danog\MadelineProto\Settings;
use Psr\Log\NullLogger;

use function Amp\async;
use function Amp\trapSignal;

require __DIR__ . '/vendor/autoload.php';

const LISTEN = '0.0.0.0:8080';
const SESSION = '/session/telegram.madeline';
const SAVES_FILE = '/session/saves.json';
const PINS_FILE = '/session/pins.json';
const THUMB_DIR = '/cache/tg'; // thumbnails fetched once from Telegram, then served from disk
const ANALYSIS_DIR = '/cache/tgtmp'; // whole videos for the player to analyse; it deletes them after
const MEDIA_DIR = '/media';
const PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;    // Telegram's own limit for messages.search
const CACHE_TTL = 600;        // seconds a fetched message (with its file reference) is reused
const CHANNELS_TTL = 300;     // seconds the channel list is reused
const THUMB_TARGET_WIDTH = 480;

// MadelineProto's IPC worker always logs to a file: MadelineProto.log next to this script by
// default, but /app is read-only for www-data. Keep it on the session volume instead
// (LOG_FILE in our settings, and the working directory for the worker's defaults).
const LOG_FILE = '/session/MadelineProto.log';
chdir('/session');

final class HttpError extends RuntimeException
{
}

final class Bridge
{
    private ?API $api = null;
    /** @var array<string, array{at: int, message: array}> "c:m" => raw message */
    private array $messages = [];
    private ?array $channels = null;
    private int $channelsAt = 0;
    /** @var list<int> pinned channel ids, shown as quick buttons */
    private array $pins = [];
    /** @var array<string, array> "c:m" => save status */
    private array $saves = [];
    /** @var list<string> */
    private array $queue = [];
    private bool $saving = false;
    private ?DeferredCancellation $current = null;
    /** @var array<string, Amp\Future> "c:m" => download for the player in progress */
    private array $downloads = [];

    public function __construct()
    {
        $apiId = (int) getenv('TG_API_ID');
        $apiHash = (string) getenv('TG_API_HASH');
        if ($apiId && $apiHash !== '') {
            $settings = (new Settings())
                ->setAppInfo((new Settings\AppInfo())
                    ->setApiId($apiId)
                    ->setApiHash($apiHash)
                    ->setDeviceModel('Video Player')
                    ->setAppVersion('1.0'))
                ->setLogger((new Settings\Logger())
                    ->setType(Logger::ECHO_LOGGER)
                    ->setExtra(LOG_FILE)
                    ->setLevel(Logger::LEVEL_WARNING));
            $this->api = new API(SESSION, $settings);
        }
        // No "@" in this file: MadelineProto's error handler turns even suppressed warnings
        // into exceptions, so check first or catch instead.
        $saved = is_file(SAVES_FILE) ? json_decode((string) file_get_contents(SAVES_FILE), true) : null;
        if (is_array($saved)) {
            // Only finished saves survive a restart; anything in flight is reported as failed.
            foreach ($saved as $key => $save) {
                $this->saves[$key] = in_array($save['state'], ['queued', 'running'], true)
                    ? ['state' => 'failed', 'error' => 'Terhenti karena container di-restart'] + $save
                    : $save;
            }
        }
        $pins = is_file(PINS_FILE) ? json_decode((string) file_get_contents(PINS_FILE), true) : null;
        $this->pins = is_array($pins) ? array_values(array_filter($pins, 'is_int')) : [];
    }

    // ---------- Login ----------
    public function status(): array
    {
        if (!$this->api) {
            return ['state' => 'unconfigured'];
        }
        $state = match ($this->api->getAuthorization()) {
            API::LOGGED_IN => 'ready',
            API::WAITING_CODE => 'code',
            API::WAITING_PASSWORD => 'password',
            API::WAITING_SIGNUP => 'signup',
            default => 'login',
        };
        if ($state !== 'ready') {
            return ['state' => $state];
        }
        $self = $this->api->getSelf() ?: [];
        return ['state' => 'ready', 'me' => [
            'name' => trim(($self['first_name'] ?? '') . ' ' . ($self['last_name'] ?? '')),
            'username' => $self['username'] ?? null,
        ]];
    }

    public function login(string $step, array $post): array
    {
        $api = $this->requireApi();
        match ($step) {
            'phone' => $api->phoneLogin(trim((string) ($post['phone'] ?? ''))),
            'code' => $api->completePhoneLogin(trim((string) ($post['code'] ?? ''))),
            'password' => $api->complete2faLogin((string) ($post['password'] ?? '')),
            default => throw new HttpError('Langkah login tidak dikenal', HttpStatus::NOT_FOUND),
        };
        return $this->status();
    }

    public function logout(): array
    {
        $this->requireApi()->logout();
        $this->messages = [];
        $this->channels = null;
        return ['state' => 'login'];
    }

    // ---------- Browsing ----------
    /** Channels and supergroups the account is in, sorted by title, each marked pinned or not. */
    public function channels(): array
    {
        if ($this->channels === null || time() - $this->channelsAt >= CHANNELS_TTL) {
            $this->channels = $this->fetchChannels();
            $this->channelsAt = time();
        }
        return array_map(fn (array $ch): array => $ch + ['pinned' => in_array($ch['id'], $this->pins, true)], $this->channels);
    }

    public function pin(int $c, bool $on): array
    {
        $this->pins = array_values(array_diff($this->pins, [$c]));
        if ($on) {
            $this->pins[] = $c;
        }
        try {
            file_put_contents(PINS_FILE, json_encode($this->pins));
        } catch (Throwable) {
            throw new HttpError('Pin tidak bisa disimpan', HttpStatus::INTERNAL_SERVER_ERROR);
        }
        return $this->channels();
    }

    private function fetchChannels(): array
    {
        $api = $this->requireReady();
        $list = [];
        foreach ($api->getDialogIds() as $id) {
            if ($id >= 0) {
                continue; // users and bots
            }
            try {
                $info = $api->getInfo($id);
            } catch (Throwable) {
                continue;
            }
            if (!in_array($info['type'] ?? '', ['channel', 'supergroup'], true)) {
                continue;
            }
            $list[] = [
                'id' => $id,
                'title' => (string) ($info['Chat']['title'] ?? $id),
                'username' => $info['Chat']['username'] ?? null,
                'type' => $info['type'],
            ];
        }
        usort($list, fn ($a, $b) => strnatcasecmp($a['title'], $b['title']));
        return $list;
    }

    /**
     * One page of videos in channel $c, newest first. Continue from the last id with $offset, or
     * pass $index (≥ 0) to start at that position; then item k is video $index + k, null if unplayable.
     */
    public function videos(int $c, int $offset, string $query, int $index = -1, int $limit = PAGE_SIZE): array
    {
        $api = $this->requireReady();
        $limit = max(1, min(MAX_PAGE_SIZE, $limit));
        $res = $api->messages->search(
            peer: $c,
            q: $query,
            filter: ['_' => 'inputMessagesFilterVideo'],
            min_date: 0,
            max_date: 0,
            offset_id: $index >= 0 ? 0 : $offset,
            add_offset: max(0, $index),
            limit: $limit,
            max_id: 0,
            min_id: 0,
            hash: 0,
        );
        $messages = $res['messages'] ?? [];
        $items = [];
        foreach ($messages as $message) {
            $item = $this->videoItem($c, $message);
            if ($item !== null) {
                $this->messages["$c:{$message['id']}"] = ['at' => time(), 'message' => $message];
            }
            if ($item !== null || $index >= 0) {
                $items[] = $item;
            }
        }
        $last = $messages ? end($messages) : null;
        return [
            'items' => $items,
            'total' => $res['count'] ?? count($items),
            'next' => count($messages) >= $limit && $last ? $last['id'] : null,
        ];
    }

    /** One video's details and its channel, for the watch page. */
    public function video(int $c, int $m): array
    {
        $api = $this->requireReady();
        $item = $this->videoItem($c, $this->message($c, $m))
            ?? throw new HttpError('Pesan ini bukan video', HttpStatus::NOT_FOUND);
        $chat = $api->getInfo($c)['Chat'] ?? [];
        return $item + ['channel' => ['title' => (string) ($chat['title'] ?? ''), 'username' => $chat['username'] ?? null]];
    }

    private function videoItem(int $c, array $message): ?array
    {
        $doc = $message['media']['document'] ?? null;
        if (!is_array($doc)) {
            return null;
        }
        $video = [];
        $fileName = '';
        foreach ($doc['attributes'] ?? [] as $attr) {
            if ($attr['_'] === 'documentAttributeVideo') {
                $video = $attr;
            } elseif ($attr['_'] === 'documentAttributeFilename') {
                $fileName = (string) $attr['file_name'];
            }
        }
        $caption = trim((string) ($message['message'] ?? ''));
        $key = "$c:{$message['id']}";
        return [
            'c' => $c,
            'm' => $message['id'],
            'date' => $message['date'] ?? 0,
            'title' => self::titleFor($caption, $fileName, $message['id']),
            'caption' => $caption,
            'duration' => (float) ($video['duration'] ?? 0),
            'width' => (int) ($video['w'] ?? 0),
            'height' => (int) ($video['h'] ?? 0),
            'size' => (int) ($doc['size'] ?? 0),
            'mime' => (string) ($doc['mime_type'] ?? ''),
            'thumb' => !empty($doc['thumbs']),
            'save' => $this->saveStatus($key),
        ];
    }

    private static function titleFor(string $caption, string $fileName, int $id): string
    {
        $line = trim(strtok($caption, "\n") ?: '');
        if ($line !== '') {
            return mb_strimwidth($line, 0, 140, '…');
        }
        if ($fileName !== '') {
            return pathinfo($fileName, PATHINFO_FILENAME);
        }
        return "Video #$id";
    }

    /** The raw message (cached for a while; MadelineProto refreshes expired file references itself). */
    private function message(int $c, int $m): array
    {
        $key = "$c:$m";
        $hit = $this->messages[$key] ?? null;
        if ($hit && time() - $hit['at'] < CACHE_TTL) {
            return $hit['message'];
        }
        $res = $this->requireReady()->channels->getMessages(channel: $c, id: [['_' => 'inputMessageID', 'id' => $m]]);
        $message = $res['messages'][0] ?? null;
        if (!is_array($message) || empty($message['media']['document'])) {
            throw new HttpError('Video tidak ditemukan di channel', HttpStatus::NOT_FOUND);
        }
        $this->messages[$key] = ['at' => time(), 'message' => $message];
        return $message;
    }

    // ---------- Files ----------
    public function stream(Request $request, int $c, int $m): Response
    {
        return $this->requireReady()->downloadToResponse($this->message($c, $m)['media'], $request);
    }

    public function thumb(Request $request, int $c, int $m): Response
    {
        $file = THUMB_DIR . "/{$c}_{$m}.jpg";
        if (!is_file($file)) {
            $this->fetchThumb($c, $m, $file);
        }
        return new Response(HttpStatus::OK, [
            'content-type' => 'image/jpeg',
            'cache-control' => 'private, max-age=604800',
        ], (string) file_get_contents($file));
    }

    private function fetchThumb(int $c, int $m, string $file): void
    {
        $api = $this->requireReady();
        $media = $api->wrapMedia($this->message($c, $m)['media']);
        // Real (downloadable) thumbnails, smallest first: take the first one wide enough.
        $thumbs = array_values(array_filter($media?->thumbs ?? [], fn ($t) => $t instanceof Thumbnail));
        if (!$thumbs) {
            throw new HttpError('Tidak ada thumbnail', HttpStatus::NOT_FOUND);
        }
        $pick = end($thumbs);
        foreach ($thumbs as $thumb) {
            if ($thumb->width >= THUMB_TARGET_WIDTH) {
                $pick = $thumb;
                break;
            }
        }
        if (!is_dir(THUMB_DIR)) {
            mkdir(THUMB_DIR, 0775, true);
        }
        $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.part';
        try {
            $pick->downloadToFile($tmp);
            rename($tmp, $file);
        } finally {
            if (is_file($tmp)) {
                unlink($tmp);
            }
        }
    }

    /**
     * Downloads a whole video into ANALYSIS_DIR for the player's loudness map and previews.
     * downloadToFile fetches many parts in parallel (the stream is one part at a time). A second
     * request for the same video waits for the same download.
     */
    public function fetchForAnalysis(int $c, int $m): array
    {
        $api = $this->requireReady();
        $file = ANALYSIS_DIR . "/{$c}_{$m}.mp4";
        if (!is_file($file)) {
            $key = "$c:$m";
            $this->downloads[$key] ??= async(function () use ($api, $c, $m, $file, $key): void {
                $tmp = $file . '.part';
                try {
                    if (!is_dir(ANALYSIS_DIR)) {
                        mkdir(ANALYSIS_DIR, 0775, true);
                    }
                    $api->downloadToFile($this->message($c, $m), $tmp);
                    rename($tmp, $file);
                } finally {
                    unset($this->downloads[$key]);
                    if (is_file($tmp)) {
                        unlink($tmp);
                    }
                }
            });
            $this->downloads[$key]->await();
        }
        return ['file' => basename($file)];
    }

    // ---------- "Simpan ke vid": downloads into the video folder, one at a time ----------
    public function saves(): array
    {
        $out = [];
        foreach (array_keys($this->saves) as $key) {
            $out[$key] = $this->saveStatus($key);
        }
        return $out;
    }

    private function saveStatus(string $key): array
    {
        $save = $this->saves[$key] ?? null;
        if ($save === null) {
            return ['state' => 'idle'];
        }
        if ($save['state'] === 'done' && !is_file(MEDIA_DIR . '/' . $save['file'])) {
            return ['state' => 'idle']; // the saved file was deleted since
        }
        return $save;
    }

    public function save(int $c, int $m): array
    {
        $this->requireReady();
        $key = "$c:$m";
        if (in_array($this->saveStatus($key)['state'], ['queued', 'running', 'done'], true)) {
            return $this->saveStatus($key);
        }
        $this->message($c, $m); // fail early if the video is gone
        $this->saves[$key] = ['state' => 'queued'];
        $this->queue[] = $key;
        $this->persistSaves();
        if (!$this->saving) {
            $this->saving = true;
            async($this->runQueue(...));
        }
        return $this->saves[$key];
    }

    public function cancelSave(int $c, int $m): array
    {
        $key = "$c:$m";
        $state = $this->saves[$key]['state'] ?? null;
        if ($state === 'queued') {
            $this->queue = array_values(array_diff($this->queue, [$key]));
            $this->saves[$key] = ['state' => 'canceled'];
            $this->persistSaves();
        } elseif ($state === 'running') {
            $this->current?->cancel();
        }
        return $this->saveStatus($key);
    }

    private function runQueue(): void
    {
        try {
            while ($key = array_shift($this->queue)) {
                $this->download($key);
            }
        } finally {
            $this->saving = false;
        }
    }

    private function download(string $key): void
    {
        [$c, $m] = array_map('intval', explode(':', $key));
        $part = null;
        try {
            $message = $this->message($c, $m);
            $file = $this->fileNameFor($c, $message);
            $part = MEDIA_DIR . '/.' . $file . '.part'; // hidden until complete, like conversions
            $this->current = new DeferredCancellation();
            $this->saves[$key] = ['state' => 'running', 'percent' => 0, 'speed' => 0, 'file' => $file];
            $this->requireReady()->downloadToFile(
                $message['media'],
                $part,
                function (float $percent, float $speed) use ($key): void {
                    $this->saves[$key]['percent'] = round($percent, 1);
                    $this->saves[$key]['speed'] = round($speed, 2); // Mbit/s
                },
                $this->current->getCancellation(),
            );
            if (!rename($part, MEDIA_DIR . '/' . $file)) {
                throw new RuntimeException('File tidak bisa dipindahkan ke folder video');
            }
            $this->saves[$key] = ['state' => 'done', 'file' => $file];
        } catch (Amp\CancelledException) {
            $this->saves[$key] = ['state' => 'canceled'];
        } catch (Throwable $e) {
            $this->saves[$key] = ['state' => 'failed', 'error' => $e->getMessage()];
        } finally {
            $this->current = null;
            if ($part !== null && is_file($part)) {
                try {
                    unlink($part);
                } catch (Throwable) {
                }
            }
            $this->persistSaves();
        }
    }

    /** "<caption or file name>.<ext>", made safe and unique in the video folder. */
    private function fileNameFor(int $c, array $message): string
    {
        $item = $this->videoItem($c, $message) ?? ['title' => "Video #{$message['id']}", 'mime' => ''];
        $base = preg_replace('/[\\\\\/:*?"<>|\x00-\x1f]+/u', ' ', $item['title']);
        $base = trim(preg_replace('/\s+/u', ' ', $base), " .");
        $base = mb_substr($base !== '' ? $base : "Video {$message['id']}", 0, 150);
        $ext = match ($item['mime']) {
            'video/x-matroska' => 'mkv',
            'video/quicktime' => 'mov',
            'video/webm' => 'webm',
            'video/mp2t' => 'ts',
            default => 'mp4',
        };
        $name = "$base.$ext";
        if (file_exists(MEDIA_DIR . "/$name")) {
            $name = "$base ({$message['id']}).$ext";
        }
        return $name;
    }

    private function persistSaves(): void
    {
        try {
            file_put_contents(SAVES_FILE, json_encode($this->saves, JSON_UNESCAPED_UNICODE));
        } catch (Throwable) {
            // Only the history of finished saves is lost; downloads themselves are unaffected.
        }
    }

    // ---------- Helpers ----------
    private function requireApi(): API
    {
        return $this->api ?? throw new HttpError('TG_API_ID dan TG_API_HASH belum diisi di file .env', HttpStatus::SERVICE_UNAVAILABLE);
    }

    private function requireReady(): API
    {
        $api = $this->requireApi();
        if ($api->getAuthorization() !== API::LOGGED_IN) {
            throw new HttpError('Belum login ke Telegram', HttpStatus::UNAUTHORIZED);
        }
        return $api;
    }
}

function json(mixed $data, int $status = HttpStatus::OK): Response
{
    return new Response($status, [
        'content-type' => 'application/json; charset=utf-8',
        'cache-control' => 'no-store',
    ], json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
}

function route(Bridge $bridge, Request $request): Response
{
    $method = $request->getMethod();
    $path = rtrim($request->getUri()->getPath(), '/') ?: '/';
    parse_str($request->getUri()->getQuery(), $query);

    $post = [];
    if ($method === 'POST') {
        if ($request->getHeader('x-requested-with') !== 'video-player') {
            throw new HttpError('use POST from the app', HttpStatus::METHOD_NOT_ALLOWED);
        }
        parse_str($request->getBody()->buffer(), $post);
    }
    $int = fn (array $from, string $key): int => (int) ($from[$key] ?? 0);

    if (preg_match('#^/(stream|thumb)/(-?\d+)/(\d+)$#', $path, $m) && in_array($method, ['GET', 'HEAD'], true)) {
        return $m[1] === 'stream'
            ? $bridge->stream($request, (int) $m[2], (int) $m[3])
            : $bridge->thumb($request, (int) $m[2], (int) $m[3]);
    }

    return match ("$method $path") {
        'GET /status' => json($bridge->status()),
        'POST /login/phone' => json($bridge->login('phone', $post)),
        'POST /login/code' => json($bridge->login('code', $post)),
        'POST /login/password' => json($bridge->login('password', $post)),
        'POST /logout' => json($bridge->logout()),
        'GET /channels' => json($bridge->channels()),
        'POST /pin' => json($bridge->pin($int($post, 'c'), ($post['on'] ?? '') === '1')),
        'GET /videos' => json($bridge->videos(
            $int($query, 'c'),
            $int($query, 'offset'),
            (string) ($query['q'] ?? ''),
            isset($query['index']) ? $int($query, 'index') : -1,
            isset($query['limit']) ? $int($query, 'limit') : PAGE_SIZE,
        )),
        'GET /video' => json($bridge->video($int($query, 'c'), $int($query, 'm'))),
        'GET /saves' => json($bridge->saves()),
        'POST /save' => json($bridge->save($int($post, 'c'), $int($post, 'm'))),
        'POST /download' => json($bridge->fetchForAnalysis($int($post, 'c'), $int($post, 'm'))),
        'POST /save/cancel' => json($bridge->cancelSave($int($post, 'c'), $int($post, 'm'))),
        default => json(['error' => 'not found'], HttpStatus::NOT_FOUND),
    };
}

$bridge = new Bridge();

$server = SocketHttpServer::createForDirectAccess(new NullLogger());
$server->expose(LISTEN);
$server->start(new ClosureRequestHandler(static function (Request $request) use ($bridge): Response {
    try {
        return route($bridge, $request);
    } catch (HttpError $e) {
        return json(['error' => $e->getMessage()], $e->getCode());
    } catch (RPCErrorException $e) {
        // e.g. PHONE_CODE_INVALID, PASSWORD_HASH_INVALID, FLOOD_WAIT_x
        return json(['error' => $e->rpc], HttpStatus::BAD_REQUEST);
    } catch (Throwable $e) {
        return json(['error' => $e->getMessage()], HttpStatus::INTERNAL_SERVER_ERROR);
    }
}), new DefaultErrorHandler());

fwrite(STDERR, 'Telegram bridge listening on ' . LISTEN . PHP_EOL);
trapSignal([SIGINT, SIGTERM]);
$server->stop();
