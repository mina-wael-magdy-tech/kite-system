/**
 * PULSE STUDIO OS — Invitation Acceptance Controller
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
  alertBox.className = isSuccess 
    ? 'p-3 rounded-lg text-xs bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' 
    : 'p-3 rounded-lg text-xs bg-rose-500/15 text-rose-300 border border-rose-500/30';
  alertBox.classList.remove('hidden');
}

// Hydrate invitation details if user is currently in invite session
async function checkInviteSession() {
  const supabase = getSupabase();
  if (!supabase) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, job_title, departments(name)')
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
    Toast.success('Welcome to PULSE STUDIO OS!', 'Account Activated');

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
