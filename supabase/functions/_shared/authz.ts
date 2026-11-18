// KITE SYSTEM — small, dependency-free authorization rules (so a test can load them without the Edge runtime).
// The role list itself is NOT repeated here: callers pass ADMIN_ROLES from auth.ts, the single place roles are declared.

/**
 * workflow action "storage.cleanup" deletes files with the service role, so it is limited to active administrators.
 * (The daily job and the delete actions drain the same queue on their own; nobody else needs to trigger it.)
 */
export function mayRunStorageCleanup(
  status: string | null | undefined,
  roles: readonly string[] | null | undefined,
  adminRoles: readonly string[],
): boolean {
  if (status !== "active") return false;
  return (roles ?? []).some((r) => adminRoles.includes(r));
}
