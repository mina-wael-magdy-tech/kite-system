/**
 * KITE SYSTEM — Client-Side Input Validators
 * Secure form validation and input sanity checks before database submission.
 */

import { CONFIG } from '../config.js';

export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/;
  return re.test(email.trim());
}

export function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Password is required' };
  }
  if (password.length < 12) {
    return { valid: false, message: 'Password must be at least 12 characters long' };
  }
  if (password.length > 128) {
    return { valid: false, message: 'Password must be at most 128 characters long' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must include an uppercase letter' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must include a lowercase letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must include a number' };
  }
  return { valid: true, message: 'Strong password' };
}

export function isNotEmpty(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim().length > 0;
}

export function isValidFileSize(bytes, maxBytes = CONFIG.MAX_FILE_SIZE_BYTES) {
  return typeof bytes === 'number' && bytes > 0 && bytes <= maxBytes;
}

export function isValidFileExtension(fileName) {
  if (!fileName || typeof fileName !== 'string') return false;
  const ext = fileName.split('.').pop().toLowerCase();
  return CONFIG.ALLOWED_FILE_EXTENSIONS.includes(ext);
}
