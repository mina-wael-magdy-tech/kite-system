/**
 * PULSE STUDIO OS — Supabase Client Wrapper
 * Singleton Supabase client instance with realtime capabilities & session management.
 */

import { CONFIG } from './config.js';

let supabase = null;

export function getSupabase() {
  if (supabase) return supabase;

  if (!CONFIG.IS_CONFIGURED) {
    console.error('PULSE STUDIO OS is not configured: set your Supabase URL and anon key in env.js.');
    return null;
  }

  if (!window.supabase) {
    console.error('Supabase client library (vendor/supabase.js) failed to load.');
    return null;
  }

  try {
    supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
        storageKey: 'pulse_studio_auth_token'
      },
      realtime: {
        params: {
          eventsPerSecond: 10
        }
      }
    });
  } catch (err) {
    console.warn('Could not initialize Supabase with current config:', err);
    return null;
  }

  return supabase;
}

export const supabaseClient = getSupabase();

/**
 * Get current session safely
 */
export async function getSession() {
  const client = getSupabase();
  if (!client) return null;
  try {
    const { data: { session }, error } = await client.auth.getSession();
    if (error) throw error;
    return session;
  } catch (err) {
    console.warn('Error fetching session:', err);
    return null;
  }
}

/**
 * Get current authenticated user
 */
export async function getCurrentUser() {
  const client = getSupabase();
  if (!client) return null;
  try {
    const { data: { user }, error } = await client.auth.getUser();
    if (error) throw error;
    return user;
  } catch (err) {
    console.warn('Error fetching user:', err);
    return null;
  }
}
