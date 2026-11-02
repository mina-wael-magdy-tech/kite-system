/**
 * PULSE STUDIO OS — Login Controller
 * Handles credentials validation, authentication with Supabase, and navigation.
 */

import { Auth } from './auth-service.js';
import { redirectIfLoggedIn } from './auth-guard.js';
import { isValidEmail } from '../utils/validators.js';
import { Toast } from '../services/toast-service.js';

// Redirect to index if session already exists
redirectIfLoggedIn();

const loginForm = document.getElementById('loginForm');

// Message left by the app guard (e.g. account could not be loaded)
const pendingLoginError = sessionStorage.getItem('pulse_login_error');
if (pendingLoginError) {
  sessionStorage.removeItem('pulse_login_error');
  window.addEventListener('DOMContentLoaded', () => showAlert(pendingLoginError));
}
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const togglePasswordBtn = document.getElementById('togglePasswordBtn');
const submitBtn = document.getElementById('submitBtn');
const btnText = document.getElementById('btnText');
const btnSpinner = document.getElementById('btnSpinner');
const authAlert = document.getElementById('authAlert');
const authAlertText = document.getElementById('authAlertText');

// Toggle password visibility
togglePasswordBtn?.addEventListener('click', () => {
  const isPass = passwordInput.type === 'password';
  passwordInput.type = isPass ? 'text' : 'password';
  togglePasswordBtn.innerHTML = isPass 
    ? '<i data-lucide="eye-off" style="width: 16px; height: 16px;"></i>' 
    : '<i data-lucide="eye" style="width: 16px; height: 16px;"></i>';
  if (window.lucide) window.lucide.createIcons();
});

function showAlert(message) {
  authAlertText.textContent = message;
  authAlert.classList.remove('hidden');
}

function hideAlert() {
  authAlert.classList.add('hidden');
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  btnText.textContent = isLoading ? 'Signing in...' : 'Sign In to Workspace';
  btnSpinner.classList.toggle('hidden', !isLoading);
}

loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!isValidEmail(email)) {
    showAlert('Please enter a valid company email address.');
    emailInput.focus();
    return;
  }

  if (!password) {
    showAlert('Please enter your password.');
    passwordInput.focus();
    return;
  }

  setLoading(true);

  try {
    await Auth.signIn(email, password);
    Toast.success('Authenticated successfully. Redirecting to studio workspace...', 'Welcome');
    setTimeout(() => {
      window.location.href = 'index.html';
    }, 600);
  } catch (err) {
    setLoading(false);
    console.error('Login error:', err);
    showAlert(err.message || 'Invalid email or password. Please try again.');
    Toast.error(err.message || 'Authentication failed', 'Sign In Error');
  }
});
