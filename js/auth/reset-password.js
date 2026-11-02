/**
 * KITE SYSTEM — Reset Password Controller
 */

import { Auth } from './auth-service.js';
import { validatePassword } from '../utils/validators.js';
import { Toast } from '../services/toast-service.js';

const resetForm = document.getElementById('resetForm');
const newPasswordInput = document.getElementById('newPasswordInput');
const confirmPasswordInput = document.getElementById('confirmPasswordInput');
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

resetForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.classList.add('hidden');

  const p1 = newPasswordInput.value;
  const p2 = confirmPasswordInput.value;

  const check = validatePassword(p1);
  if (!check.valid) {
    showAlert(check.message);
    return;
  }

  if (p1 !== p2) {
    showAlert('Passwords do not match. Please re-enter.');
    return;
  }

  submitBtn.disabled = true;
  btnText.textContent = 'Updating password...';
  btnSpinner.classList.remove('hidden');

  try {
    await Auth.updatePassword(p1);
    showAlert('Password updated successfully! Redirecting...', true);
    Toast.success('Password changed successfully', 'Account Security');
    setTimeout(() => {
      window.location.href = 'index.html';
    }, 1200);
  } catch (err) {
    submitBtn.disabled = false;
    btnText.textContent = 'Save & Sign In';
    btnSpinner.classList.add('hidden');
    console.error('Password update error:', err);
    showAlert(err.message || 'Failed to update password.');
  }
});
