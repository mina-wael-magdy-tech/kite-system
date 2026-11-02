import { HttpError } from "./http.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function uuid(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new HttpError(400, `${field} must be a valid id`);
  return v;
}

export function optUuid(v: unknown, field: string): string | null {
  return v === undefined || v === null || v === "" ? null : uuid(v, field);
}

export function text(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw new HttpError(400, `${field} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) {
    throw new HttpError(400, `${field} must be ${min}-${max} characters`);
  }
  return s;
}

export function optText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  return text(v, field, 0, max) || null;
}

export function email(v: unknown, field = "email"): string {
  const s = text(v, field, 3, 254).toLowerCase();
  if (!EMAIL_RE.test(s)) throw new HttpError(400, `${field} is not a valid email address`);
  return s;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

export function isoDate(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new HttpError(400, `${field} must be a date (YYYY-MM-DD)`);
  }
  return v;
}

// Mirrors js/utils/validators.js so the server enforces the same policy.
export function password(v: unknown): string {
  if (typeof v !== "string" || v.length < 12 || v.length > 128) {
    throw new HttpError(400, "Password must be 12-128 characters");
  }
  if (!/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/[0-9]/.test(v)) {
    throw new HttpError(400, "Password must include upper-case, lower-case and a number");
  }
  return v;
}
