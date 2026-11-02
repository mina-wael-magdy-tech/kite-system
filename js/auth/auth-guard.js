/**
 * KITE SYSTEM — Route & Page Authentication Guards
 * Protects application routes and ensures proper session validation.
 */

import { getSession } from '../supabase-client.js';
import { Auth } from './auth-service.js';

export async function protectPage() {
  const session = await getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }

  try {
    const profile = await Auth.getCurrentProfile();
    if (!profile) {
      // A session without a loadable profile must NOT bounce to login (login would bounce back: loop).
      sessionStorage.setItem('pulse_login_error', 'Your account could not be loaded. Please sign in again or contact your administrator.');
      await Auth.signOut();
      return null;
    }

    if (profile.employment_status === 'suspended' || profile.employment_status === 'inactive') {
      alert('Your account access has been suspended or deactivated.');
      await Auth.signOut();
      return null;
    }

    return profile;
  } catch (e) {
    console.error('protectPage failed:', e);
    sessionStorage.setItem('pulse_login_error', 'Could not verify your session. Please sign in again.');
    await Auth.signOut();
    return null;
  }
}

export async function redirectIfLoggedIn() {
  const session = await getSession();
  if (!session) return;

  // Only forward to the app when the account can actually be loaded; otherwise stay on login.
  const profile = await Auth.getCurrentProfile();
  if (profile && !['suspended', 'inactive'].includes(profile.employment_status)) {
    window.location.href = 'index.html';
  }
}
