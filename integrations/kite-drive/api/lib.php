<?php
/**
 * Pure helpers for api/index.php (token rules, upload locks, ZIP and thumbnail safety limits, cache pruning).
 * They live here so they can be tested from the command line (integrations/kite-drive/tests/lib_test.php).
 * Not reachable from the web (see api/.htaccess). The caller defines fail(int $status, string $message): never.
 */
declare(strict_types=1);

const TOKEN_MAX_LIFETIME = 3600;
/** Actions an <img>, <video> or a browser navigation reaches with a token in the address (legacy) or a header (preferred). */
const URL_TOKEN_ACTIONS = ['download', 'view', 'thumb', 'zip', 'logo'];

function base64url_decode_strict(string $s): ?string
{
    if (!preg_match('/^[A-Za-z0-9_-]+$/', $s)) {
        return null;
    }
    $decoded = base64_decode(strtr($s, '-_', '+/'), true);
    return $decoded === false ? null : $decoded;
}

/** Returns the verified token payload, or stops the request. $now is injectable for tests. */
function verify_token(string $token, string $secret, ?int $now = null): array
{
    $now ??= time();
    $parts = explode('.', $token);
    if (count($parts) !== 2) {
        fail(401, 'Invalid token');
    }
    $signature = base64url_decode_strict($parts[1]);
    if ($signature === null || !hash_equals(hash_hmac('sha256', $parts[0], $secret, true), $signature)) {
        fail(401, 'Invalid token');
    }
    $json = base64url_decode_strict($parts[0]);
    $claims = $json === null ? null : json_decode($json, true);
    if (!is_array($claims) || ($claims['aud'] ?? null) !== 'kite-drive') {
        fail(401, 'Invalid token');
    }
    $exp = $claims['exp'] ?? 0;
    $iat = $claims['iat'] ?? 0;
    if (!is_int($exp) || !is_int($iat) || $exp <= $now || $exp - $iat > TOKEN_MAX_LIFETIME) {
        fail(401, 'Token expired');
    }
    if (!in_array($claims['scope'] ?? null, ['admin', 'read', 'write', 'download', 'view'], true)) {
        fail(401, 'Invalid token');
    }
    if ($claims['scope'] !== 'admin' && (!is_int($claims['cid'] ?? null) || $claims['cid'] <= 0)) {
        fail(401, 'Invalid token');
    }
    if (array_key_exists('jti', $claims) && (!is_string($claims['jti']) || !preg_match('/^[A-Za-z0-9-]{8,64}$/', $claims['jti']))) {
        fail(401, 'Invalid token');
    }
    return $claims;
}

/**
 * Finds the token of a request and how it arrived. The X-Drive-Token header is accepted for EVERY action and wins when
 * both are sent. A token in the address ("url") exists only so a browser navigation or an old client keeps working.
 * @return array{0: string, 1: string}  [token, 'header'|'url'|'none']
 */
function drive_extract_token(array $server, array $get, string $action): array
{
    $header = (string) ($server['HTTP_X_DRIVE_TOKEN'] ?? '');
    if ($header !== '') {
        return [$header, 'header'];
    }
    if (in_array($action, URL_TOKEN_ACTIONS, true) && (string) ($get['token'] ?? '') !== '') {
        return [(string) $get['token'], 'url'];
    }
    return ['', 'none'];
}

/**
 * Rules for a token that travelled in the address (it can end up in server access logs and browser history).
 *   policy "legacy" (default, so an older web app keeps working during the release): accepted as before, but a token that
 *                   carries a jti is still single-use for download / zip.
 *   policy "strict": download and zip are SINGLE-USE (the jti is burned); view works only for the one file the token was
 *                   issued for (fid); thumb and logo are refused (send them in the header).
 * A file-bound token (fid) never opens another file, whatever the transport.
 */
function drive_check_url_token(array $claims, string $action, string $via, ?int $requestedId, string $policy, ?PDO $pdo): void
{
    if (in_array($action, ['view', 'thumb'], true) && isset($claims['fid']) && $requestedId !== null && $claims['fid'] !== $requestedId) {
        fail(403, 'This token is for a different file');
    }
    if ($via !== 'url') {
        return;
    }
    $strict = $policy === 'strict';
    switch ($action) {
        case 'download':
        case 'zip':
            if (isset($claims['jti']) || $strict) {
                if (!isset($claims['jti']) || $pdo === null || !drive_token_consume($pdo, $claims)) {
                    fail(401, 'This link was already used. Request a new one.');
                }
            }
            return;
        case 'view':
            if ($strict && ($requestedId === null || ($claims['fid'] ?? null) !== $requestedId)) {
                fail(401, 'Send this request with the token in the X-Drive-Token header.');
            }
            return;
        case 'thumb':
        case 'logo':
            if ($strict) {
                fail(401, 'Send this request with the token in the X-Drive-Token header.');
            }
            return;
    }
}

/** Burns a token id. Returns false if it was already used. Throws on a database failure (the caller fails closed). */
function drive_token_consume(PDO $pdo, array $claims): bool
{
    static $ready = false;
    if (!$ready) {
        $pdo->exec('CREATE TABLE IF NOT EXISTS drive_token_uses (jti VARCHAR(64) NOT NULL PRIMARY KEY, exp INT NOT NULL)');
        $ready = true;
    }
    $now = time();
    if (random_int(1, 50) === 1) {
        $pdo->prepare('DELETE FROM drive_token_uses WHERE exp < ?')->execute([$now - 60]);
    }
    try {
        $pdo->prepare('INSERT INTO drive_token_uses (jti, exp) VALUES (?, ?)')->execute([$claims['jti'], (int) $claims['exp']]);
    } catch (PDOException $e) {
        if ((string) $e->getCode() === '23000') {
            return false;
        }
        throw $e;
    }
    return true;
}

/** Non-blocking exclusive lock next to a file (one finisher per upload). Returns a handle, or null if somebody holds it. */
function drive_lock_try(string $path)
{
    $h = @fopen($path . '.lock', 'c');
    if ($h === false) {
        return null;
    }
    if (!flock($h, LOCK_EX | LOCK_NB)) {
        fclose($h);
        return null;
    }
    return $h;
}

function drive_unlock($handle, string $path): void
{
    // the .lock file stays (unlinking a lock another process may be opening is racy); the stale-upload sweep removes it later
    if (is_resource($handle)) {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

/**
 * Decides whether a ZIP may be unpacked, from its entry list (name, declared size, compressed size) and the free disk space.
 * @param array<int, array{size: int, comp_size: int}> $entries
 * @return array{ok: bool, reason: string}
 */
function zip_plan(array $entries, int $limit, ?float $freeBytes): array
{
    $count = count($entries);
    $total = 0;
    foreach ($entries as $e) {
        $size = max(0, (int) $e['size']);
        $comp = max(0, (int) $e['comp_size']);
        $total += $size;
        // a few hundred bytes that inflate to gigabytes
        if ($size > 52428800 && $comp > 0 && $size / $comp > 200) {
            return ['ok' => false, 'reason' => 'This ZIP compresses suspiciously well and was not unpacked. Upload it without unpacking.'];
        }
    }
    if ($count > 5000 || $total > $limit * 2) {
        return ['ok' => false, 'reason' => 'This ZIP is too large to unpack. Upload it without unpacking.'];
    }
    if ($freeBytes !== null && $total > $freeBytes * 0.8) {
        return ['ok' => false, 'reason' => 'There is not enough space left on the server to unpack this ZIP.'];
    }
    return ['ok' => true, 'reason' => ''];
}

/** memory_limit in bytes; -1 / unset means unlimited (returned as null). */
function drive_memory_limit_bytes(?string $value = null): ?int
{
    $value = trim($value ?? (string) ini_get('memory_limit'));
    if ($value === '' || $value === '-1') {
        return null;
    }
    $n = (int) $value;
    return match (strtolower(substr($value, -1))) {
        'g' => $n * 1073741824,
        'm' => $n * 1048576,
        'k' => $n * 1024,
        default => $n,
    };
}

/**
 * GD decodes an image into width x height x 4 bytes and the thumbnail step needs a second, rotated or resized copy.
 * A photo that would not fit is NOT opened (a PHP memory fatal error cannot be caught and returns a blank 500).
 */
function drive_thumb_fits_memory(int $w, int $h, ?int $limitBytes, int $usedBytes): bool
{
    if ($limitBytes === null) {
        return true;
    }
    $need = (int) ($w * $h * 4 * 2.2) + 8388608;
    return $usedBytes + $need <= $limitBytes;
}

/** Removes files older than $maxAge seconds, then the oldest ones beyond $maxFiles. Returns how many were removed. */
function drive_prune_dir(string $dir, int $maxAge, int $maxFiles): int
{
    $files = [];
    foreach (glob($dir . '/*') ?: [] as $path) {
        if (is_file($path)) {
            $files[$path] = (int) filemtime($path);
        }
    }
    $removed = 0;
    $cut = time() - $maxAge;
    foreach ($files as $path => $mtime) {
        if ($mtime < $cut && @unlink($path)) {
            unset($files[$path]);
            $removed++;
        }
    }
    if (count($files) > $maxFiles) {
        asort($files);
        foreach (array_slice(array_keys($files), 0, count($files) - $maxFiles) as $path) {
            if (@unlink($path)) {
                $removed++;
            }
        }
    }
    return $removed;
}

/** A database-wide named lock (MySQL GET_LOCK). Other drivers (the SQLite used by the tests) have no such lock and are single-writer anyway. */
function drive_named_lock(PDO $pdo, string $name, int $seconds = 5): bool
{
    if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) !== 'mysql') {
        return true;
    }
    $stmt = $pdo->prepare('SELECT GET_LOCK(?, ?)');
    $stmt->execute([substr($name, 0, 64), $seconds]);
    return (int) $stmt->fetchColumn() === 1;
}

function drive_named_unlock(PDO $pdo, string $name): void
{
    if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql') {
        $pdo->prepare('SELECT RELEASE_LOCK(?)')->execute([substr($name, 0, 64)]);
    }
}
