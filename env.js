/**
 * PULSE STUDIO OS — Deployment configuration (loaded before the app).
 *
 * Fill these two values with the ones from Supabase → Project Settings → API.
 * They are PUBLIC by design (security comes from Row Level Security).
 *
 * NEVER put the service_role key, SETUP_TOKEN or any other secret in this file.
 */
window.ENV_SUPABASE_URL = 'https://YOUR_SUPABASE_PROJECT_ID.supabase.co';
window.ENV_SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
// Public VAPID key for push notifications (safe to expose). Leave empty to disable push.
window.ENV_VAPID_PUBLIC_KEY = '';
