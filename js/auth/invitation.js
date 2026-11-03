/**
 * KITE SYSTEM — Invitation Acceptance Controller
 */

import { Auth } from './auth-service.js';
import { getSupabase } from '../supabase-client.js';
import { validatePassword } from '../utils/validators.js';
import { Toast } from '../services/toast-service.js';
import { Api } from '../services/api.js';

const inviteForm = document.getElementById('inviteForm');
const passwordInput = document.getElementById('passwordInput');
const confirmInput = document.getElementById('confirmInput');
const submitBtn = document.getElementById('submitBtn');
const btnText = document.getElementById('btnText');
const btnSpinner = document.getElementById('btnSpinner');
const alertBox = document.getElementById('alertBox');
const alertText = document.getElementById('alertText');

function showAlert(message, isSuccess = false) {
  alertText.textContent = message;
  alertBox.className = isSuccess ? 'alert alert-success' : 'alert alert-error';
  alertBox.classList.remove('hidden');
}

// Hydrate invitation details if user is currently in invite session
// Admin-sent invite links return tokens in the URL hash (implicit flow), which a
// PKCE client does not pick up on its own — establish the session manually.
async function establishSessionFromUrl(supabase) {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);

  const urlError = hash.get('error_description') || query.get('error_description');
  if (urlError) {
    showAlert(`${urlError.replace(/\+/g, ' ')}. Please ask your admin to send a new invitation.`);
    return;
  }

  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) showAlert(error.message);
    history.replaceState(null, '', window.location.pathname);
    return;
  }

  const code = query.get('code');
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) showAlert(error.message);
    history.replaceState(null, '', window.location.pathname);
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    showAlert('This invitation link is invalid or has expired. Please ask your admin to send a new invitation.');
  }
}

async function checkInviteSession() {
  const supabase = getSupabase();
  if (!supabase) return;

  await establishSessionFromUrl(supabase);

  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, job_title, departments!profiles_department_id_fkey(name)')
      .eq('id', user.id)
      .single();

    if (profile) {
      document.getElementById('inviteName').textContent = profile.full_name || user.email;
      const deptName = profile.departments?.name || 'Creative Studio';
      document.getElementById('inviteDeptRole').textContent = `${profile.job_title || 'Specialist'} • ${deptName}`;
    }
  }
}

checkInviteSession();

inviteForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.classList.add('hidden');

  const p1 = passwordInput.value;
  const p2 = confirmInput.value;

  const check = validatePassword(p1);
  if (!check.valid) {
    showAlert(check.message);
    return;
  }

  if (p1 !== p2) {
    showAlert('Passwords do not match. Please verify.');
    return;
  }

  submitBtn.disabled = true;
  btnText.textContent = 'Activating account...';
  btnSpinner.classList.remove('hidden');

  try {
    await Auth.updatePassword(p1);

    // Activation is a server-side decision (employment_status is not client-writable)
    await Api.acceptInvitation();

    showAlert('Account activated! Entering workspace...', true);
    Toast.success('Welcome to KITE SYSTEM!', 'Account Activated');

    setTimeout(() => {
      window.location.href = 'index.html';
    }, 1000);
  } catch (err) {
    submitBtn.disabled = false;
    btnText.textContent = 'Activate Account & Enter Studio';
    btnSpinner.classList.add('hidden');
    console.error('Invite setup error:', err);
    showAlert(err.message || 'Failed to activate account.');
  }
});
