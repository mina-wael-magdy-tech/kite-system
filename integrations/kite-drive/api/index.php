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
    if (!in_array($claims['scope'] ?? null, ['admin', 'read', 'write', 'download', 'view'], true)) {
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

/** Who changed what, because the Kite System's staff all reach Drive through this one API. */
function log_action(array $claims, string $what, array $detail): void
{
    $dir = __DIR__ . '/_log';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    @file_put_contents(
        "$dir/actions.log",
        json_encode(['at' => gmdate('c'), 'by' => $claims['sub'] ?? null, 'client' => $claims['cid'] ?? null, 'what' => $what] + $detail, JSON_UNESCAPED_UNICODE) . "\n",
        FILE_APPEND | LOCK_EX
    );
}

function require_post(string $method): void
{
    if ($method !== 'POST') {
        fail(405, 'Use POST');
    }
}

/** Finds a folder by name under a parent, creating it if needed. Used for folder and ZIP uploads. */
function ensure_folder(PDO $pdo, int $clientId, ?int $parentId, string $name): int
{
    $find = $pdo->prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id ' . ($parentId ? '= ?' : 'IS NULL') . ' AND name = ?');
    $find->execute($parentId ? [$clientId, $parentId, $name] : [$clientId, $name]);
    $id = $find->fetchColumn();
    if ($id) {
        return (int) $id;
    }
    $pdo->prepare('INSERT INTO folders (user_id, parent_id, name) VALUES (?, ?, ?)')->execute([$clientId, $parentId, $name]);
    return (int) $pdo->lastInsertId();
}

/** Walks "A/B/C" under a parent. Empty, "." and ".." parts are ignored, so a path can't climb out. */
function ensure_folder_path(PDO $pdo, int $clientId, ?int $parentId, array $parts): ?int
{
    foreach ($parts as $part) {
        $name = clean_display_name($part);
        if ($name !== null) {
            $parentId = ensure_folder($pdo, $clientId, $parentId, $name);
        }
    }
    return $parentId;
}

/** The given folders plus everything inside them, limited to this client's own folders. */
function folder_subtree(PDO $pdo, int $clientId, array $rootIds): array
{
    $all = [];
    $children = $pdo->prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id = ?');
    $owned = $pdo->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?');
    $queue = [];
    foreach ($rootIds as $id) {
        $owned->execute([$id, $clientId]);
        if ($owned->fetchColumn()) {
            $queue[] = $id;
        }
    }
    while ($queue) {
        $id = array_pop($queue);
        if (isset($all[$id])) {
            continue;
        }
        $all[$id] = true;
        $children->execute([$clientId, $id]);
        foreach ($children->fetchAll(PDO::FETCH_COLUMN) as $child) {
            $queue[] = (int) $child;
        }
    }
    return array_keys($all);
}

/** Reads [{type, id}, ...] into lists of file ids and folder ids. */
function parse_items(mixed $items): array
{
    if (!is_array($items) || !$items || count($items) > 20000) {
        fail(400, 'Nothing selected');
    }
    $files = [];
    $folders = [];
    foreach ($items as $item) {
        $id = is_array($item) ? filter_var($item['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) : false;
        if ($id === false || !in_array($item['type'] ?? null, ['file', 'folder'], true)) {
            fail(400, 'Invalid selection');
        }
        if ($item['type'] === 'file') {
            $files[] = $id;
        } else {
            $folders[] = $id;
        }
    }
    return [$files, $folders];
}

function placeholders(array $values): string
{
    return implode(',', array_fill(0, count($values), '?'));
}

/** Moves a finished file into uploads/ and records it. Returns the new file id, or null on failure. */
function store_file(PDO $pdo, string $driveRoot, int $clientId, ?int $folderId, string $displayName, string $source): ?int
{
    $uploadDir = $driveRoot . '/uploads';
    if (!is_dir($uploadDir) && !mkdir($uploadDir, 0755, true) && !is_dir($uploadDir)) {
        return null;
    }
    $filename = storage_name($displayName);
    $target = "$uploadDir/$filename";
    $fileType = detect_file_type($source);
    if (!rename($source, $target)) {
        return null;
    }
    try {
        $stmt = $pdo->prepare('INSERT INTO files (user_id, folder_id, filename, original_name, file_path, file_type) VALUES (?, ?, ?, ?, ?, ?)');
        $stmt->execute([$clientId, $folderId, $filename, $displayName, "uploads/$filename", $fileType]);
    } catch (PDOException $e) {
        error_log('Kite Drive API insert failed: ' . $e->getMessage());
        @unlink($target);
        return null;
    }
    return (int) $pdo->lastInsertId();
}

/** Unpacks a ZIP into Drive's folders. Refuses oversized archives and skips file types that aren't allowed. */
function extract_zip(PDO $pdo, string $driveRoot, array $config, int $clientId, ?int $folderId, string $zipPath): array
{
    if (!class_exists('ZipArchive')) {
        fail(501, 'This server cannot unpack ZIP files');
    }
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) {
        fail(422, 'This ZIP file could not be opened');
    }
    $limit = (int) ($config['max_file_bytes'] ?? DEFAULT_MAX_FILE_BYTES);
    $total = 0;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $total += (int) ($zip->statIndex($i)['size'] ?? 0);
    }
    if ($zip->numFiles > 5000 || $total > $limit * 2) {
        $zip->close();
        fail(413, 'This ZIP is too large to unpack. Upload it without unpacking.');
    }
    $tempDir = chunks_dir();
    $added = 0;
    $skipped = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $stat = $zip->statIndex($i);
        $entry = str_replace('\\', '/', (string) $stat['name']);
        if (str_starts_with($entry, '__MACOSX/') || basename($entry) === '.DS_Store') {
            continue;
        }
        $parts = array_values(array_filter(explode('/', $entry), fn($p) => $p !== '' && $p !== '.' && $p !== '..'));
        if (!$parts) {
            continue;
        }
        if (str_ends_with($entry, '/')) {
            ensure_folder_path($pdo, $clientId, $folderId, $parts);
            continue;
        }
        $name = clean_display_name(array_pop($parts));
        if ($name === null || has_blocked_extension($name)) {
            $skipped[] = basename($entry);
            continue;
        }
        $in = $zip->getStream((string) $stat['name']);
        $temp = $tempDir . '/' . bin2hex(random_bytes(16)) . '.part';
        $out = $in ? fopen($temp, 'wb') : false;
        // The size in a ZIP's header can lie, so never write more than it declared.
        $written = $out ? stream_copy_to_stream($in, $out, (int) $stat['size']) : false;
        if ($in) {
            fclose($in);
        }
        if ($out) {
            fclose($out);
        }
        $target = $written === false ? null : ensure_folder_path($pdo, $clientId, $folderId, $parts);
        if ($written === false || store_file($pdo, $driveRoot, $clientId, $target, $name, $temp) === null) {
            @unlink($temp);
            $skipped[] = $name;
            continue;
        }
        $added++;
    }
    $zip->close();
    return ['extracted' => $added, 'skipped' => array_slice($skipped, 0, 20), 'skippedCount' => count($skipped)];
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
// Only these take the token in the URL, because an <img> or a browser navigation can't send a header.
// Their tokens live for minutes and can only look at files, never list or change them.
$token = in_array($action, ['download', 'view', 'thumb', 'zip', 'logo'], true)
    ? (string) ($_GET['token'] ?? '')
    : (string) ($_SERVER['HTTP_X_DRIVE_TOKEN'] ?? '');
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

        $where = $folderId ? '= ?' : 'IS NULL';
        $args = $folderId ? [$clientId, $folderId] : [$clientId];

        // Paging: ?size=60&page=2 returns that page of "folders first, then files". Without ?size the whole
        // folder comes back, as before. A page past the end falls back to the last page.
        $size = isset($_GET['size']) ? max(1, min(200, (int) $_GET['size'])) : null;
        $page = 1;
        $total = null;
        $folderLimit = '';
        $fileLimit = '';
        if ($size !== null) {
            $countFolders = $pdo->prepare("SELECT COUNT(*) FROM folders WHERE user_id = ? AND parent_id $where");
            $countFolders->execute($args);
            $countFiles = $pdo->prepare("SELECT COUNT(*) FROM files WHERE user_id = ? AND folder_id $where");
            $countFiles->execute($args);
            $folderTotal = (int) $countFolders->fetchColumn();
            $total = $folderTotal + (int) $countFiles->fetchColumn();
            $page = max(1, min((int) ($_GET['page'] ?? 1), max(1, (int) ceil($total / $size))));
            $offset = ($page - 1) * $size;
            $folderCount = max(0, min($size, $folderTotal - $offset));
            $fileOffset = max(0, $offset - $folderTotal);
            $folderLimit = ' LIMIT ' . $folderCount . ' OFFSET ' . min($offset, $folderTotal);
            $fileLimit = ' LIMIT ' . ($size - $folderCount) . ' OFFSET ' . $fileOffset;
        }

        $folders = $pdo->prepare("SELECT id, name FROM folders WHERE user_id = ? AND parent_id $where ORDER BY name, id" . $folderLimit);
        $folders->execute($args);
        $files = $pdo->prepare("SELECT id, original_name, file_type, file_path, filename, uploaded_at FROM files WHERE user_id = ? AND folder_id $where ORDER BY uploaded_at DESC, id DESC" . $fileLimit);
        $files->execute($args);

        require __DIR__ . '/send.php';
        $breadcrumb = [];
        $logoStmt = $pdo->prepare('SELECT logo_path FROM users WHERE id = ?');
        $logoStmt->execute([$clientId]);
        $hasLogo = (bool) drive_resolve_path($driveRoot, $logoStmt->fetchColumn() ?: null);
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
            'page' => $page,
            'size' => $size,
            'total' => $total,
            'hasLogo' => $hasLogo,
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

    case 'view':
    case 'thumb':
        require_scope($claims, ['view']);
        $fileId = int_or_null($_GET['id'] ?? null);
        if ($fileId === null) {
            fail(400, 'Invalid id');
        }
        $stmt = $pdo->prepare('SELECT original_name, file_path, filename FROM files WHERE id = ? AND user_id = ?');
        $stmt->execute([$fileId, $clientId]);
        $file = $stmt->fetch();
        if (!$file) {
            fail(404, 'File not found');
        }
        require __DIR__ . '/send.php';
        $path = drive_resolve_path($driveRoot, $file['file_path'], $file['filename']);
        if (!$path) {
            fail(404, 'File is missing from the server');
        }
        if ($action === 'thumb' && drive_send_thumbnail($path, $fileId, __DIR__ . '/_thumbs')) {
            exit;
        }
        // The real type from the file's content, not the one stored at upload.
        $realType = (new finfo(FILEINFO_MIME_TYPE))->file($path) ?: null;
        drive_send_file($path, $file['original_name'], $realType, false, true);
        exit;

    case 'tree':
        require_scope($claims, ['read', 'write']);
        $stmt = $pdo->prepare('SELECT id, parent_id, name FROM folders WHERE user_id = ? ORDER BY name');
        $stmt->execute([$clientId]);
        ok(['folders' => array_map(fn($r) => [
            'id' => (int) $r['id'],
            'parentId' => $r['parent_id'] === null ? null : (int) $r['parent_id'],
            'name' => $r['name'],
        ], $stmt->fetchAll())]);

    case 'mkdir':
        require_scope($claims, ['write']);
        require_post($method);
        $body = json_body();
        $name = clean_display_name($body['name'] ?? null);
        if ($name === null) {
            fail(400, 'Folder name is required');
        }
        $parentId = int_or_null($body['parentId'] ?? null);
        assert_folder($pdo, $clientId, $parentId);
        $find = $pdo->prepare('SELECT 1 FROM folders WHERE user_id = ? AND parent_id ' . ($parentId ? '= ?' : 'IS NULL') . ' AND name = ?');
        $find->execute($parentId ? [$clientId, $parentId, $name] : [$clientId, $name]);
        if ($find->fetchColumn()) {
            fail(409, 'A folder with this name already exists here');
        }
        $folderId = ensure_folder($pdo, $clientId, $parentId, $name);
        log_action($claims, 'mkdir', ['id' => $folderId, 'name' => $name]);
        ok(['id' => $folderId, 'name' => $name]);

    case 'ensure_path':
        require_scope($claims, ['write']);
        require_post($method);
        $body = json_body();
        $parentId = int_or_null($body['parentId'] ?? null);
        assert_folder($pdo, $clientId, $parentId);
        if (!is_array($body['parts'] ?? null) || count($body['parts']) > 64) {
            fail(400, 'Invalid folder path');
        }
        ok(['id' => ensure_folder_path($pdo, $clientId, $parentId, array_values(array_filter($body['parts'], 'is_string')))]);

    case 'rename':
        require_scope($claims, ['write']);
        require_post($method);
        $body = json_body();
        $id = int_or_null($body['id'] ?? null);
        $type = $body['type'] ?? null;
        $name = clean_display_name($body['name'] ?? null);
        if ($id === null || !in_array($type, ['file', 'folder'], true) || $name === null) {
            fail(400, 'A name is required');
        }
        if ($type === 'file' && has_blocked_extension($name)) {
            fail(415, 'This file type is not allowed');
        }
        // Only the name people see changes: the stored file keeps its name, so links and thumbnails still work.
        $stmt = $type === 'file'
            ? $pdo->prepare('UPDATE files SET original_name = ? WHERE id = ? AND user_id = ?')
            : $pdo->prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?');
        $stmt->execute([$name, $id, $clientId]);
        $check = $pdo->prepare('SELECT 1 FROM ' . ($type === 'file' ? 'files' : 'folders') . ' WHERE id = ? AND user_id = ?');
        $check->execute([$id, $clientId]);
        if (!$check->fetchColumn()) {
            fail(404, 'Not found');
        }
        log_action($claims, 'rename', ['type' => $type, 'id' => $id, 'name' => $name]);
        ok(['name' => $name]);

    case 'move':
        require_scope($claims, ['write']);
        require_post($method);
        $body = json_body();
        [$fileIds, $folderIds] = parse_items($body['items'] ?? null);
        $targetId = int_or_null($body['targetId'] ?? null);
        assert_folder($pdo, $clientId, $targetId);
        if ($targetId !== null && in_array($targetId, folder_subtree($pdo, $clientId, $folderIds), true)) {
            fail(400, 'A folder cannot be moved into itself');
        }
        $pdo->beginTransaction();
        $moveFile = $pdo->prepare('UPDATE files SET folder_id = ? WHERE id = ? AND user_id = ?');
        foreach ($fileIds as $id) {
            $moveFile->execute([$targetId, $id, $clientId]);
        }
        $moveFolder = $pdo->prepare('UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?');
        foreach ($folderIds as $id) {
            $moveFolder->execute([$targetId, $id, $clientId]);
        }
        $pdo->commit();
        log_action($claims, 'move', ['files' => $fileIds, 'folders' => $folderIds, 'target' => $targetId]);
        ok(['moved' => count($fileIds) + count($folderIds)]);

    case 'delete':
        require_scope($claims, ['write']);
        require_post($method);
        $body = json_body();
        [$fileIds, $folderIds] = parse_items($body['items'] ?? null);
        require __DIR__ . '/send.php';
        $subtree = folder_subtree($pdo, $clientId, $folderIds);
        $rows = [];
        if ($fileIds) {
            $stmt = $pdo->prepare('SELECT id, filename, file_path, original_name FROM files WHERE user_id = ? AND id IN (' . placeholders($fileIds) . ')');
            $stmt->execute(array_merge([$clientId], $fileIds));
            $rows = $stmt->fetchAll();
        }
        if ($subtree) {
            $stmt = $pdo->prepare('SELECT id, filename, file_path, original_name FROM files WHERE user_id = ? AND folder_id IN (' . placeholders($subtree) . ')');
            $stmt->execute(array_merge([$clientId], $subtree));
            $rows = array_merge($rows, $stmt->fetchAll());
        }
        // Remove the records first: if the disk step fails, a client never sees a link to a missing file.
        $pdo->beginTransaction();
        $ids = array_values(array_unique(array_map(fn($r) => (int) $r['id'], $rows)));
        if ($ids) {
            $pdo->prepare('DELETE FROM files WHERE user_id = ? AND id IN (' . placeholders($ids) . ')')->execute(array_merge([$clientId], $ids));
        }
        if ($subtree) {
            $pdo->prepare('DELETE FROM folders WHERE user_id = ? AND id IN (' . placeholders($subtree) . ')')->execute(array_merge([$clientId], $subtree));
        }
        $pdo->commit();
        foreach ($rows as $row) {
            $path = drive_resolve_path($driveRoot, $row['file_path'], $row['filename']);
            if ($path) {
                @unlink($path);
            }
            foreach (glob(__DIR__ . '/_thumbs/' . (int) $row['id'] . '-*.jpg') ?: [] as $thumb) {
                @unlink($thumb);
            }
        }
        log_action($claims, 'delete', [
            'files' => array_map(fn($r) => ['id' => (int) $r['id'], 'name' => $r['original_name']], $rows),
            'folders' => $subtree,
        ]);
        ok(['files' => count($ids), 'folders' => count($subtree)]);

    case 'zip_prepare':
        require_scope($claims, ['view']);
        require_post($method);
        if (!class_exists('ZipArchive')) {
            fail(501, 'This server cannot build ZIP files');
        }
        $body = json_body();
        [$fileIds, $folderIds] = parse_items($body['items'] ?? null);
        require __DIR__ . '/send.php';
        @set_time_limit(0);
        $zipDir = __DIR__ . '/_zips';
        if (!is_dir($zipDir) && !mkdir($zipDir, 0755, true) && !is_dir($zipDir)) {
            fail(500, 'Could not prepare the ZIP');
        }
        foreach (glob("$zipDir/*.zip") ?: [] as $old) {
            if (filemtime($old) < time() - 86400) {
                @unlink($old);
            }
        }
        $zipId = bin2hex(random_bytes(16));
        $zipPath = "$zipDir/{$clientId}-{$zipId}.zip";
        $zip = new ZipArchive();
        if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            fail(500, 'Could not prepare the ZIP');
        }
        $used = [];
        $total = 0;
        $maxZip = 2 * (int) ($config['max_file_bytes'] ?? DEFAULT_MAX_FILE_BYTES);
        $addFile = function (array $row, string $prefix) use (&$used, &$total, $zip, $driveRoot, $maxZip, $zipPath) {
            $path = drive_resolve_path($driveRoot, $row['file_path'], $row['filename']);
            if (!$path) {
                return;
            }
            $total += filesize($path);
            if ($total > $maxZip) {
                $zip->close();
                @unlink($zipPath);
                fail(413, 'That selection is too large for one ZIP. Select fewer files.');
            }
            // Older records can hold a full path as their name: it must not steer where a ZIP unpacks.
            $plain = basename(str_replace('\\', '/', (string) $row['original_name']));
            $name = $prefix . $plain;
            $base = pathinfo($plain, PATHINFO_FILENAME);
            $ext = pathinfo($plain, PATHINFO_EXTENSION);
            for ($n = 2; isset($used[$name]); $n++) {
                $name = $prefix . "$base ($n)" . ($ext !== '' ? ".$ext" : '');
            }
            $used[$name] = true;
            $zip->addFile($path, $name);
            $zip->setCompressionName($name, ZipArchive::CM_STORE); // photos and video don't shrink: keep it fast
        };
        $byFolder = $pdo->prepare('SELECT id, original_name, filename, file_path FROM files WHERE user_id = ? AND folder_id = ?');
        $subFolders = $pdo->prepare('SELECT id, name FROM folders WHERE user_id = ? AND parent_id = ?');
        $addFolder = function (int $id, string $prefix) use (&$addFolder, $byFolder, $subFolders, $clientId, $addFile, $zip) {
            $zip->addEmptyDir(rtrim($prefix, '/'));
            $byFolder->execute([$clientId, $id]);
            foreach ($byFolder->fetchAll() as $row) {
                $addFile($row, $prefix);
            }
            $subFolders->execute([$clientId, $id]);
            foreach ($subFolders->fetchAll() as $sub) {
                $addFolder((int) $sub['id'], $prefix . basename($sub['name']) . '/');
            }
        };
        if ($fileIds) {
            $stmt = $pdo->prepare('SELECT id, original_name, filename, file_path FROM files WHERE user_id = ? AND id IN (' . placeholders($fileIds) . ')');
            $stmt->execute(array_merge([$clientId], $fileIds));
            foreach ($stmt->fetchAll() as $row) {
                $addFile($row, '');
            }
        }
        if ($folderIds) {
            $stmt = $pdo->prepare('SELECT id, name FROM folders WHERE user_id = ? AND id IN (' . placeholders($folderIds) . ')');
            $stmt->execute(array_merge([$clientId], $folderIds));
            foreach ($stmt->fetchAll() as $folder) {
                $addFolder((int) $folder['id'], basename($folder['name']) . '/');
            }
        }
        if ($zip->numFiles === 0) {
            $zip->close();
            fail(404, 'No files to download in that selection');
        }
        if (!$zip->close()) {
            @unlink($zipPath);
            fail(500, 'Could not finish the ZIP');
        }
        ok(['zipId' => $zipId]);

    case 'zip':
        require_scope($claims, ['view']);
        $zipId = (string) ($_GET['id'] ?? '');
        if (!preg_match('/^[a-f0-9]{32}$/', $zipId)) {
            fail(404, 'ZIP not found');
        }
        $zipPath = __DIR__ . "/_zips/{$clientId}-{$zipId}.zip";
        if (!is_file($zipPath)) {
            fail(404, 'ZIP not found');
        }
        require __DIR__ . '/send.php';
        drive_send_file($zipPath, 'Kite Drive files.zip', 'application/zip', true);
        if (empty($_SERVER['HTTP_RANGE'])) {
            @unlink($zipPath);
        }
        exit;

    case 'logo':
        require_scope($claims, ['view']);
        $stmt = $pdo->prepare('SELECT logo_path FROM users WHERE id = ?');
        $stmt->execute([$clientId]);
        require __DIR__ . '/send.php';
        $path = drive_resolve_path($driveRoot, $stmt->fetchColumn() ?: null);
        if (!$path) {
            fail(404, 'No logo');
        }
        drive_send_file($path, basename($path), (new finfo(FILEINFO_MIME_TYPE))->file($path) ?: null, false, true);
        exit;

    case 'logo_set':
        require_scope($claims, ['write']);
        require_post($method);
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 5242880) {
            fail(413, 'A logo can be up to 5 MB');
        }
        $temp = chunks_dir() . '/' . bin2hex(random_bytes(16)) . '.part';
        file_put_contents($temp, file_get_contents('php://input', false, null, 0, 5242881));
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($temp);
        $logoExt = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/webp' => 'webp', 'image/gif' => 'gif'][$mime] ?? null;
        if ($logoExt === null || filesize($temp) > 5242880) {
            @unlink($temp);
            fail(415, 'A logo must be a PNG, JPG, WEBP or GIF image up to 5 MB');
        }
        $logoDir = $driveRoot . '/uploads/logos';
        if (!is_dir($logoDir) && !mkdir($logoDir, 0755, true) && !is_dir($logoDir)) {
            @unlink($temp);
            fail(500, 'Could not save the logo');
        }
        $logoName = bin2hex(random_bytes(8)) . '_logo.' . $logoExt;
        if (!rename($temp, "$logoDir/$logoName")) {
            @unlink($temp);
            fail(500, 'Could not save the logo');
        }
        require __DIR__ . '/send.php';
        $stmt = $pdo->prepare('SELECT logo_path FROM users WHERE id = ?');
        $stmt->execute([$clientId]);
        $oldLogo = drive_resolve_path($driveRoot, $stmt->fetchColumn() ?: null);
        $pdo->prepare('UPDATE users SET logo_path = ? WHERE id = ?')->execute(["uploads/logos/$logoName", $clientId]);
        if ($oldLogo) {
            @unlink($oldLogo);
        }
        log_action($claims, 'logo_set', []);
        ok(['logo' => true]);

    case 'create_client':
        require_scope($claims, ['admin']);
        require_post($method);
        $body = json_body();
        $name = trim((string) ($body['name'] ?? ''));
        $email = strtolower(trim((string) ($body['email'] ?? '')));
        $password = (string) ($body['password'] ?? '');
        if ($name === '' || mb_strlen($name) > 120 || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 8 || strlen($password) > 128) {
            fail(400, 'A name, a valid email and a password of at least 8 characters are required');
        }
        $find = $pdo->prepare('SELECT 1 FROM users WHERE email = ?');
        $find->execute([$email]);
        if ($find->fetchColumn()) {
            fail(409, 'A Kite Drive account with this email already exists');
        }
        $pdo->prepare("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'client')")
            ->execute([$name, $email, password_hash($password, PASSWORD_DEFAULT)]);
        $newId = (int) $pdo->lastInsertId();
        log_action($claims, 'create_client', ['id' => $newId, 'name' => $name]);
        ok(['id' => $newId, 'name' => $name]);

    case 'client_account':
        require_scope($claims, ['admin']);
        $accountId = int_or_null($_GET['id'] ?? null);
        $row = $accountId === null ? false : $pdo->prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'client'");
        if ($row) {
            $row->execute([$accountId]);
            $row = $row->fetch();
        }
        if (!$row) {
            fail(404, 'Account not found');
        }
        ok(['id' => (int) $row['id'], 'name' => $row['name'], 'email' => $row['email']]);

    case 'update_client':
        // Change a client's Drive login: name, email and/or password. Only the fields sent are changed.
        // The password is stored hashed, so it can be set here but never read back.
        require_scope($claims, ['admin']);
        require_post($method);
        $body = json_body();
        $accountId = int_or_null($body['id'] ?? null);
        $current = $accountId === null ? false : $pdo->prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'client'");
        if ($current) {
            $current->execute([$accountId]);
            $current = $current->fetch();
        }
        if (!$current) {
            fail(404, 'Account not found');
        }
        $sets = [];
        $values = [];
        $changed = [];
        if (array_key_exists('name', $body) && trim((string) $body['name']) !== '') {
            $name = trim((string) $body['name']);
            if (mb_strlen($name) > 120) {
                fail(400, 'The name is too long');
            }
            $sets[] = 'name = ?';
            $values[] = $name;
            $changed[] = 'name';
        }
        if (array_key_exists('email', $body) && trim((string) $body['email']) !== '') {
            $email = strtolower(trim((string) $body['email']));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 254) {
                fail(400, 'Enter a valid email');
            }
            if ($email !== strtolower((string) $current['email'])) {
                $taken = $pdo->prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?');
                $taken->execute([$email, $accountId]);
                if ($taken->fetchColumn()) {
                    fail(409, 'Another Kite Drive account already uses this email');
                }
                $sets[] = 'email = ?';
                $values[] = $email;
                $changed[] = 'email';
            }
        }
        if (array_key_exists('password', $body) && (string) $body['password'] !== '') {
            $password = (string) $body['password'];
            if (strlen($password) < 8 || strlen($password) > 128) {
                fail(400, 'The password must be 8 to 128 characters');
            }
            $sets[] = 'password = ?';
            $values[] = password_hash($password, PASSWORD_DEFAULT);
            $changed[] = 'password';
        }
        if ($sets) {
            $values[] = $accountId;
            $pdo->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($values);
            log_action($claims, 'update_client', ['id' => $accountId, 'changed' => $changed]); // never the password itself
        }
        $after = $pdo->prepare('SELECT name, email FROM users WHERE id = ?');
        $after->execute([$accountId]);
        $now = $after->fetch();
        ok(['id' => $accountId, 'name' => $now['name'], 'email' => $now['email'], 'changed' => $changed]);

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
        if (isset($meta['result'])) {
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
        if (isset($meta['result'])) {
            ok($meta['result']); // a retry after a dropped response
        }
        clearstatcache();
        if (!is_file($partPath) || filesize($partPath) !== $meta['size']) {
            fail(409, 'The upload is incomplete', ['offset' => is_file($partPath) ? filesize($partPath) : 0]);
        }
        assert_folder($pdo, $clientId, $meta['folderId']);

        if (!empty($body['extract']) && strtolower((string) pathinfo($meta['name'], PATHINFO_EXTENSION)) === 'zip') {
            @set_time_limit(0);
            $result = extract_zip($pdo, $driveRoot, $config, $clientId, $meta['folderId'], $partPath);
            @unlink($partPath);
            log_action($claims, 'upload_zip', ['name' => $meta['name'], 'extracted' => $result['extracted'], 'skipped' => $result['skippedCount']]);
        } else {
            $fileId = store_file($pdo, $driveRoot, $clientId, $meta['folderId'], $meta['name'], $partPath);
            if ($fileId === null) {
                fail(500, 'Could not store the file');
            }
            $result = ['fileId' => $fileId, 'name' => $meta['name']];
            log_action($claims, 'upload', ['id' => $fileId, 'name' => $meta['name']]);
        }
        $meta['result'] = $result;
        file_put_contents($metaPath, json_encode($meta));
        ok($result);

    default:
        fail(404, 'Unknown action');
}
