/**
 * KITE SYSTEM — Assignee dropdown helpers
 * A person in several departments appears once per department, so the task's department is
 * chosen by picking the right entry ("Mona (Branding)" vs "Mona (Digital Marketing)").
 */

import { escapeHTML } from './helpers.js';

/** profiles query fragment that also loads every department of a person. */
export const ASSIGNEE_SELECT =
  'id, full_name, job_title, department_id, departments!profiles_department_id_fkey(name), ' +
  'user_departments!user_departments_user_id_fkey(is_primary, department_id, departments!user_departments_department_id_fkey(name))';

/** [{ userId, name, deptId, deptName }] — one entry per (person, department), primary first. */
export function assigneeEntries(employees = []) {
  const out = [];
  for (const e of employees) {
    const depts = [...(e.user_departments || [])]
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
      .map(d => ({ id: d.department_id, name: d.departments?.name }))
      .filter(d => d.id);
    if (e.department_id && !depts.some(d => d.id === e.department_id)) {
      depts.unshift({ id: e.department_id, name: e.departments?.name });
    }
    if (!depts.length) depts.push({ id: '', name: 'Studio' });
    for (const d of depts) {
      out.push({ userId: e.id, name: e.full_name, deptId: d.id, deptName: d.name || 'Studio' });
    }
  }
  return out;
}

export function assigneeOptionsHTML(employees, prefix = '') {
  return assigneeEntries(employees).map(en => `
    <option value="${en.userId}" data-dept="${en.deptId}">
      ${prefix}${escapeHTML(en.name)} (${escapeHTML(en.deptName)})
    </option>`).join('');
}

/** Department id of the currently selected option ('' when none). */
export function selectedDeptId(select) {
  return select?.selectedOptions?.[0]?.dataset?.dept || '';
}
