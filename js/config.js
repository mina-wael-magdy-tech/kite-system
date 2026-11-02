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
  MAX_FILE_SIZE_BYTES: 25 * 1024 * 1024, // 25 MB
  ALLOWED_FILE_EXTENSIONS: [
    'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif',
    'mp4', 'mov', 'zip', 'psd', 'ai', 'fig'
    // SVG intentionally excluded: it can carry scripts.
  ],

  // Storage buckets that exist (see 004_storage.sql)
  STORAGE_BUCKETS: {
    TASK_ATTACHMENTS: 'task-attachments'
  },

  // profiles columns the browser may read. Must match the column-level GRANT in
  // 002_rls_policies.sql (selecting any other column, including "*", is rejected).
  PROFILE_COLUMNS:
    'id, employee_id, full_name, email, phone, avatar_url, job_title, department_id, bio, skills, ' +
    'employment_status, employment_type, joining_date, location, manager_id, created_at, updated_at'
};
