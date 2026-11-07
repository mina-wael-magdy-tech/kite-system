<?php
/**
 * Copy to config.php on Hostinger and fill in. Never commit config.php.
 */
return [
    // The same value as the KITE_DRIVE_API_SECRET secret in Supabase (at least 32 characters).
    'secret' => 'PASTE_THE_SHARED_SECRET_HERE',

    // The exact web address of the Kite System, with no trailing slash.
    'allowed_origins' => ['https://YOUR-KITE-SYSTEM-DOMAIN'],

    // How a token in a web address (not a header) is treated. Addresses end up in server access logs and browser history.
    //   'legacy' (default): accepted as before, so an older Kite System keeps working during a release.
    //   'strict': downloads / ZIPs are single-use, previews work only for the one file the token was issued for,
    //             thumbnails and the logo must send the token in the X-Drive-Token header.
    // Switch to 'strict' only AFTER the new Kite System web app is live (docs/phase4-release.md).
    'url_tokens' => 'legacy',

    // Largest single file staff can upload from the Kite System.
    'max_file_bytes' => 5368709120, // 5 GB
];
