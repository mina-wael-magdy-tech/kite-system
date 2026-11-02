/**
 * PULSE STUDIO OS — Route & Page Authentication Guards
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
      window.location.href = 'login.html';
      return null;
    }

    if (profile.employment_status === 'suspended' || profile.employment_status === 'inactive') {
      alert('Your account access has been suspended or deactivated.');
      await Auth.signOut();
      return null;
    }

    return profile;
  } catch (e) {
    window.location.href = 'login.html';
    return null;
  }
}

export async function redirectIfLoggedIn() {
  const session = await getSession();
  if (session) {
    window.location.href = 'index.html';
  }
}
