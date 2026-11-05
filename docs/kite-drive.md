# Kite Drive connection

Kite Drive is the PHP site on Hostinger where clients log in to get their files. The Kite System connects to it so staff can browse a client's Drive and upload to it from the client's **Files** tab. Files stay on Hostinger.

## How it works

1. The browser asks the `kite-drive` Edge Function for a token.
2. The function checks the staff member and signs a short-lived token for one Drive client.
3. The browser sends that token straight to Drive's API (`api/index.php`). Files never pass through Supabase.

| Action | Who |
| --- | --- |
| Browse and download | Staff who can see the client (the normal department rules) |
| Upload | Admins (Super Admin, Owner, CEO, General Manager) |
| Link or unlink a client | Admins |
| Delete files | Nobody from here: it stays in Drive's admin panel |

Uploads go in chunks of up to 8 MB (less if the server's `post_max_size` is lower) and carry on after a dropped connection. The limit is 5 GB per file, set in `api/config.php`, and Hostinger's disk space still applies. Unfinished uploads are removed after two days.

## Setting it up

Do these in order. Keep a backup of the Drive site before you start.

### 1. Create the shared secret
Run this and keep the result for the next two steps:

```
openssl rand -hex 32
```

### 2. Hostinger
1. From `integrations/kite-drive/`, upload `api/` (with its `.htaccess`) and `file.php` to the same folder as Drive's `index.php`.
2. Copy `api/config.sample.php` to `api/config.php` on the server and fill in the secret and the Kite System's address.
3. Open `https://our-kites.kiteagency-eg.com/api/config.php`. It must show a 403 error. If it doesn't, delete `api/config.php` and stop.

Drive works exactly as before after this step.

### 3. Supabase

```
supabase db push
supabase secrets set KITE_DRIVE_URL="https://our-kites.kiteagency-eg.com" KITE_DRIVE_API_SECRET="<the secret>"
supabase functions deploy kite-drive
```

### 4. Kite System
Deploy the front end as usual. It adds Drive to the allowed connections in `vercel.json`, `.htaccess` and `index.html`.

### 5. Link a client and test
Open a client → **Files** → **Link to Kite Drive**. Upload a small file, check it appears when that client logs in to Drive, then download it.

### 6. Protect the file links
**This step changes what clients see.** After it, opening a file needs a login, so any file link you've already sent to someone stops working unless they log in as that client.

`file.php` and `api/send.php` from step 2 must already be on the server, or every file will fail.

1. Upload `uploads/.htaccess` into Drive's `uploads/` folder. If one is already there, send it to the developer first rather than replacing it.
2. Logged out, in a private browser window, open a real file link. It should go to the login page. If the file still opens, clear the cache in hPanel (LiteSpeed Cache and CDN, if on) and try again.
3. Log in as a client and check their previews, videos and downloads still work. Then check the same from an admin account, including client logos.

To undo this at any time, delete `uploads/.htaccess`.

## Troubleshooting

| What you see | Likely cause |
| --- | --- |
| "Kite Drive isn't set up yet" | The Supabase secrets are missing |
| "Kite Drive refused the request" | The secret differs between Supabase and `api/config.php` |
| Upload or browse fails with a network error | The Kite System's address isn't in `allowed_origins`, or the deployed security headers don't include Drive |
| Every Drive file link gives a 500 error | Hostinger rejected `uploads/.htaccess`: delete it and report the error |

To stop the connection at once, delete `api/config.php` on Hostinger. Drive itself carries on working.
