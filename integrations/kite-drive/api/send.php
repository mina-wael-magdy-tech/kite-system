<?php
/**
 * Shared file helpers for api/index.php and file.php. Not reachable directly (see api/.htaccess).
 */
declare(strict_types=1);

/**
 * Finds a stored file on disk. Returns null unless it really is inside uploads/, so a bad database value
 * can never serve something else from the server.
 */
function drive_resolve_path(string $driveRoot, ?string $filePath, ?string $filename = null): ?string
{
    $uploads = realpath($driveRoot . '/uploads');
    if ($uploads === false) {
        return null;
    }
    $candidates = [];
    if ($filePath) {
        $candidates[] = $driveRoot . '/' . ltrim($filePath, '/');
    }
    if ($filename) {
        $candidates[] = $uploads . '/' . basename($filename);
    }
    foreach ($candidates as $candidate) {
        $real = realpath($candidate);
        if ($real !== false && is_file($real) && str_starts_with($real, $uploads . DIRECTORY_SEPARATOR)) {
            return $real;
        }
    }
    return null;
}

/**
 * Streams a file with resume and video seeking support. Files that a browser could run as a page
 * (HTML, SVG, ...) are only ever sent as downloads and with scripts disabled.
 */
function drive_send_file(string $path, string $displayName, ?string $fileType, bool $forceDownload): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close(); // a long video must not block the user's other pages
    }
    @set_time_limit(0);
    while (ob_get_level() > 0) {
        ob_end_clean();
    }

    $safeInline = (bool) preg_match('#^(image/(png|jpe?g|gif|webp|avif|bmp)|application/pdf|video/[\w.+-]+|audio/[\w.+-]+)$#i', (string) $fileType);
    $inline = $safeInline && !$forceDownload;
    $asciiName = preg_replace('/[^A-Za-z0-9._-]+/', '_', $displayName) ?: 'download';

    $size = filesize($path);
    $start = 0;
    $end = $size - 1;
    $range = $_SERVER['HTTP_RANGE'] ?? '';
    $partial = false;
    if ($size > 0 && preg_match('/^bytes=(\d*)-(\d*)$/', $range, $m) && ($m[1] !== '' || $m[2] !== '')) {
        if ($m[1] === '') {
            $start = max(0, $size - (int) $m[2]);
        } else {
            $start = (int) $m[1];
            $end = $m[2] === '' ? $end : min($end, (int) $m[2]);
        }
        if ($start > $end || $start >= $size) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            return;
        }
        $partial = true;
    }

    http_response_code($partial ? 206 : 200);
    header('Content-Type: ' . ($inline ? $fileType : 'application/octet-stream'));
    header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . "; filename=\"$asciiName\"; filename*=UTF-8''" . rawurlencode($displayName));
    header('Content-Length: ' . ($end - $start + 1));
    header('Accept-Ranges: bytes');
    header('X-Content-Type-Options: nosniff');
    if (!$inline) {
        header('Content-Security-Policy: sandbox'); // only here: on inline files it stops Chrome's PDF viewer
    }
    header('Cache-Control: private, no-store');
    if ($partial) {
        header("Content-Range: bytes $start-$end/$size");
    }
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
        return;
    }

    $in = fopen($path, 'rb');
    if ($in === false) {
        return;
    }
    fseek($in, $start);
    $left = $end - $start + 1;
    while ($left > 0 && !feof($in) && !connection_aborted()) {
        $data = fread($in, min(1048576, $left));
        if ($data === false) {
            break;
        }
        echo $data;
        flush();
        $left -= strlen($data);
    }
    fclose($in);
}
