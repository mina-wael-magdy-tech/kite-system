/**
 * KITE SYSTEM — Configuration Module
 * Central application settings and constants.
 * Deployment values (Supabase URL / anon key) come from /env.js.
 */

const SUPABASE_URL = window.ENV_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.ENV_SUPABASE_ANON_KEY || '';

export const CONFIG = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  VAPID_PUBLIC_KEY: window.ENV_VAPID_PUBLIC_KEY || '',
  // WebRTC relay servers for calls (JSON array, see docs/chat-and-calls.md). STUN only works on friendly networks;
  // add a TURN server so calls also connect over mobile data / strict office firewalls.
  ICE_SERVERS: (() => { try { const v = JSON.parse(window.ENV_ICE_SERVERS || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),

  // True once env.js was filled in with real values.
  IS_CONFIGURED:
    /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(SUPABASE_URL) &&
    !SUPABASE_URL.includes('YOUR_SUPABASE') &&
    SUPABASE_ANON_KEY.length > 40 &&
    !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE'),

  // Application Identity
  APP_NAME: 'KITE SYSTEM',
  APP_TAGLINE: 'Kite Design Studio',
  APP_VERSION: '1.0.0',

  // Pagination & Lists
  ITEMS_PER_PAGE: 20,
  TASK_SEARCH_DEBOUNCE_MS: 300,
  TOAST_AUTO_DISMISS_MS: 3500,

  // Upload limits (must match the bucket limit in supabase/migrations/004_storage.sql)
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024, // 50 MB (task-attachments bucket is 25 MB, studio-assets is 50 MB)
  MAX_TASK_FILE_SIZE_BYTES: 25 * 1024 * 1024,
  ALLOWED_FILE_EXTENSIONS: [
    'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
    'mp4', 'mov', 'webm', 'mp3', 'wav',
    'zip', 'rar', 'psd', 'ai', 'eps', 'indd', 'fig', 'sketch', 'xd',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'
    // SVG is allowed but only ever shown through <img> and downloaded as an attachment, never opened inline.
  ],

  // Storage buckets that exist (see 004_storage.sql)
  STORAGE_BUCKETS: {
    TASK_ATTACHMENTS: 'task-attachments',
    STUDIO_ASSETS: 'studio-assets',
    CHAT_MEDIA: 'chat-media'
  },

  // profiles columns the browser may read. Must match the column-level GRANT in
  // 002_rls_policies.sql (selecting any other column, including "*", is rejected).
  PROFILE_COLUMNS:
    'id, employee_id, full_name, email, phone, avatar_url, job_title, department_id, bio, skills, ' +
    'employment_status, employment_type, joining_date, location, manager_id, created_at, updated_at'
};
