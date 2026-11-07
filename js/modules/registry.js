/**
 * KITE SYSTEM — Module registry
 * One explicit contract per page (see core/module-contract.js). app.js only walks this list.
 */
import { defineModule } from '../core/module-contract.js';
import { DashboardModule } from './dashboard/dashboard.js';
import { TasksModule } from './tasks/tasks.js';
import { ProjectsModule } from './projects/projects.js';
import { ClientHubModule } from './clients/client-hub.js';
import { CampaignsModule } from './campaigns/campaigns.js';
import { EmployeesModule } from './employees/employees.js';
import { DepartmentsModule } from './departments/departments.js';
import { HrModule } from './hr/hr.js';
import { BroadcastModule, canBroadcast } from './broadcast/broadcast.js';
import { CrmModule } from './crm/crm.js';
import { FinanceModule } from './finance/finance.js';
import { QrModule } from './qr/qr-generator.js';
import { DocumentsModule } from './documents/documents.js';
import { ChatModule } from './chat/chat.js';
import { ReportsModule } from './reports/reports.js';
import { AdminModule } from './admin/admin.js';
import { CalendarModule } from './calendar/calendar.js';

export const MODULES = [
  defineModule({ id: 'dashboard', title: 'Executive Dashboard', breadcrumbs: ['KITE', 'Executive Dashboard'], create: (app) => new DashboardModule(app) }),
  defineModule({ id: 'tasks', title: 'Task Management', breadcrumbs: ['Agency Workspace', 'Tasks & Sprints'], create: (app) => new TasksModule(app) }),
  defineModule({ id: 'calendar', title: 'Calendar & Timeline', breadcrumbs: ['Agency Workspace', 'Calendar & Timeline'], create: (app) => new CalendarModule(app) }),
  defineModule({ id: 'clients', title: 'Clients', breadcrumbs: ['Agency Workspace', 'Clients'], create: (app) => new ClientHubModule(app) }),
  defineModule({ id: 'projects', title: 'Client Projects', breadcrumbs: ['Agency Workspace', 'Projects & Milestones'], create: (app) => new ProjectsModule(app) }),
  defineModule({ id: 'campaigns', title: 'Studio Campaigns', breadcrumbs: ['Agency Workspace', 'Cross-Dept Campaigns'], create: (app) => new CampaignsModule(app) }),
  defineModule({ id: 'employees', title: 'Employee Directory', breadcrumbs: ['Studio Organization', 'People & Profiles'], create: (app) => new EmployeesModule(app) }),
  defineModule({ id: 'departments', title: 'Studio Departments', breadcrumbs: ['Studio Organization', '5 Departments'], create: (app) => new DepartmentsModule(app) }),
  defineModule({ id: 'broadcast', title: 'Announcements', breadcrumbs: ['System Control', 'Announcements'], create: (app) => new BroadcastModule(app) }),
  defineModule({ id: 'hr', title: 'HR & Attendance', breadcrumbs: ['Studio Organization', 'Attendance & Leaves'], create: (app) => new HrModule(app) }),
  defineModule({ id: 'crm', title: 'CRM & Pipelines', breadcrumbs: ['Client & Finance', 'Clients & Deals'], create: (app) => new CrmModule(app) }),
  defineModule({ id: 'finance', title: 'Finance & Budgets', breadcrumbs: ['Client & Finance', 'Expenses & Invoices'], create: (app) => new FinanceModule(app) }),
  defineModule({ id: 'documents', title: 'Documents Vault', breadcrumbs: ['Client & Finance', 'Digital Assets & Vault'], create: (app) => new DocumentsModule(app) }),
  defineModule({ id: 'chat', title: 'Role Chat & Handoffs', breadcrumbs: ['Collaboration', 'Live Channels & DMs'], create: (app) => new ChatModule(app) }),
  defineModule({ id: 'qr', title: 'QR Code Generator', breadcrumbs: ['Collaboration', 'QR Code Generator'], create: (app) => new QrModule(app) }),
  defineModule({ id: 'reports', title: 'Analytics & Reports', breadcrumbs: ['Collaboration', 'Executive Analytics'], create: (app) => new ReportsModule(app) }),
  defineModule({ id: 'admin', title: 'Admin Control Center', breadcrumbs: ['System Control', 'Master Admin Center'], create: (app) => new AdminModule(app) }),
];
