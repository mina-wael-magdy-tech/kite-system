/**
 * PULSE STUDIO OS — Authentication Service
 * Wraps Supabase Auth API with session tracking, password reset, and profile hydration.
 */

import { getSupabase, getSession, getCurrentUser } from '../supabase-client.js';
import { CONFIG } from '../config.js';

class AuthService {
  async signIn(email, password) {
    const supabase = getSupabase();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password
    });

    if (error) throw error;

    // Check account status in profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('employment_status')
      .eq('id', data.user.id)
      .single();

    if (profile && (profile.employment_status === 'suspended' || profile.employment_status === 'inactive')) {
      await supabase.auth.signOut();
      throw new Error('Your employee account has been deactivated or suspended. Please contact your studio administrator.');
    }

    return data;
  }

  async signOut() {
    const supabase = getSupabase();
    if (supabase) {
      await supabase.auth.signOut();
    }
    localStorage.removeItem('pulse_studio_auth_token');
    window.location.href = 'login.html';
  }

  async sendPasswordResetEmail(email) {
    const supabase = getSupabase();
    if (!supabase) throw new Error('Supabase client not initialized');

    const redirectTo = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}reset-password.html`;

    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo
    });

    if (error) throw error;
    return true;
  }

  async updatePassword(newPassword) {
    const supabase = getSupabase();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase.auth.updateUser({
      password: newPassword
    });

    if (error) throw error;
    return data;
  }

  async getCurrentProfile() {
    const user = await getCurrentUser();
    if (!user) return null;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('profiles')
      .select(`${CONFIG.PROFILE_COLUMNS}, departments!profiles_department_id_fkey(id, name, code)`)
      .eq('id', user.id)
      .single();

    if (error) {
      console.error('Could not load profile:', error.message);
      return null;
    }
    return data;
  }
}

export const Auth = new AuthService();
