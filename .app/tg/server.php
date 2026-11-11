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
//   POST /watched  c=…&m=…&on=1|0     → mark a video as watched (or not) → {"watched": unix time|null}
//   POST /like  c=…&m=…&on=1|0        → add to (or remove from) Favorit → {"liked": unix time|null}
//   GET  /likes                       → the Favorit videos from every channel, last liked first (with "channel")
//   GET  /videos?c=<id>&offset=<msg>  → a page of videos in a channel, newest first (q=… to search)
//                                       add=-k: start k-1 videos newer than <msg>, which is included
//                                       (add=-(n+1)&limit=n: the n videos just newer than <msg>)
//   GET  /videos?c=<id>&index=<n>     → the same, starting at the n-th video (0 = newest), for jumping
//                                       anywhere; items stay aligned (null = not playable). limit ≤ 100
//                                       With q=…, searched here (not by Telegram) in an index of the
//                                       channel's videos: title, caption and file name, parts of words too
//                                       Every video has "dupOf": the message id of the older video in the
//                                       channel it duplicates (same size and duration), or null
//                                       sort=new|old|long|short|big|small|popular|funny|unwatched|title|random
//                                       (&seed=n for random). Once a channel has an index, every list is
//                                       answered from it, in any order: Telegram is only asked for new videos.
//   GET  /video?c=<id>&m=<msg>        → one video, with its channel
//   GET  /position?c=<id>&m=<msg>     → {"index": n}: where that video is in the channel's list (0 = newest)
//   GET  /thumb/<c>/<m>               → JPEG thumbnail
//   GET  /stream/<c>/<m>              → the video itself, with HTTP Range (seekable). Served from the
//                                       local copy when there is one; a small video is downloaded whole
//                                       first (fast, parallel), so playing and analysing share one download.
//                                       ?whole=0: never download it whole (the viewer turned analysis off)
//   GET  /saves                       → state of "Simpan ke vid" downloads
//   POST /save  c=…&m=…               → download into the video folder (queued, one at a time)
//   POST /save/cancel  c=…&m=…
//   POST /download  c=…&m=…           → fetch the whole video into /cache/tgtmp (parallel, much faster than
//                                       streaming) for the player to analyse → {"file": name}, once it's there.
//                                       The copy stays (the stream uses it too); the oldest go past COPIES_MAX_BYTES
//   POST /download/cancel  c=…&m=…    → stop that download (the viewer left the video)
//
// POSTs need the "X-Requested-With: video-player" header, like the player's own API.

use Amp\ByteStream\ReadableIterableStream;
use Amp\DeferredCancellation;
use Amp\DeferredFuture;
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
use Revolt\EventLoop;

use function Amp\async;
use function Amp\trapSignal;

require __DIR__ . '/vendor/autoload.php';

const LISTEN = '0.0.0.0:8080';
const SESSION = '/session/telegram.madeline';
const SAVES_FILE = '/session/saves.json';
const PINS_FILE = '/session/pins.json';
const WATCHED_FILE = '/session/watched.json';
const LIKES_FILE = '/session/likes.json';
const THUMB_DIR = '/cache/tg'; // thumbnails fetched once from Telegram, then served from disk
const ANALYSIS_DIR = '/cache/tgtmp'; // local copies of whole videos: streamed from here and analysed
const COPIES_MAX_BYTES = 3 * 1024 ** 3; // the least recently played copies are deleted beyond this
// Up to this size a video is downloaded whole before playing: the parallel download takes a few
// seconds and then the stream, the loudness map and the previews all read the same local file,
// instead of the stream and the analysis each pulling the video from Telegram at once.
const STREAM_WHOLE_MAX = 32 * 1024 * 1024;
const MEDIA_DIR = '/media';
const PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;    // Telegram's own limit for messages.search
const CACHE_TTL = 600;        // seconds a fetched message (with its file reference) is reused
const CHANNELS_TTL = 30;      // seconds the channel list is reused (it comes from the session's own dialog list: cheap)
// Search index: every video of a channel, fetched 100 at a time on the first search, then kept.
const INDEX_DIR = '/cache/tg/index'; // <channel>.json, so a restart doesn't fetch it all again
const INDEX_REFRESH = 900;    // seconds before newer videos are looked for again (one small request)
const INDEX_REBUILD = 86400;  // seconds before it is fetched whole again (drops deleted videos, new view counts)
const INDEX_MAX = 20000;      // videos kept per channel, the newest
const INDEX_VERSION = 2;      // items gained fields (2: views, reactions): an older index is used while rebuilt
// Orders of the list (?sort=), all made from the index; "new" is Telegram's own.
const SORTS = ['new', 'old', 'long', 'short', 'big', 'small', 'popular', 'funny', 'unwatched', 'title', 'random'];
const LAUGHS = ['😂', '🤣', '😆', '😹', '😁'];
const MESSAGE_BATCH_DELAY = 0.03; // seconds message lookups wait to be asked from Telegram together
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
    /** @var array<string, int> "c:m" => when it was watched, shown on the cards */
    private array $watched = [];
    /** @var array<string, array> "c:m" => the video as it was when liked ("liked" = when), for Favorit */
    private array $likes = [];
    /** @var array<string, array> "c:m" => save status */
    private array $saves = [];
    /** @var list<string> */
    private array $queue = [];
    private bool $saving = false;
    private ?DeferredCancellation $current = null;
    /** @var array<string, Amp\Future> "c:m" => download for the player in progress */
    private array $downloads = [];
    /** @var array<string, DeferredCancellation> "c:m" => what stops that download */
    private array $downloadCancels = [];
    /** @var array<int, array{at: int, built: int, items: list<array>}> channel => search index */
    private array $indexes = [];
    /** @var array<int, Amp\Future> channel => index being fetched (searches meanwhile wait on it) */
    private array $indexing = [];
    /** @var array<int, array<string, int>> channel => "size:duration" => oldest message with it */
    private array $dupes = [];
    /** @var array<string, DeferredFuture> "c:m" => a message lookup waiting for its batch (message()) */
    private array $lookups = [];
    /** @var array<int, array<int, true>> channel => message ids in the next batch */
    private array $lookupIds = [];

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
        $watched = is_file(WATCHED_FILE) ? json_decode((string) file_get_contents(WATCHED_FILE), true) : null;
        $this->watched = is_array($watched) ? array_filter($watched, 'is_int') : [];
        $likes = is_file(LIKES_FILE) ? json_decode((string) file_get_contents(LIKES_FILE), true) : null;
        $this->likes = is_array($likes) ? array_filter($likes, 'is_array') : [];
    }

    // ---------- Login ----------
    public function status(): array
    {
        if (!$this->api) {
            return ['state' => 'unconfigured'];
        }
        try {
            return $this->sessionStatus();
        } catch (Throwable $e) {
            // E.g. AUTH_KEY_DUPLICATED: the same session ran in two places and Telegram ended it.
            // MadelineProto can't even start then; the page offers to reset it (logout()).
            return ['state' => 'broken', 'error' => $e->getMessage()];
        }
    }

    private function sessionStatus(): array
    {
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
        try {
            $this->requireApi()->logout();
        } catch (HttpError $e) {
            throw $e;
        } catch (Throwable) {
            return $this->resetSession();
        }
        $this->messages = [];
        $this->channels = null;
        return ['state' => 'login'];
    }

    /**
     * Logging out failed because the session is broken (Telegram ended it): move it aside, kept
     * for reference, and end this process. Docker starts the container again (restart policy)
     * with no session, at the login step. A fresh process is more dependable than starting a new
     * MadelineProto instance in this one, next to the broken one.
     */
    private function resetSession(): array
    {
        try {
            if (is_dir(SESSION)) {
                rename(SESSION, SESSION . '.mati-' . gmdate('Ymd-His'));
            }
        } catch (Throwable $e) {
            throw new HttpError('Sesi tidak bisa direset: ' . $e->getMessage(), HttpStatus::INTERNAL_SERVER_ERROR);
        }
        fwrite(STDERR, "[" . gmdate('H:i:s') . "] Broken Telegram session moved aside; restarting for a fresh login\n");
        EventLoop::delay(0.5, static fn () => exit(0)); // after this answer has been sent
        return ['state' => 'restarting'];
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

    public function markWatched(int $c, int $m, bool $on): array
    {
        $key = "$c:$m";
        if ($on) {
            $this->watched[$key] ??= time();
        } else {
            unset($this->watched[$key]);
        }
        try {
            file_put_contents(WATCHED_FILE, json_encode($this->watched));
        } catch (Throwable) {
            throw new HttpError('Status ditonton tidak bisa disimpan', HttpStatus::INTERNAL_SERVER_ERROR);
        }
        return ['watched' => $this->watched[$key] ?? null];
    }

    public function like(int $c, int $m, bool $on): array
    {
        $key = "$c:$m";
        if ($on && !isset($this->likes[$key])) {
            // Keep what the cards need, so Favorit lists videos from many channels without asking
            // Telegram for each one; save/watched change over time and are added when listing.
            $item = $this->video($c, $m);
            unset($item['save'], $item['watched'], $item['liked']);
            $this->likes[$key] = ['liked' => time()] + $item;
        } elseif (!$on) {
            unset($this->likes[$key]);
        }
        try {
            file_put_contents(LIKES_FILE, json_encode($this->likes, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
        } catch (Throwable) {
            throw new HttpError('Favorit tidak bisa disimpan', HttpStatus::INTERNAL_SERVER_ERROR);
        }
        return ['liked' => $this->likes[$key]['liked'] ?? null];
    }

    public function likes(): array
    {
        $out = [];
        foreach ($this->likes as $item) {
            $out[] = $this->withState($item);
        }
        usort($out, fn ($a, $b) => $b['liked'] <=> $a['liked']);
        return $out;
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
    public function videos(
        int $c, int $offset, string $query, int $index = -1, int $limit = PAGE_SIZE, int $add = 0,
        string $sort = 'new', int $seed = 0,
    ): array {
        $api = $this->requireReady();
        $limit = max(1, min(MAX_PAGE_SIZE, $limit));
        $sort = in_array($sort, SORTS, true) ? $sort : 'new';
        // Videos in a channel hardly ever change: once it has an index, lists come from there.
        if (trim($query) !== '' || $sort !== 'new' || $this->hasIndex($c)) {
            $page = $this->fromIndex($c, $query, $sort, $seed, $offset, $index, $limit, $add);
            if ($page !== null) {
                return $page;
            }
        }
        $this->warmIndex($c); // no index yet: Telegram's own pages meanwhile
        $res = $api->messages->search(
            peer: $c,
            q: $query,
            filter: ['_' => 'inputMessagesFilterVideo'],
            min_date: 0,
            max_date: 0,
            offset_id: $index >= 0 ? 0 : $offset,
            add_offset: $index >= 0 ? $index : max(-MAX_PAGE_SIZE - 1, min(0, $add)),
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
        // More may follow when the page came back full. Opened around a video (add < 0), there
        // can be fewer newer ones than asked for: then count only the older part.
        $older = count(array_filter($messages, fn (array $msg): bool => $msg['id'] < $offset));
        $full = count($messages) >= $limit || ($index < 0 && $add < 0 && $older >= $limit + $add);
        return [
            'items' => $items,
            'total' => $res['count'] ?? count($items),
            'next' => $full && $last ? $last['id'] : null,
        ];
    }

    // ---------- Lists from the index: search and every order ----------
    // Telegram only matches whole words of captions and only lists newest first; the index finds
    // parts of words in the title, the caption and the file name, and sorts any way.

    /**
     * A page of channel $c's videos from its index, filtered by $query and in $sort order, at
     * position $index, or after / around message $offset like Telegram does (add=-k: k-1 newer
     * ones, then $offset itself). Null when $offset isn't listed (newer than the index) in the
     * plain newest-first list: Telegram is asked then.
     */
    private function fromIndex(
        int $c, string $query, string $sort, int $seed, int $offset, int $index, int $limit, int $add,
    ): ?array {
        $list = $this->listing($c, $query, $sort, $seed);
        $count = count($list);
        $start = max(0, $index);
        if ($index < 0 && $offset) {
            $at = array_search($offset, array_column($list, 'm'), true);
            if ($at === false) {
                return trim($query) === '' && $sort === 'new' ? null : ['items' => [], 'total' => $count, 'next' => null];
            }
            $start = $add < 0 ? $at + $add + 1 : $at + 1;
        }
        $end = $start + $limit;
        $page = array_slice($list, max(0, $start), max(0, $end - max(0, $start)));
        return [
            'items' => array_map($this->withState(...), $page),
            'total' => $count,
            'next' => $end < $count && $page ? end($page)['m'] : null,
        ];
    }

    /** Channel $c's indexed videos whose text contains every word of $query, in $sort order. */
    private function listing(int $c, string $query, string $sort, int $seed): array
    {
        $items = $this->index($c);
        $words = preg_split('/\s+/u', mb_strtolower(trim($query)), -1, PREG_SPLIT_NO_EMPTY);
        if ($words) {
            $items = array_values(array_filter($items, function (array $item) use ($words): bool {
                $text = mb_strtolower("{$item['title']}\n{$item['caption']}\n" . ($item['file'] ?? ''));
                foreach ($words as $word) {
                    if (!str_contains($text, $word)) {
                        return false;
                    }
                }
                return true;
            }));
        }
        return $this->sorted($c, $items, $sort, $seed);
    }

    /** $items (newest first) in $sort order; ties stay newest first (usort is stable). */
    private function sorted(int $c, array $items, string $sort, int $seed): array
    {
        if ($sort === 'random') { // the same $seed gives the same order, so pages stay consistent
            return (new Random\Randomizer(new Random\Engine\Mt19937($seed)))->shuffleArray($items);
        }
        $by = fn (string $key): Closure => fn (array $a, array $b): int => ($b[$key] ?? 0) <=> ($a[$key] ?? 0);
        $compare = match ($sort) {
            'old' => fn ($a, $b) => $a['m'] <=> $b['m'],
            // By duration in whole seconds (as the cards show it), then title, then size: copies of a
            // video, which share all three, end up next to each other.
            'long' => fn ($a, $b) => (round($b['duration']) <=> round($a['duration'])) ?: self::byTitleSize($a, $b),
            'short' => fn ($a, $b) => (round($a['duration']) <=> round($b['duration'])) ?: self::byTitleSize($a, $b),
            'big' => $by('size'),
            'small' => fn ($a, $b) => $a['size'] <=> $b['size'],
            'popular' => $by('views'),
            'funny' => fn ($a, $b) => (($b['laughs'] ?? 0) <=> ($a['laughs'] ?? 0)) ?: (($b['reacts'] ?? 0) <=> ($a['reacts'] ?? 0)),
            'unwatched' => fn ($a, $b) => isset($this->watched["$c:{$a['m']}"]) <=> isset($this->watched["$c:{$b['m']}"]),
            'title' => fn ($a, $b) => strnatcasecmp($a['title'], $b['title']),
            default => null,
        };
        if ($compare) {
            usort($items, $compare);
        }
        return $items;
    }

    private static function byTitleSize(array $a, array $b): int
    {
        return strnatcasecmp($a['title'], $b['title']) ?: ($a['size'] <=> $b['size']);
    }

    private function hasIndex(int $c): bool
    {
        return ($this->indexes[$c] ?? $this->loadIndex($c)) !== null;
    }

    /**
     * Every video of channel $c, newest first (without save/watched/liked). An old index is used as
     * it is while a fresh one is fetched in the background; only a channel without one waits.
     */
    private function index(int $c): array
    {
        $index = $this->indexes[$c] ?? $this->loadIndex($c);
        if ($index !== null) {
            $this->warmIndex($c);
            return $index['items'];
        }
        return $this->refreshIndex($c)->await()['items'];
    }

    /** The fetch of channel $c's index: newer videos only, or all of them when due a rebuild. */
    private function refreshIndex(int $c): Amp\Future
    {
        return $this->indexing[$c] ??= async(function () use ($c): array {
            try {
                $index = $this->indexes[$c] ?? null;
                $rebuild = $index === null || time() - $index['built'] > INDEX_REBUILD
                    || ($index['v'] ?? 1) !== INDEX_VERSION;
                return $this->fetchIndex($c, $rebuild ? null : $index);
            } finally {
                unset($this->indexing[$c]);
            }
        });
    }

    /** Starts refreshing channel $c's index in the background when it is old (or missing), without waiting. */
    private function warmIndex(int $c): void
    {
        $index = $this->indexes[$c] ?? $this->loadIndex($c);
        $fresh = $index !== null && time() - $index['at'] <= INDEX_REFRESH
            && time() - $index['built'] <= INDEX_REBUILD && ($index['v'] ?? 1) === INDEX_VERSION;
        if ($fresh || isset($this->indexing[$c])) {
            return;
        }
        async(function () use ($c): void {
            try {
                $this->refreshIndex($c)->await();
            } catch (Throwable) {
                // tried again on the next list
            }
        });
    }

    // ---------- Duplicates: the same video posted again (same size and duration) ----------
    // A forward is the very same file; a re-upload gets a new file id, but files of the very same
    // byte size and duration are, in practice, the same video. The oldest one counts as the original.

    private function indexDupes(int $c): void
    {
        $first = [];
        foreach ($this->indexes[$c]['items'] ?? [] as $item) {
            $key = self::dupeKey($item['size'], $item['duration']);
            if ($key !== null && (!isset($first[$key]) || $item['m'] < $first[$key])) {
                $first[$key] = $item['m'];
            }
        }
        $this->dupes[$c] = $first;
    }

    private static function dupeKey(int $size, float $duration): ?string
    {
        return $size > 0 ? $size . ':' . round($duration) : null;
    }

    /** The older video in channel $c that this one duplicates, or null (or not known yet). */
    private function dupeOf(int $c, int $size, float $duration, int $m): ?int
    {
        $key = self::dupeKey($size, $duration);
        $first = $key === null ? null : ($this->dupes[$c][$key] ?? null);
        return $first !== null && $first < $m ? $first : null;
    }

    /** Fetches the videos newer than those in $old (all of them without one), 100 per request. */
    private function fetchIndex(int $c, ?array $old): array
    {
        $api = $this->requireReady();
        $minId = $old['items'][0]['m'] ?? 0;
        $new = [];
        $offsetId = 0;
        do {
            $res = $api->messages->search(
                peer: $c,
                q: '',
                filter: ['_' => 'inputMessagesFilterVideo'],
                min_date: 0,
                max_date: 0,
                offset_id: $offsetId,
                add_offset: 0,
                limit: MAX_PAGE_SIZE,
                max_id: 0,
                min_id: $minId,
                hash: 0,
            );
            $messages = $res['messages'] ?? [];
            foreach ($messages as $message) {
                $item = $this->videoItem($c, $message);
                if ($item !== null) {
                    unset($item['save'], $item['watched'], $item['liked'], $item['dupOf']); // they change: added when answering
                    $new[] = $item;
                }
            }
            $offsetId = $messages ? end($messages)['id'] : 0;
        } while (count($messages) >= MAX_PAGE_SIZE && $offsetId && count($new) < INDEX_MAX);

        $index = [
            'v' => INDEX_VERSION,
            'at' => time(),
            'built' => $old['built'] ?? time(),
            'items' => array_slice([...$new, ...($old['items'] ?? [])], 0, INDEX_MAX),
        ];
        $this->indexes[$c] = $index;
        $this->indexDupes($c);
        try {
            if (!is_dir(INDEX_DIR)) {
                mkdir(INDEX_DIR, 0775, true);
            }
            file_put_contents(INDEX_DIR . "/$c.json.tmp", json_encode($index, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
            rename(INDEX_DIR . "/$c.json.tmp", INDEX_DIR . "/$c.json");
        } catch (Throwable) {
            // Only kept in memory then: fetched again after a restart.
        }
        return $index;
    }

    private function loadIndex(int $c): ?array
    {
        $file = INDEX_DIR . "/$c.json";
        $index = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
        if (!is_array($index) || !is_array($index['items'] ?? null)) {
            return null;
        }
        $this->indexes[$c] = $index;
        $this->indexDupes($c);
        return $index;
    }

    /** An indexed (or liked) video with its current save/watched/liked/duplicate state. */
    private function withState(array $item): array
    {
        $key = "{$item['c']}:{$item['m']}";
        return [
            'save' => $this->saveStatus($key),
            'watched' => $this->watched[$key] ?? null,
            'liked' => $this->likes[$key]['liked'] ?? null,
            'dupOf' => $this->dupeOf($item['c'], (int) ($item['size'] ?? 0), (float) ($item['duration'] ?? 0), $item['m']),
        ] + $item;
    }

    /** The position of video $m in channel $c's list in $sort order, as the grid counts (0 = first), or null. */
    public function position(int $c, int $m, string $sort = 'new', int $seed = 0): array
    {
        $sort = in_array($sort, SORTS, true) ? $sort : 'new';
        if ($sort !== 'new' || $this->hasIndex($c)) {
            $at = array_search($m, array_column($this->listing($c, '', $sort, $seed), 'm'), true);
            if ($at !== false || $sort !== 'new') {
                return ['index' => $at === false ? null : $at];
            }
        }
        $res = $this->requireReady()->messages->search(
            peer: $c,
            q: '',
            filter: ['_' => 'inputMessagesFilterVideo'],
            min_date: 0,
            max_date: 0,
            offset_id: $m,
            add_offset: -1, // answers with $m itself; offset_id_offset is then its position + 1
            limit: 1,
            max_id: 0,
            min_id: 0,
            hash: 0,
        );
        $at = $res['offset_id_offset'] ?? null;
        $found = ($res['messages'][0]['id'] ?? null) === $m;
        return ['index' => $at !== null && $found ? max(0, $at - 1) : null];
    }

    /** One video's details and its channel, for the watch page. */
    public function video(int $c, int $m): array
    {
        $api = $this->requireReady();
        if ($this->hasIndex($c)) { // from the index: no request to Telegram
            foreach ($this->index($c) as $item) {
                if ($item['m'] === $m) {
                    $chat = $api->getInfo($c)['Chat'] ?? []; // the session's own peer cache
                    return $this->withState($item) + ['channel' => ['title' => (string) ($chat['title'] ?? ''), 'username' => $chat['username'] ?? null]];
                }
            }
        }
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
        $reacts = 0;
        $laughs = 0;
        foreach ($message['reactions']['results'] ?? [] as $reaction) {
            $reacts += (int) ($reaction['count'] ?? 0);
            if (in_array($reaction['reaction']['emoticon'] ?? '', LAUGHS, true)) {
                $laughs += (int) ($reaction['count'] ?? 0);
            }
        }
        return [
            'c' => $c,
            'm' => $message['id'],
            'date' => $message['date'] ?? 0,
            'title' => self::titleFor($caption, $fileName, $message['id']),
            'caption' => $caption,
            'file' => $fileName,
            'duration' => (float) ($video['duration'] ?? 0),
            'width' => (int) ($video['w'] ?? 0),
            'height' => (int) ($video['h'] ?? 0),
            'size' => (int) ($doc['size'] ?? 0),
            'mime' => (string) ($doc['mime_type'] ?? ''),
            'thumb' => !empty($doc['thumbs']),
            'views' => (int) ($message['views'] ?? 0),
            'reacts' => $reacts,
            'laughs' => $laughs,
            'save' => $this->saveStatus($key),
            'watched' => $this->watched[$key] ?? null,
            'liked' => $this->likes[$key]['liked'] ?? null,
            'dupOf' => $this->dupeOf($c, (int) ($doc['size'] ?? 0), (float) ($video['duration'] ?? 0), $message['id']),
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

    /**
     * The raw message (cached for a while; MadelineProto refreshes expired file references itself).
     * Lookups are gathered for MESSAGE_BATCH_DELAY and asked together, up to 100 per request: a grid
     * page of new thumbnails is one request to Telegram, not one per video.
     */
    private function message(int $c, int $m): array
    {
        $key = "$c:$m";
        $hit = $this->messages[$key] ?? null;
        if ($hit && time() - $hit['at'] < CACHE_TTL) {
            return $hit['message'];
        }
        if (!isset($this->lookups[$key])) {
            $this->lookups[$key] = new DeferredFuture();
            if (empty($this->lookupIds[$c])) {
                EventLoop::delay(MESSAGE_BATCH_DELAY, fn () => $this->lookUp($c));
            }
            $this->lookupIds[$c][$m] = true;
        }
        return $this->lookups[$key]->getFuture()->await();
    }

    /** Asks Telegram for the messages waiting in channel $c's batch, and answers each waiter. */
    private function lookUp(int $c): void
    {
        $ids = array_keys($this->lookupIds[$c] ?? []);
        unset($this->lookupIds[$c]);
        foreach (array_chunk($ids, 100) as $chunk) {
            async(function () use ($c, $chunk): void {
                $found = [];
                $error = null;
                try {
                    $res = $this->requireReady()->channels->getMessages(
                        channel: $c,
                        id: array_map(fn (int $m): array => ['_' => 'inputMessageID', 'id' => $m], $chunk),
                    );
                    foreach ($res['messages'] ?? [] as $message) {
                        if (!empty($message['media']['document'])) {
                            $found[$message['id']] = $message;
                        }
                    }
                } catch (Throwable $e) {
                    $error = $e;
                }
                foreach ($chunk as $m) {
                    $waiter = $this->lookups["$c:$m"] ?? null;
                    unset($this->lookups["$c:$m"]);
                    if (isset($found[$m])) {
                        $this->messages["$c:$m"] = ['at' => time(), 'message' => $found[$m]];
                        $waiter?->complete($found[$m]);
                    } else {
                        $waiter?->error($error ?? new HttpError('Video tidak ditemukan di channel', HttpStatus::NOT_FOUND));
                    }
                }
            });
        }
    }

    // ---------- Files ----------
    public function stream(Request $request, int $c, int $m): Response
    {
        $api = $this->requireReady();
        $message = $this->message($c, $m);
        $doc = $message['media']['document'] ?? [];
        $file = $this->copyPath($c, $m);
        parse_str($request->getUri()->getQuery(), $query);
        $whole = ($query['whole'] ?? '1') !== '0';
        if ($whole && !is_file($file) && ($doc['size'] ?? PHP_INT_MAX) <= STREAM_WHOLE_MAX) {
            try {
                $this->localCopy($c, $m);
            } catch (Throwable) {
                // stream it from Telegram instead
            }
        }
        if (!is_file($file)) {
            $response = $api->downloadToResponse($message['media'], $request);
            // MadelineProto answers the open range browsers start with ("bytes=0-") with a plain
            // 200. To a browser that means "can't jump around": it then reads the file from the
            // start until it finds the index (often at the end), so a 60 MB video took ~18 s to
            // start, and seeking was slow. It is a 206 for the whole file: say so.
            $size = (int) ($doc['size'] ?? 0);
            if ($response->getStatus() === HttpStatus::OK && $size > 0
                && preg_match('/^bytes=0-$/', trim((string) $request->getHeader('range'))) === 1) {
                $response->setStatus(HttpStatus::PARTIAL_CONTENT);
                $response->setHeader('content-range', 'bytes 0-' . ($size - 1) . "/$size");
            }
            return $response;
        }
        touch($file); // recently played: kept longest by pruneCopies()
        return self::serveFile($request, $file, (string) ($doc['mime_type'] ?? '') ?: 'video/mp4');
    }

    /** A local file with HTTP Range support (206 for a range), read in chunks without blocking. */
    private static function serveFile(Request $request, string $file, string $mime): Response
    {
        $size = filesize($file);
        $start = 0;
        $end = $size - 1;
        $range = $request->getHeader('range');
        $partial = $range !== null && preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $r) === 1 && "$r[1]$r[2]" !== '';
        if ($partial) {
            if ($r[1] === '') { // the last n bytes
                $start = max(0, $size - (int) $r[2]);
            } else {
                $start = (int) $r[1];
                $end = $r[2] === '' ? $end : min($end, (int) $r[2]);
            }
            if ($start > $end) {
                return new Response(HttpStatus::RANGE_NOT_SATISFIABLE, ['content-range' => "bytes */$size"]);
            }
        }
        $length = $end - $start + 1;
        $handle = Amp\File\openFile($file, 'r');
        $handle->seek($start);
        $body = new ReadableIterableStream((function () use ($handle, $length): Generator {
            try {
                for ($left = $length; $left > 0 && ($chunk = $handle->read(length: min(256 * 1024, $left))) !== null;) {
                    $left -= strlen($chunk);
                    yield $chunk;
                }
            } finally {
                $handle->close();
            }
        })());
        $headers = [
            'content-type' => $mime,
            'content-length' => (string) $length,
            'accept-ranges' => 'bytes',
            'cache-control' => 'private, max-age=3600',
        ];
        if ($partial) {
            $headers['content-range'] = "bytes $start-$end/$size";
        }
        return new Response($partial ? HttpStatus::PARTIAL_CONTENT : HttpStatus::OK, $headers, $body);
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
        return ['file' => basename($this->localCopy($c, $m))];
    }

    private function copyPath(int $c, int $m): string
    {
        return ANALYSIS_DIR . "/{$c}_{$m}.mp4";
    }

    /**
     * The whole video in the shared cache, downloaded (in parallel) when it isn't there yet. The
     * stream and the analysis asking at the same time share one download.
     */
    private function localCopy(int $c, int $m): string
    {
        $api = $this->requireReady();
        $file = $this->copyPath($c, $m);
        if (!is_file($file)) {
            $key = "$c:$m";
            $this->downloads[$key] ??= async(function () use ($api, $c, $m, $file, $key): void {
                $tmp = $file . '.part';
                $this->downloadCancels[$key] = $cancel = new DeferredCancellation();
                try {
                    if (!is_dir(ANALYSIS_DIR)) {
                        mkdir(ANALYSIS_DIR, 0775, true);
                    }
                    $api->downloadToFile($this->message($c, $m), $tmp, null, $cancel->getCancellation());
                    rename($tmp, $file);
                } finally {
                    unset($this->downloads[$key], $this->downloadCancels[$key]);
                    if (is_file($tmp)) {
                        unlink($tmp);
                    }
                }
                $this->pruneCopies($file);
            });
            $this->downloads[$key]->await();
        }
        return $file;
    }

    /**
     * Stops the download of one video into the shared cache: the viewer left it, and it would only
     * slow the next one down. Only that video's: other tabs may be playing (and analysing) others.
     * Whoever waited on it gets an error, and it is fetched again when opened again.
     */
    public function cancelDownload(int $c, int $m): array
    {
        $cancel = $this->downloadCancels["$c:$m"] ?? null;
        $cancel?->cancel();
        return ['canceled' => $cancel !== null];
    }

    /** Deletes the least recently played copies while they take more than COPIES_MAX_BYTES. */
    private function pruneCopies(string $keep): void
    {
        $copies = [];
        foreach (glob(ANALYSIS_DIR . '/*.mp4') ?: [] as $file) {
            $copies[$file] = [filemtime($file), filesize($file)];
        }
        $total = array_sum(array_column($copies, 1));
        uasort($copies, fn ($a, $b) => $a[0] <=> $b[0]);
        foreach ($copies as $file => [, $size]) {
            if ($total <= COPIES_MAX_BYTES) {
                break;
            }
            if ($file === $keep) {
                continue;
            }
            try {
                unlink($file); // a copy being streamed right now keeps playing: the open file stays readable
                $total -= $size;
            } catch (Throwable) {
            }
        }
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
        'POST /watched' => json($bridge->markWatched($int($post, 'c'), $int($post, 'm'), ($post['on'] ?? '') === '1')),
        'POST /like' => json($bridge->like($int($post, 'c'), $int($post, 'm'), ($post['on'] ?? '') === '1')),
        'GET /likes' => json($bridge->likes()),
        'GET /videos' => json($bridge->videos(
            $int($query, 'c'),
            $int($query, 'offset'),
            (string) ($query['q'] ?? ''),
            isset($query['index']) ? $int($query, 'index') : -1,
            isset($query['limit']) ? $int($query, 'limit') : PAGE_SIZE,
            $int($query, 'add'),
            (string) ($query['sort'] ?? 'new'),
            $int($query, 'seed'),
        )),
        'GET /video' => json($bridge->video($int($query, 'c'), $int($query, 'm'))),
        'GET /position' => json($bridge->position($int($query, 'c'), $int($query, 'm'), (string) ($query['sort'] ?? 'new'), $int($query, 'seed'))),
        'GET /saves' => json($bridge->saves()),
        'POST /save' => json($bridge->save($int($post, 'c'), $int($post, 'm'))),
        'POST /download' => json($bridge->fetchForAnalysis($int($post, 'c'), $int($post, 'm'))),
        'POST /download/cancel' => json($bridge->cancelDownload($int($post, 'c'), $int($post, 'm'))),
        'POST /save/cancel' => json($bridge->cancelSave($int($post, 'c'), $int($post, 'm'))),
        default => json(['error' => 'not found'], HttpStatus::NOT_FOUND),
    };
}

$bridge = new Bridge();

// A failure that nothing awaits (e.g. a Telegram download cancelled when the network drops) ends
// up here; without a handler it stops the event loop, and with it the whole bridge, until Docker
// restarts the container. Log it and keep serving instead. (MadelineProto only installs its own
// handler in event-handler mode, which this bridge doesn't use.)
Revolt\EventLoop::setErrorHandler(static function (Throwable $e): void {
    if ($e instanceof Amp\Future\UnhandledFutureError && $e->getPrevious() !== null) {
        $e = $e->getPrevious();
    }
    if ($e instanceof Amp\SignalException) {
        throw $e; // SIGTERM from Docker: MadelineProto stops this way, let it
    }
    fwrite(STDERR, sprintf("[%s] Unhandled %s: %s\n", gmdate('H:i:s'), $e::class, $e->getMessage()));
});

// Every request comes from one address, the player's Apache: amphp's default of 10 connections
// per address made the 11th request at a time (thumbnails, streams, several tabs) fail with a 502.
$server = SocketHttpServer::createForDirectAccess(new NullLogger(), connectionLimitPerIp: 1000);
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
