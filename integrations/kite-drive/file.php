<?php
/**
 * Login check for everything in uploads/. uploads/.htaccess sends every file request here, so existing
 * page links keep working but a link alone no longer opens a file.
 *   - A client can open only their own files and logo.
 *   - An admin can open files if they have the view or download permission, and any client's logo.
 */
define('SECURE_ACCESS', true);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/api/send.php';

function deny(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=UTF-8');
    header('Cache-Control: no-store');
    echo $message;
    exit;
}

if (!isLoggedIn()) {
    header('Location: /index.php'); // not relative: the browser's address is still under /uploads/
    exit;
}

// The address the browser asked for is the most reliable source: names with Arabic text, spaces or "&"
// survive whatever the web server's rewrite does to the ?p= value.
$urlPath = rawurldecode((string) parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH));
$requested = str_starts_with($urlPath, '/uploads/') ? substr($urlPath, strlen('/uploads/')) : (string) ($_GET['p'] ?? '');
$requested = str_replace('\\', '/', $requested);
// Only a whole ".." segment climbs folders: real names such as "Final..pdf" must still open.
if ($requested === '' || in_array('..', explode('/', $requested), true) || str_contains($requested, "\0")) {
    deny(404, 'File not found');
}
$dbPath = 'uploads/' . ltrim($requested, '/');
$isAdmin = ($_SESSION['role'] ?? '') === 'admin';

$stmt = $pdo->prepare('SELECT user_id, original_name, file_type, file_path, filename FROM files WHERE file_path = ? OR filename = ? LIMIT 1');
$stmt->execute([$dbPath, basename($requested)]);
$file = $stmt->fetch();

if ($file) {
    $allowed = $isAdmin ? (canViewContent() || canDownload()) : (int) $file['user_id'] === (int) $_SESSION['user_id'];
    if (!$allowed) {
        deny(403, 'You do not have access to this file.');
    }
    $path = drive_resolve_path(__DIR__, $file['file_path'], $file['filename']);
    if (!$path) {
        deny(404, 'File not found');
    }
    drive_send_file($path, $file['original_name'], $file['file_type'], false);
    exit;
}

// Not a delivered file: it can still be a client's logo.
$stmt = $pdo->prepare('SELECT id, logo_path FROM users WHERE logo_path = ? LIMIT 1');
$stmt->execute([$dbPath]);
$logo = $stmt->fetch();
if (!$logo) {
    deny(404, 'File not found');
}
if (!$isAdmin && (int) $logo['id'] !== (int) $_SESSION['user_id']) {
    deny(403, 'You do not have access to this file.');
}
$path = drive_resolve_path(__DIR__, $logo['logo_path']);
if (!$path) {
    deny(404, 'File not found');
}
$mime = (new finfo(FILEINFO_MIME_TYPE))->file($path) ?: null;
drive_send_file($path, basename($path), $mime, false);
