<?php
/**
 * Copy to config.php on Hostinger and fill in. Never commit config.php.
 */
return [
    // The same value as the KITE_DRIVE_API_SECRET secret in Supabase (at least 32 characters).
    'secret' => 'PASTE_THE_SHARED_SECRET_HERE',

    // The exact web address of the Kite System, with no trailing slash.
    'allowed_origins' => ['https://YOUR-KITE-SYSTEM-DOMAIN'],

    // Largest single file staff can upload from the Kite System.
    'max_file_bytes' => 5368709120, // 5 GB
];
