/**
 * KITE SYSTEM — Client-Side Permission & Role Engine
 * Mirrors backend RLS authorization policies for responsive UI rendering.
 */

import { getSupabase } from '../supabase-client.js';
import { CONFIG } from '../config.js';

export class PermissionService {
  constructor() {
    this.userId = null;
    this.roles = [];
    this.permissions = [];
    this.departments = [];
    this.userProfile = null;
  }

  async loadUserAccess(userId) {
    this.userId = userId;
    const supabase = getSupabase();
    if (!supabase || !userId) return;

    try {
      // 1. Fetch user profile
      const { data: profile } = await supabase
        .from('profiles')
        .select(CONFIG.PROFILE_COLUMNS)
        .eq('id', userId)
        .single();
      this.userProfile = profile;

      // 2. Fetch assigned roles
      const { data: userRoles } = await supabase
        .from('user_roles')
        .select('role_id, roles(id, name, display_name, priority)')
        .eq('user_id', userId);

      this.roles = (userRoles || [])
        .map(ur => ur.roles)
        .filter(Boolean);

      // 3. Fetch user departments
      const { data: userDepts } = await supabase
        .from('user_departments')
        .select('department_id, is_primary, departments!user_departments_department_id_fkey(id, name, code)')
        .eq('user_id', userId);

      this.departments = (userDepts || [])
        .map(ud => ud.departments)
        .filter(Boolean);

      // If user has direct department_id on profile
      if (profile?.department_id && !this.departments.some(d => d.id === profile.department_id)) {
        const { data: directDept } = await supabase
          .from('departments')
          .select('id, name, code')
          .eq('id', profile.department_id)
          .single();
        if (directDept) this.departments.push(directDept);
      }
    } catch (err) {
      console.warn('Error loading user permissions:', err);
    }
  }

  hasRole(roleName) {
    return this.roles.some(r => r.name === roleName);
  }

  /** Owner / CEO: the only people who see every department and all money. */
  isOwner() {
    return this.roles.some(r => ['super_admin', 'owner', 'ceo'].includes(r.name));
  }

  /** Ids of the departments this person belongs to. */
  myDeptIds() {
    const ids = new Set((this.departments || []).map(d => d.id));
    if (this.userProfile?.department_id) ids.add(this.userProfile.department_id);
    return ids;
  }

  isAdmin() {
    return this.roles.some(r => ['super_admin', 'owner', 'general_manager'].includes(r.name));
  }

  isManager() {
    return (
      this.isAdmin() ||
      this.roles.some(r => ['department_manager', 'project_manager', 'team_leader'].includes(r.name))
    );
  }

  isDepartmentManager(deptId) {
    if (this.isAdmin()) return true;
    return this.hasRole('department_manager') && this.departments.some(d => d.id === deptId);
  }

  getPrimaryDepartment() {
    return this.departments[0] || null;
  }

  getPrimaryRole() {
    if (this.roles.length === 0) return { name: 'employee', display_name: 'Employee' };
    // Sorted by priority (lower number = higher priority)
    return [...this.roles].sort((a, b) => (a.priority || 100) - (b.priority || 100))[0];
  }

  canAccessModule(moduleRoute) {
    if (this.isAdmin()) return true;

    switch (moduleRoute) {
      case 'admin':
        return this.isAdmin();
      case 'finance':
        return this.isAdmin() || this.hasRole('finance_manager');
      case 'hr':
        return this.isAdmin() || this.hasRole('hr_manager');
      case 'crm':
        return this.isAdmin() || this.isManager() || this.hasRole('digital_marketing');
      default:
        return true;
    }
  }
}

export const Permissions = new PermissionService();
