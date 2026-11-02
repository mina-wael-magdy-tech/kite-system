# PULSE STUDIO OS — Creative Agency Operating System

![PULSE STUDIO OS](https://img.shields.io/badge/Platform-PULSE%20STUDIO%20OS-indigo?style=for-the-badge)
![Supabase](https://img.shields.io/badge/Database-Supabase%20PostgreSQL-emerald?style=for-the-badge)
![Status](https://img.shields.io/badge/Production-Ready-blue?style=for-the-badge)

A complete, production-ready, multi-user company management operating system built specifically for modern creative design studios and advertising agencies.

---

## 1. System Mission & Core Capabilities
**PULSE STUDIO OS** centralizes daily agency operations into one unified platform. It provides dedicated role-based perspectives for company owners, department managers, creative specialists, and project coordinators across the 5 core creative hubs:
1. **Branding** — Visual identity systems, typography, color tokens & style manuals.
2. **BTL (Below The Line)** — Exhibition booths, pop-up kiosks, packaging & print production.
3. **Digital Marketing** — Paid ads, conversion funnels, SEO/SEM & campaign calendars.
4. **Media Production** — 4K video editing, 3D motion reels, color grading & audio engineering.
5. **Web Development** — Interactive WebGL, UI/UX engineering & e-commerce flows.

---

## 2. Technical Stack
- **Frontend**: HTML5, Modern CSS3 with Design Tokens, Vanilla JavaScript (ES6+ with ES Modules).
- **Backend & Database**: Supabase (PostgreSQL 15+, Row Level Security, Edge Functions, Realtime Subscriptions, Private Storage).
- **Visualization**: Chart.js (vendored, pinned) for analytics.
- **Icons**: Lucide (vendored, pinned).
- **Hosting**: Standalone web host (e.g. Hostinger) with seamless embedding support for **Google Sites**.

---

## 3. Key Modules

| Module | Core Functionality |
|---|---|
| **Executive Dashboard** | Real-time agency KPIs, active sprints, department workload distribution charts, and deliverable summaries. |
| **Task Management** | 9 lifecycle statuses, 4 priority tiers, dual Kanban & Table views, checklists, feedback notes, and peer task isolation. |
| **Project Management** | Multi-department client projects, project codes, target deadlines, milestones, and budget utilization. |
| **Studio Campaigns** | Cross-department campaigns harmonizing Branding, BTL, Digital, Media, and Web Dev. |
| **Employee Directory** | Staff roster, job titles, department assignments, profile management, and secure employee invitations. |
| **5 Studio Departments** | Department overview, designated leads, budget allocations, and member counts. |
| **HR Operations** | Daily attendance check-in/out, hours tracking, leave requests, manager approvals, and holiday calendar. |
| **CRM & Client Funnel** | Client account portfolio, contact persons, and 7-stage deal opportunity pipeline. |
| **Finance & Budgets** | Annual budgets, expense claim submissions, manager approvals, and client invoices. |
| **Documents Vault** | Secure digital asset management with Supabase Storage private buckets. |
| **Role Chat & Handoffs** | Direct role-to-role messaging, studio channels, and instant task dispatch cards in chat. |
| **Reports & Analytics** | Agency productivity metrics, priority breakdown, and one-click CSV spreadsheet export. |
| **Admin Control Center** | Access-model overview, task override/reassignment, and the server-written audit log. |

---

## 4. Quickstart Guide

### 4.1 Clone or Download
Ensure files are located in your web directory:
```text
pulse-studio-os/
├── index.html
├── login.html
├── forgot-password.html
├── reset-password.html
├── invitation.html
├── env.js                (your Supabase URL + anon key)
├── .htaccess             (security headers)
├── css/
├── js/
├── vendor/               (pinned third-party libraries)
├── supabase/             (migrations, seed, Edge Functions, tests)
└── docs/
```

### 4.2 Configure Database
Apply `supabase/migrations/001`–`004` in order, then `supabase/seed.sql` (see [Installation Guide](docs/installation.md)).

### 4.3 Configure Credentials
Edit **`env.js`** with your Supabase Project URL and public `anon` key. Deploy the Edge Functions and set their secrets (`docs/installation.md` §5), then create the first admin (§7).

### 4.4 Launch
Serve the directory with any local or production web server:
```powershell
python -m http.server 8000
```
Open `http://localhost:8000/login.html` in your browser.

Before going live, complete the [Production Checklist](docs/production-checklist.md).

---

## 5. Documentation
- [Installation Guide](docs/installation.md)
- [Database Schema Reference](docs/database.md)
- [Cybersecurity & Access Control](docs/security.md)
- [Production Checklist](docs/production-checklist.md)
- [Production Deployment Guide](docs/deployment.md)
- [Google Sites Embedding Instructions](docs/google-sites-embedding.md)
