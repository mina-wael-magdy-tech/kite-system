<?php
/**
 * Command-line tests for api/lib.php and the request rules in api/index.php (Phase 4: SEC-02, DAT-01, PERF-04).
 *   php integrations/kite-drive/tests/lib_test.php          prints "ok ..." / "FAIL ..." lines and "RESULT passed=N failed=M"
 * Uses an in-memory SQLite database in place of MySQL (the single-use table uses portable SQL only). No network, no real Drive.
 */
declare(strict_types=1);

final class Refused extends RuntimeException
{
    public function __construct(public int $status, string $message)
    {
        parent::__construct($message);
    }
}
function fail(int $status, string $message, array $extra = []): never
{
    throw new Refused($status, $message);
}

require_once __DIR__ . '/../api/lib.php';

$passed = 0;
$failed = 0;
function check(bool $cond, string $name, string $detail = ''): void
{
    global $passed, $failed;
    if ($cond) { $passed++; echo "ok $name\n"; } else { $failed++; echo "FAIL $name $detail\n"; }
}
/** returns the HTTP status the call was refused with, or 0 when it passed */
function status_of(callable $fn): int
{
    try { $fn(); return 0; } catch (Refused $r) { return $r->status; }
}
function b64(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function sign(array $claims, string $secret): string
{
    $payload = b64(json_encode($claims));
    return $payload . '.' . b64(hash_hmac('sha256', $payload, $secret, true));
}

$secret = str_repeat('s', 40);
$now = 1_800_000_000;
$base = ['aud' => 'kite-drive', 'sub' => 'u', 'scope' => 'download', 'cid' => 7, 'fid' => 11, 'iat' => $now, 'exp' => $now + 120];

// ---- tokens
check(verify_token(sign($base, $secret), $secret, $now)['cid'] === 7, 'a correctly signed token verifies');
check(status_of(fn() => verify_token(sign($base, 'other-secret-other-secret-other-secret'), $secret, $now)) === 401, 'a token signed with another secret is refused');
check(status_of(fn() => verify_token(sign($base, $secret), $secret, $now + 121)) === 401, 'an expired token is refused');
check(status_of(fn() => verify_token(sign(['exp' => $now + 5000] + $base, $secret), $secret, $now)) === 401, 'a token valid for more than an hour is refused');
check(status_of(fn() => verify_token(sign(['jti' => 'x'] + $base, $secret), $secret, $now)) === 401, 'a malformed jti is refused');
check(verify_token(sign(['jti' => 'abcd-1234-efgh'] + $base, $secret), $secret, $now)['jti'] === 'abcd-1234-efgh', 'a well-formed jti is accepted');

// ---- where the token may come from
[$t, $via] = drive_extract_token(['HTTP_X_DRIVE_TOKEN' => 'HEAD'], ['token' => 'URL'], 'view');
check($t === 'HEAD' && $via === 'header', 'the header wins when both are sent');
foreach (URL_TOKEN_ACTIONS as $a) {
    [$t, $via] = drive_extract_token([], ['token' => 'URL'], $a);
    check($t === 'URL' && $via === 'url', "the address token is still read for $a (compatibility)");
    [$t, $via] = drive_extract_token(['HTTP_X_DRIVE_TOKEN' => 'H'], [], $a);
    check($t === 'H' && $via === 'header', "the header is accepted for $a (new)");
}
foreach (['list', 'tree', 'upload_chunk', 'delete', 'upload_complete', 'clients'] as $a) {
    [$t, $via] = drive_extract_token([], ['token' => 'URL'], $a);
    check($t === '' && $via === 'none', "a token in the address is NEVER read for $a");
}

// ---- single use + strict policy
$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$dl = ['jti' => 'jti-download-0001'] + $base;
check(status_of(fn() => drive_check_url_token($dl, 'download', 'url', null, 'legacy', $pdo)) === 0, 'download link: first use works');
check(status_of(fn() => drive_check_url_token($dl, 'download', 'url', null, 'legacy', $pdo)) === 401, 'download link: replay is refused (single use)');
check(status_of(fn() => drive_check_url_token($dl, 'download', 'header', null, 'strict', $pdo)) === 0, 'the same token in the header is not burned by the address rule');
$old = $base;   // an old web app: no jti
check(status_of(fn() => drive_check_url_token($old, 'download', 'url', null, 'legacy', $pdo)) === 0 && status_of(fn() => drive_check_url_token($old, 'download', 'url', null, 'legacy', $pdo)) === 0, 'legacy policy: an old token (no jti) keeps working as before');
check(status_of(fn() => drive_check_url_token($old, 'download', 'url', null, 'strict', $pdo)) === 401, 'strict policy: an address download token without jti is refused');
$zip = ['jti' => 'jti-zip-000000001', 'scope' => 'view'] + $base;
check(status_of(fn() => drive_check_url_token($zip, 'zip', 'url', null, 'strict', $pdo)) === 0 && status_of(fn() => drive_check_url_token($zip, 'zip', 'url', null, 'strict', $pdo)) === 401, 'strict: a zip link is single use');
$view = ['scope' => 'view', 'fid' => 11] + $base;
check(status_of(fn() => drive_check_url_token($view, 'view', 'url', 11, 'strict', $pdo)) === 0, 'strict: a view link works for its own file');
check(status_of(fn() => drive_check_url_token($view, 'view', 'url', 11, 'strict', $pdo)) === 0, 'strict: ... repeatedly (range requests of a video)');
check(status_of(fn() => drive_check_url_token($view, 'view', 'url', 12, 'strict', $pdo)) === 403, 'a file-bound view token never opens another file');
$viewAll = ['scope' => 'view'] + array_diff_key($base, ['fid' => 1]);
check(status_of(fn() => drive_check_url_token($viewAll, 'view', 'url', 11, 'strict', $pdo)) === 401, 'strict: a client-wide view token in the address is refused');
check(status_of(fn() => drive_check_url_token($viewAll, 'view', 'header', 11, 'strict', $pdo)) === 0, 'strict: the same client-wide token in the header works');
check(status_of(fn() => drive_check_url_token($viewAll, 'view', 'url', 11, 'legacy', $pdo)) === 0, 'legacy: client-wide view token in the address still works');
foreach (['thumb', 'logo'] as $a) {
    check(status_of(fn() => drive_check_url_token($viewAll, $a, 'url', 11, 'strict', $pdo)) === 401, "strict: $a in the address is refused");
    check(status_of(fn() => drive_check_url_token($viewAll, $a, 'header', 11, 'strict', $pdo)) === 0, "strict: $a in the header works");
}
check(status_of(fn() => drive_check_url_token($view, 'thumb', 'header', 99, 'legacy', $pdo)) === 403, 'a file-bound token cannot fetch another file thumbnail');

// ---- upload finish lock
$meta = sys_get_temp_dir() . '/kite-lock-' . bin2hex(random_bytes(4)) . '.json';
$h1 = drive_lock_try($meta);
check($h1 !== null, 'the first finisher gets the lock');
$h2 = drive_lock_try($meta);
check($h2 === null, 'a second finisher is turned away while the first works');
drive_unlock($h1, $meta);
$h3 = drive_lock_try($meta);
check($h3 !== null, 'the lock can be taken again after release');
drive_unlock($h3, $meta);
@unlink($meta . '.lock');

// ---- ZIP plan
$ok = fn(array $e, ?float $free = null) => zip_plan($e, 5368709120, $free)['ok'];
check($ok([['size' => 1000, 'comp_size' => 500]]), 'a normal ZIP is accepted');
check(!$ok([['size' => 3_000_000_000, 'comp_size' => 1000]]), 'a ZIP bomb (3 GB from 1 KB) is refused');
check($ok([['size' => 3_000_000_000, 'comp_size' => 2_000_000_000]]), 'a large but honest ZIP is accepted');
check(!$ok(array_fill(0, 5001, ['size' => 1, 'comp_size' => 1])), 'more than 5000 entries is refused');
check(!$ok([['size' => 6_000_000_000, 'comp_size' => 5_000_000_000], ['size' => 6_000_000_000, 'comp_size' => 5_000_000_000]]), 'more than twice the file limit is refused');
check(!$ok([['size' => 900, 'comp_size' => 800]], 1000.0), 'a ZIP that would fill the disk is refused');
check($ok([['size' => 100, 'comp_size' => 80]], 1000.0), 'a small ZIP with room left is accepted');

// ---- thumbnails
check(drive_memory_limit_bytes('128M') === 134217728 && drive_memory_limit_bytes('-1') === null && drive_memory_limit_bytes('1G') === 1073741824, 'memory_limit is parsed');
check(!drive_thumb_fits_memory(7000, 7000, 134217728, 4_000_000), 'a 49-megapixel photo is not opened with a 128 MB limit');
check(drive_thumb_fits_memory(4000, 3000, 268435456, 4_000_000), 'a 12-megapixel photo fits a 256 MB limit');
check(drive_thumb_fits_memory(9000, 9000, null, 0), 'no limit: always fits');

// ---- pruning
$dir = sys_get_temp_dir() . '/kite-prune-' . bin2hex(random_bytes(4));
mkdir($dir);
for ($i = 0; $i < 10; $i++) { file_put_contents("$dir/f$i", 'x'); touch("$dir/f$i", time() - $i * 10); }
touch("$dir/f9", time() - 90 * 86400);
check(drive_prune_dir($dir, 30 * 86400, 100) === 1 && !is_file("$dir/f9"), 'a file older than the age limit is removed');
check(drive_prune_dir($dir, 30 * 86400, 5) === 4 && count(glob("$dir/f*")) === 5 && is_file("$dir/f0"), 'beyond the count limit the OLDEST go first');
array_map('unlink', glob("$dir/*"));
rmdir($dir);

// ---- the request script itself (static): the rules above are actually wired in
$index = file_get_contents(__DIR__ . '/../api/index.php');
check(str_contains($index, 'drive_extract_token($_SERVER, $_GET, $action)'), 'index.php reads the token through drive_extract_token');
check(str_contains($index, 'drive_check_url_token('), 'index.php enforces the address-token rules');
check(str_contains($index, "header('Referrer-Policy: no-referrer')"), 'index.php sends Referrer-Policy: no-referrer');
check(str_contains($index, 'drive_lock_try($metaPath)'), 'upload_complete takes the finish lock');
check(str_contains($index, 'zip_plan('), 'extract_zip uses zip_plan');
check(!preg_match('/log_action\([^;]*\$token/', $index) && !preg_match('/error_log\([^;]*\$token/', $index), 'no log line receives the token');
check(!preg_match('/\$_GET\[.token.\]/', $index), 'index.php no longer reads $_GET[token] directly');

echo "RESULT passed=$passed failed=$failed\n";
exit($failed ? 1 : 0);
