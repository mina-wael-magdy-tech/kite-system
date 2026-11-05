<?php
/**
 * Kite Drive API: lets the Kite System browse a client's Drive and upload to it.
 *
 * Callers never log in here. The Kite System's `kite-drive` Edge Function checks who the staff member is
 * and what they may do, then signs a short-lived token with the secret both sides share. Every token is
 * locked to one Drive client (except scope "admin", which can only list clients). See docs/kite-drive.md.
 */
declare(strict_types=1);

const TOKEN_MAX_LIFETIME = 3600;
const DEFAULT_MAX_FILE_BYTES = 5368709120; // 5 GB
const DEFAULT_CHUNK_BYTES = 8388608;       // 8 MB
const STALE_UPLOAD_SECONDS = 172800;       // unfinished uploads are removed after 2 days
const FILE_TYPE_COLUMN_MAX = 50;           // files.file_type is varchar(50)
const BLOCKED_EXTENSIONS = [
    'php', 'php3', 'php4', 'php5', 'php7', 'php8', 'phtml', 'pht', 'phar', 'phps', 'cgi', 'pl', 'py', 'sh',
    'asp', 'aspx', 'jsp', 'shtml', 'htaccess', 'htpasswd', 'ini', 'exe', 'bat', 'cmd', 'com', 'scr', 'msi',
];

function fail(int $status, string $message, array $extra = []): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message] + $extra);
    exit;
}

function ok(array $body): never
{
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($body);
    exit;
}

function base64url_decode_strict(string $s): ?string
{
    if (!preg_match('/^[A-Za-z0-9_-]+$/', $s)) {
        return null;
    }
    $decoded = base64_decode(strtr($s, '-_', '+/'), true);
    return $decoded === false ? null : $decoded;
}

/** Returns the verified token payload, or stops the request. */
function verify_token(string $token, string $secret): array
{
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
    if (!is_int($exp) || !is_int($iat) || $exp <= time() || $exp - $iat > TOKEN_MAX_LIFETIME) {
        fail(401, 'Token expired');
    }
    if (!in_array($claims['scope'] ?? null, ['admin', 'read', 'write', 'download'], true)) {
        fail(401, 'Invalid token');
    }
    if ($claims['scope'] !== 'admin' && (!is_int($claims['cid'] ?? null) || $claims['cid'] <= 0)) {
        fail(401, 'Invalid token');
    }
    return $claims;
}

function require_scope(array $claims, array $scopes): void
{
    if (!in_array($claims['scope'], $scopes, true)) {
        fail(403, 'This token cannot do that');
    }
}

function json_body(): array
{
    $body = json_decode((string) file_get_contents('php://input', false, null, 0, 16384), true);
    if (!is_array($body)) {
        fail(400, 'Body must be a JSON object');
    }
    return $body;
}

function int_or_null(mixed $v): ?int
{
    if ($v === null || $v === '' || $v === 'null') {
        return null;
    }
    if (filter_var($v, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false) {
        fail(400, 'Invalid id');
    }
    return (int) $v;
}

/** A folder can only be used by the Drive client who owns it. */
function assert_folder(PDO $pdo, int $clientId, ?int $folderId): void
{
    if ($folderId === null) {
        return;
    }
    $stmt = $pdo->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?');
    $stmt->execute([$folderId, $clientId]);
    if (!$stmt->fetchColumn()) {
        fail(404, 'Folder not found');
    }
}

function ini_bytes(string $key): int
{
    $value = trim((string) ini_get($key));
    $number = (int) $value;
    return match (strtolower(substr($value, -1))) {
        'g' => $number * 1073741824,
        'm' => $number * 1048576,
        'k' => $number * 1024,
        default => $number,
    };
}

/** The largest chunk this server accepts, leaving room for request overhead. */
function chunk_bytes(array $config): int
{
    $wanted = (int) ($config['chunk_bytes'] ?? DEFAULT_CHUNK_BYTES);
    $limit = ini_bytes('post_max_size');
    if ($limit > 0) {
        $wanted = min($wanted, (int) floor($limit * 0.9));
    }
    return max(262144, $wanted);
}

/** Display name: no path, no control characters. Returns null when nothing usable is left. */
function clean_display_name(mixed $name): ?string
{
    if (!is_string($name)) {
        return null;
    }
    $name = preg_replace('/[\x00-\x1F\x7F]/u', '', str_replace('\\', '/', $name));
    if ($name === null) {
        return null;
    }
    // Trailing dots and spaces go, but not leading ones: ".htaccess" has to reach the blocked-type check.
    $name = rtrim(ltrim(basename($name), " \t"), " .\t");
    if ($name === '') {
        return null;
    }
    // Keep the extension when shortening: files.original_name is varchar(255).
    if (mb_strlen($name) > 200) {
        $ext = pathinfo($name, PATHINFO_EXTENSION);
        $name = $ext !== '' && mb_strlen($ext) <= 16
            ? mb_substr($name, 0, 199 - mb_strlen($ext)) . '.' . $ext
            : mb_substr($name, 0, 200);
    }
    return $name;
}

/** Checks every dotted part, so "logo.php.jpg" is refused as well as "logo.php". */
function has_blocked_extension(string $name): bool
{
    $parts = explode('.', strtolower($name));
    array_shift($parts);
    return (bool) array_intersect($parts, BLOCKED_EXTENSIONS);
}

function storage_name(string $displayName): string
{
    $ext = strtolower((string) pathinfo($displayName, PATHINFO_EXTENSION));
    $ext = preg_replace('/[^a-z0-9]/', '', $ext) ?? '';
    $stem = (string) pathinfo($displayName, PATHINFO_FILENAME);
    $stem = trim((string) preg_replace('/[^A-Za-z0-9_-]+/', '_', $stem), '_');
    $stem = substr($stem, 0, 80);
    return bin2hex(random_bytes(8)) . ($stem !== '' ? '_' . $stem : '') . ($ext !== '' ? '.' . $ext : '');
}

function detect_file_type(string $path): string
{
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path) ?: 'application/octet-stream';
    return strlen($mime) <= FILE_TYPE_COLUMN_MAX ? $mime : 'application/octet-stream';
}

function chunks_dir(): string
{
    $dir = __DIR__ . '/_chunks';
    if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
        fail(500, 'Could not prepare the upload folder');
    }
    return $dir;
}

function upload_paths(string $id): array
{
    if (!preg_match('/^[a-f0-9]{32}$/', $id)) {
        fail(404, 'Upload not found');
    }
    $dir = chunks_dir();
    return ["$dir/$id.json", "$dir/$id.part"];
}

/** Loads an upload and makes sure it belongs to the client this token is locked to. */
function load_upload(string $metaPath, array $claims): array
{
    $meta = is_file($metaPath) ? json_decode((string) file_get_contents($metaPath), true) : null;
    if (!is_array($meta) || ($meta['cid'] ?? null) !== $claims['cid']) {
        fail(404, 'Upload not found');
    }
    return $meta;
}

function remove_stale_uploads(): void
{
    foreach (glob(chunks_dir() . '/*') ?: [] as $path) {
        if (filemtime($path) < time() - STALE_UPLOAD_SECONDS) {
            @unlink($path);
        }
    }
}

// ---------------------------------------------------------------- request setup
$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    fail(503, 'Kite Drive API is not configured');
}
$config = require $configPath;
$secret = (string) ($config['secret'] ?? '');
if (strlen($secret) < 32) {
    fail(503, 'Kite Drive API is not configured');
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    if (!in_array($origin, (array) ($config['allowed_origins'] ?? []), true)) {
        fail(403, 'Origin not allowed');
    }
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('X-Content-Type-Options: nosniff');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    header('Access-Control-Allow-Headers: X-Drive-Token, Content-Type');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Max-Age: 600');
    http_response_code(204);
    exit;
}

$action = (string) ($_GET['action'] ?? '');
// Only downloads take the token in the URL: they open as a normal browser navigation, and live for minutes.
$token = $action === 'download' ? (string) ($_GET['token'] ?? '') : (string) ($_SERVER['HTTP_X_DRIVE_TOKEN'] ?? '');
if ($token === '') {
    fail(401, 'Missing token');
}
$claims = verify_token($token, $secret);
$clientId = $claims['cid'] ?? null;

define('SECURE_ACCESS', true);
require dirname(__DIR__) . '/db.php';
$driveRoot = dirname(__DIR__);

// A token signed for a client that was since deleted from Drive must not write anything.
if ($clientId !== null) {
    $stmt = $pdo->prepare("SELECT 1 FROM users WHERE id = ? AND role = 'client'");
    $stmt->execute([$clientId]);
    if (!$stmt->fetchColumn()) {
        fail(404, 'Drive client not found');
    }
}

// ---------------------------------------------------------------- actions
switch ($action) {
    case 'clients':
        require_scope($claims, ['admin']);
        $rows = $pdo->query("SELECT id, name, email FROM users WHERE role = 'client' ORDER BY name")->fetchAll();
        ok(['clients' => array_map(
            fn($r) => ['id' => (int) $r['id'], 'name' => $r['name'], 'email' => $r['email']],
            $rows
        )]);

    case 'list':
        require_scope($claims, ['read', 'write']);
        $folderId = int_or_null($_GET['folder'] ?? null);
        assert_folder($pdo, $clientId, $folderId);

        $folders = $pdo->prepare('SELECT id, name FROM folders WHERE user_id = ? AND parent_id ' . ($folderId ? '= ?' : 'IS NULL') . ' ORDER BY name');
        $folders->execute($folderId ? [$clientId, $folderId] : [$clientId]);
        $files = $pdo->prepare('SELECT id, original_name, file_type, file_path, filename, uploaded_at FROM files WHERE user_id = ? AND folder_id ' . ($folderId ? '= ?' : 'IS NULL') . ' ORDER BY uploaded_at DESC, id DESC');
        $files->execute($folderId ? [$clientId, $folderId] : [$clientId]);

        require __DIR__ . '/send.php';
        $breadcrumb = [];
        $parent = $pdo->prepare('SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?');
        for ($id = $folderId, $depth = 0; $id !== null && $depth < 64; $depth++) {
            $parent->execute([$id, $clientId]);
            $row = $parent->fetch();
            if (!$row) {
                break;
            }
            array_unshift($breadcrumb, ['id' => (int) $row['id'], 'name' => $row['name']]);
            $id = $row['parent_id'] === null ? null : (int) $row['parent_id'];
        }

        ok([
            'folder' => $folderId,
            'breadcrumb' => $breadcrumb,
            'folders' => array_map(fn($r) => ['id' => (int) $r['id'], 'name' => $r['name']], $folders->fetchAll()),
            'files' => array_map(function ($r) use ($driveRoot) {
                $path = drive_resolve_path($driveRoot, $r['file_path'], $r['filename']);
                return [
                    'id' => (int) $r['id'],
                    'name' => $r['original_name'],
                    'type' => $r['file_type'],
                    'size' => $path ? filesize($path) : null,
                    'at' => $r['uploaded_at'],
                ];
            }, $files->fetchAll()),
        ]);

    case 'download':
        require_scope($claims, ['download']);
        if (!is_int($claims['fid'] ?? null)) {
            fail(401, 'Invalid token');
        }
        $stmt = $pdo->prepare('SELECT original_name, file_type, file_path, filename FROM files WHERE id = ? AND user_id = ?');
        $stmt->execute([$claims['fid'], $clientId]);
        $file = $stmt->fetch();
        if (!$file) {
            fail(404, 'File not found');
        }
        require __DIR__ . '/send.php';
        $path = drive_resolve_path($driveRoot, $file['file_path'], $file['filename']);
        if (!$path) {
            fail(404, 'File is missing from the server');
        }
        drive_send_file($path, $file['original_name'], $file['file_type'], true);
        exit;

    case 'upload_init':
        require_scope($claims, ['write']);
        if ($method !== 'POST') {
            fail(405, 'Use POST');
        }
        $body = json_body();
        $name = clean_display_name($body['name'] ?? null);
        if ($name === null) {
            fail(400, 'File name is required');
        }
        if (has_blocked_extension($name)) {
            fail(415, 'This file type is not allowed. Put it in a .zip first.');
        }
        $size = filter_var($body['size'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($size === false) {
            fail(400, 'File size is required');
        }
        $maxBytes = (int) ($config['max_file_bytes'] ?? DEFAULT_MAX_FILE_BYTES);
        if ($size > $maxBytes) {
            fail(413, 'This file is too large. The limit is ' . round($maxBytes / 1073741824, 1) . ' GB.');
        }
        $free = @disk_free_space($driveRoot);
        if ($free !== false && $size * 2 > $free) {
            fail(507, 'There is not enough space left on the Hostinger server.');
        }
        $folderId = int_or_null($body['folderId'] ?? null);
        assert_folder($pdo, $clientId, $folderId);

        remove_stale_uploads();
        $id = bin2hex(random_bytes(16));
        [$metaPath, $partPath] = upload_paths($id);
        $meta = ['cid' => $clientId, 'folderId' => $folderId, 'name' => $name, 'size' => $size];
        if (file_put_contents($metaPath, json_encode($meta)) === false || !touch($partPath)) {
            fail(500, 'Could not start the upload');
        }
        ok(['uploadId' => $id, 'chunkSize' => chunk_bytes($config)]);

    case 'upload_chunk':
        require_scope($claims, ['write']);
        if ($method !== 'POST') {
            fail(405, 'Use POST');
        }
        [$metaPath, $partPath] = upload_paths((string) ($_GET['id'] ?? ''));
        $meta = load_upload($metaPath, $claims);
        if (isset($meta['fileId'])) {
            fail(409, 'Upload already finished');
        }
        $offset = filter_var($_GET['offset'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
        if ($offset === false) {
            fail(400, 'Invalid offset');
        }
        $maxChunk = chunk_bytes($config);
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $maxChunk) {
            fail(413, 'Chunk too large');
        }

        $out = fopen($partPath, 'c+b');
        if ($out === false || !flock($out, LOCK_EX)) {
            fail(500, 'Could not write the upload');
        }
        $have = fstat($out)['size'];
        if ($have !== $offset) {
            // The browser retried or lost its place: tell it where to carry on from.
            fail(409, 'Wrong offset', ['offset' => $have]);
        }
        fseek($out, $offset);
        $in = fopen('php://input', 'rb');
        $written = stream_copy_to_stream($in, $out, $maxChunk + 1);
        if ($written === false || $written === 0 || $written > $maxChunk || $offset + $written > $meta['size']) {
            ftruncate($out, $offset);
            fail(400, 'Bad chunk');
        }
        fflush($out);
        flock($out, LOCK_UN);
        fclose($out);
        touch($metaPath);
        ok(['offset' => $offset + $written]);

    case 'upload_complete':
        require_scope($claims, ['write']);
        if ($method !== 'POST') {
            fail(405, 'Use POST');
        }
        $body = json_body();
        [$metaPath, $partPath] = upload_paths((string) ($body['uploadId'] ?? ''));
        $meta = load_upload($metaPath, $claims);
        if (isset($meta['fileId'])) {
            ok(['fileId' => $meta['fileId'], 'name' => $meta['name']]); // a retry after a dropped response
        }
        clearstatcache();
        if (!is_file($partPath) || filesize($partPath) !== $meta['size']) {
            fail(409, 'The upload is incomplete', ['offset' => is_file($partPath) ? filesize($partPath) : 0]);
        }
        assert_folder($pdo, $clientId, $meta['folderId']);

        $uploadDir = $driveRoot . '/uploads';
        if (!is_dir($uploadDir) && !mkdir($uploadDir, 0755, true) && !is_dir($uploadDir)) {
            fail(500, 'Could not prepare the uploads folder');
        }
        $filename = storage_name($meta['name']);
        $target = "$uploadDir/$filename";
        $fileType = detect_file_type($partPath);
        if (!rename($partPath, $target)) {
            fail(500, 'Could not store the file');
        }
        try {
            $stmt = $pdo->prepare('INSERT INTO files (user_id, folder_id, filename, original_name, file_path, file_type) VALUES (?, ?, ?, ?, ?, ?)');
            $stmt->execute([$clientId, $meta['folderId'], $filename, $meta['name'], "uploads/$filename", $fileType]);
        } catch (PDOException $e) {
            error_log('Kite Drive API insert failed: ' . $e->getMessage());
            @unlink($target);
            fail(500, 'Could not save the file record');
        }
        $meta['fileId'] = (int) $pdo->lastInsertId();
        file_put_contents($metaPath, json_encode($meta));
        ok(['fileId' => $meta['fileId'], 'name' => $meta['name']]);

    default:
        fail(404, 'Unknown action');
}
