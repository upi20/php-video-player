<?php
declare(strict_types=1);

/** Runs a command without a shell, calling $onLine for each stdout line. Returns the exit code. */
function streamProcess(array $cmd, callable $onLine): int
{
    $proc = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
    if (!is_resource($proc)) {
        return -1;
    }
    while (($line = fgets($pipes[1])) !== false) {
        $onLine($line);
    }
    fclose($pipes[1]);
    return proc_close($proc);
}

/** Runs a command without a shell. Returns [exit code, stdout]. */
function runProcess(array $cmd): array
{
    $out = '';
    $code = streamProcess($cmd, function (string $line) use (&$out): void {
        $out .= $line;
    });
    return [$code, $out];
}
