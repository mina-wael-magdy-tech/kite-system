/**
 * KITE SYSTEM — Master Application Entry Point
 * Orchestrates session authentication, permission loading, module registration, and UI shell events.
 */

import { protectPage } from './auth/auth-guard.js';
import { Auth } from './auth/auth-service.js';
import { Permissions } from './permissions/permission-service.js';
import { Notifications } from './services/notification-service.js';
import { AppRouter } from './router.js';
import { getInitials, getAccentHex, escapeHTML } from './utils/helpers.js';

// Import All 14 Core Modules
import { DashboardModule } from './modules/dashboard/dashboard.js';
import { TasksModule } from './modules/tasks/tasks.js';
import { ProjectsModule } from './modules/projects/projects.js';
import { CampaignsModule } from './modules/campaigns/campaigns.js';
import { EmployeesModule } from './modules/employees/employees.js';
import { DepartmentsModule } from './modules/departments/departments.js';
import { HrModule } from './modules/hr/hr.js';
import { CrmModule } from './modules/crm/crm.js';
import { FinanceModule } from './modules/finance/finance.js';
import { DocumentsModule } from './modules/documents/documents.js';
import { ChatModule } from './modules/chat/chat.js';
import { ReportsModule } from './modules/reports/reports.js';
import { AdminModule } from './modules/admin/admin.js';

class PulseStudioApp {
  constructor() {
    this.currentUser = null;
    this.currentProfile = null;
  }

  async init() {
    // Charts follow the brand typography / text colour
    if (window.Chart) {
      window.Chart.defaults.font.family = "'Poppins', 'Segoe UI', sans-serif";
      window.Chart.defaults.color = '#a6a9b3';
    }

    // 1. Validate Session & Account Access
    this.currentProfile = await protectPage();
    if (!this.currentProfile) return; // protectPage redirects to login if unauthenticated

    this.currentUser = { id: this.currentProfile.id, email: this.currentProfile.email };

    // 2. Hydrate Roles & Permissions
    await Permissions.loadUserAccess(this.currentProfile.id);

    // 3. Update Shell UI (Sidebar, Topbar, User Info)
    this.updateShellUI();

    // 4. Initialize Notifications & Realtime
    await Notifications.loadUserNotifications(this.currentProfile.id);
    Notifications.subscribeRealtime(this.currentProfile.id);

    // 5. Register All Application Modules in Router
    this.registerModules();

    // 6. Setup Shell Event Handlers
    this.setupEventListeners();

    // 7. Mount Router to Content Container
    const contentContainer = document.getElementById('mainContentContainer');
    AppRouter.init(contentContainer);

    // 8. Re-render Lucide Icons
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  updateShellUI() {
    const profile = this.currentProfile;
    const primaryRole = Permissions.getPrimaryRole();
    const initials = getInitials(profile.full_name || profile.email);
    const accent = getAccentHex(profile.full_name || profile.email);

    // Topbar
    const topbarAvatar = document.getElementById('topbarAvatar');
    const topbarUserName = document.getElementById('topbarUserName');
    if (topbarAvatar) {
      topbarAvatar.textContent = initials;
      topbarAvatar.style.backgroundColor = accent;
    }
    if (topbarUserName) {
      topbarUserName.textContent = profile.full_name || 'Specialist';
    }

    // Sidebar footer
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    const sidebarUserName = document.getElementById('sidebarUserName');
    const sidebarUserRole = document.getElementById('sidebarUserRole');
    if (sidebarAvatar) {
      sidebarAvatar.textContent = initials;
      sidebarAvatar.style.backgroundColor = accent;
    }
    if (sidebarUserName) {
      sidebarUserName.textContent = profile.full_name || 'Team Member';
    }
    if (sidebarUserRole) {
      sidebarUserRole.textContent = `${primaryRole.display_name} • ${profile.departments?.name || 'Studio'}`;
    }

    // User menu dropdown
    const menuFullName = document.getElementById('menuFullName');
    const menuEmail = document.getElementById('menuEmail');
    if (menuFullName) menuFullName.textContent = profile.full_name || 'Employee';
    if (menuEmail) menuEmail.textContent = profile.email;

    // Show/Hide Admin Nav based on Permissions
    const adminNavGroup = document.getElementById('adminNavGroup');
    const menuAdminLink = document.getElementById('menuAdminLink');
    const isAdmin = Permissions.isAdmin();

    if (adminNavGroup) adminNavGroup.style.display = isAdmin ? 'block' : 'none';
    if (menuAdminLink) menuAdminLink.style.display = isAdmin ? 'flex' : 'none';
  }

  registerModules() {
    AppRouter.register('dashboard', {
      title: 'Executive Dashboard',
      breadcrumbs: ['KITE', 'Executive Dashboard'],
      render: (container, query) => new DashboardModule(this).render(container, query)
    });

    AppRouter.register('tasks', {
      title: 'Task Management',
      breadcrumbs: ['Agency Workspace', 'Tasks & Sprints'],
      render: (container, query) => new TasksModule(this).render(container, query)
    });

    AppRouter.register('projects', {
      title: 'Client Projects',
      breadcrumbs: ['Agency Workspace', 'Projects & Milestones'],
      render: (container, query) => new ProjectsModule(this).render(container, query)
    });

    AppRouter.register('campaigns', {
      title: 'Studio Campaigns',
      breadcrumbs: ['Agency Workspace', 'Cross-Dept Campaigns'],
      render: (container, query) => new CampaignsModule(this).render(container, query)
    });

    AppRouter.register('employees', {
      title: 'Employee Directory',
      breadcrumbs: ['Studio Organization', 'People & Profiles'],
      render: (container, query) => new EmployeesModule(this).render(container, query)
    });

    AppRouter.register('departments', {
      title: 'Studio Departments',
      breadcrumbs: ['Studio Organization', '5 Departments'],
      render: (container, query) => new DepartmentsModule(this).render(container, query)
    });

    AppRouter.register('hr', {
      title: 'HR & Attendance',
      breadcrumbs: ['Studio Organization', 'Attendance & Leaves'],
      render: (container, query) => new HrModule(this).render(container, query)
    });

    AppRouter.register('crm', {
      title: 'CRM & Pipelines',
      breadcrumbs: ['Client & Finance', 'Clients & Deals'],
      render: (container, query) => new CrmModule(this).render(container, query)
    });

    AppRouter.register('finance', {
      title: 'Finance & Budgets',
      breadcrumbs: ['Client & Finance', 'Expenses & Invoices'],
      render: (container, query) => new FinanceModule(this).render(container, query)
    });

    AppRouter.register('documents', {
      title: 'Documents Vault',
      breadcrumbs: ['Client & Finance', 'Digital Assets & Vault'],
      render: (container, query) => new DocumentsModule(this).render(container, query)
    });

    AppRouter.register('chat', {
      title: 'Role Chat & Handoffs',
      breadcrumbs: ['Collaboration', 'Live Channels & DMs'],
      render: (container, query) => new ChatModule(this).render(container, query)
    });

    AppRouter.register('reports', {
      title: 'Analytics & Reports',
      breadcrumbs: ['Collaboration', 'Executive Analytics'],
      render: (container, query) => new ReportsModule(this).render(container, query)
    });

    AppRouter.register('admin', {
      title: 'Admin Control Center',
      breadcrumbs: ['System Control', 'Master Admin Center'],
      render: (container, query) => new AdminModule(this).render(container, query)
    });
  }

  setupEventListeners() {
    // Sidebar collapse toggle
    const sidebar = document.getElementById('appSidebar');
    const collapseBtn = document.getElementById('sidebarCollapseBtn');
    collapseBtn?.addEventListener('click', () => {
      sidebar?.classList.toggle('collapsed');
      if (window.lucide) window.lucide.createIcons();
    });

    // Mobile drawer toggle
    const mobileToggle = document.getElementById('sidebarMobileToggle');
    const overlay = document.getElementById('sidebarOverlay');
    mobileToggle?.addEventListener('click', () => {
      sidebar?.classList.add('mobile-open');
      overlay?.classList.add('active');
    });
    overlay?.addEventListener('click', () => {
      sidebar?.classList.remove('mobile-open');
      overlay?.classList.remove('active');
    });

    // User menu toggle
    const userMenuBtn = document.getElementById('userMenuBtn');
    const userDropdownMenu = document.getElementById('userDropdownMenu');
    userMenuBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = userDropdownMenu.style.display === 'block';
      userDropdownMenu.style.display = isVisible ? 'none' : 'block';
    });

    document.addEventListener('click', () => {
      if (userDropdownMenu) userDropdownMenu.style.display = 'none';
    });

    // Sign out button
    document.getElementById('signOutBtn')?.addEventListener('click', () => {
      Auth.signOut();
    });

    // Notification Panel Toggle
    const notifBtn = document.getElementById('notifBellBtn');
    const notifPanelBackdrop = document.getElementById('notificationPanelBackdrop');
    const closeNotifBtn = document.getElementById('btnCloseNotifPanel');
    const markAllReadBtn = document.getElementById('btnMarkAllRead');

    notifBtn?.addEventListener('click', () => {
      this.renderNotificationSlidePanel();
      notifPanelBackdrop?.classList.add('active');
    });

    closeNotifBtn?.addEventListener('click', () => {
      notifPanelBackdrop?.classList.remove('active');
    });

    notifPanelBackdrop?.addEventListener('click', (e) => {
      if (e.target === notifPanelBackdrop) {
        notifPanelBackdrop.classList.remove('active');
      }
    });

    markAllReadBtn?.addEventListener('click', () => {
      Notifications.markAllAsRead(this.currentUser.id);
      this.renderNotificationSlidePanel();
    });
  }

  renderNotificationSlidePanel() {
    const feed = document.getElementById('notificationPanelFeed');
    if (!feed) return;

    const notifs = Notifications.notifications;
    if (notifs.length === 0) {
      feed.innerHTML = `
        <div class="empty-state" style="border:none; padding: 40px 10px;">
          <div class="empty-state-icon">🔔</div>
          <div class="empty-state-title">No notifications yet</div>
          <div class="empty-state-desc">You're completely up to date with tasks and approvals.</div>
        </div>
      `;
      return;
    }

    feed.innerHTML = notifs.map(n => `
      <div class="card notif-item" data-notif-id="${escapeHTML(n.id)}" data-link="${escapeHTML(n.link || '')}" style="padding: var(--space-3); background-color: ${n.is_read ? 'var(--studio-950)' : 'var(--studio-850)'}; border-color: ${n.is_read ? 'var(--border-subtle)' : 'var(--color-primary-border)'}; cursor: pointer;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2px;">
          <span class="text-xs font-bold text-white">${escapeHTML(n.title)}</span>
          ${!n.is_read ? '<span class="badge badge-indigo" style="font-size: 9px; padding: 1px 5px;">New</span>' : ''}
        </div>
        <p class="text-2xs text-muted" style="line-height: 1.4;">${escapeHTML(n.content)}</p>
      </div>
    `).join('');

    // Delegated click handling (no inline handlers: required by the strict CSP)
    if (!feed.dataset.bound) {
      feed.dataset.bound = '1';
      feed.addEventListener('click', (e) => {
        const item = e.target.closest('.notif-item');
        if (item) this.handleNotificationClick(item.dataset.notifId, item.dataset.link);
      });
    }
  }

  handleNotificationClick(notifId, link) {
    Notifications.markAsRead(notifId);
    document.getElementById('notificationPanelBackdrop')?.classList.remove('active');
    // Only in-app hash routes are followed
    window.location.hash = /^#[a-z-]+$/.test(link || '') ? link : '#tasks';
  }
}

// Global initialization
window.pulseApp = new PulseStudioApp();
document.addEventListener('DOMContentLoaded', () => {
  window.pulseApp.init();
});
