/**
 * PULSE STUDIO OS — Forgot Password Controller
 */

import { Auth } from './auth-service.js';
import { isValidEmail } from '../utils/validators.js';
import { Toast } from '../services/toast-service.js';

const forgotForm = document.getElementById('forgotForm');
const emailInput = document.getElementById('emailInput');
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

forgotForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.classList.add('hidden');

  const email = emailInput.value.trim();
  if (!isValidEmail(email)) {
    showAlert('Please enter a valid company email address.');
    return;
  }

  submitBtn.disabled = true;
  btnText.textContent = 'Sending link...';
  btnSpinner.classList.remove('hidden');

  try {
    await Auth.sendPasswordResetEmail(email);
    showAlert('Recovery email sent. Check your inbox for the reset link.', true);
    Toast.success('Password reset link sent to ' + email, 'Success');
    submitBtn.classList.add('hidden');
  } catch (err) {
    submitBtn.disabled = false;
    btnText.textContent = 'Send Recovery Link';
    btnSpinner.classList.add('hidden');
    console.error('Password reset error:', err);
    showAlert(err.message || 'Failed to send reset link. Please verify your email.');
  }
});
