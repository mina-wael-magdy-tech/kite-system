/**
 * PULSE STUDIO OS — Module G: CRM & Client Management
 * Client accounts, deal pipeline, pitch proposals & client communication history.
 */

import { getSupabase } from '../../supabase-client.js';
import { Toast } from '../../services/toast-service.js';
import { escapeHTML, formatCurrency } from '../../utils/helpers.js';
import { formatLeadStageBadge } from '../../utils/formatters.js';

export class CrmModule {
  constructor(app) {
    this.app = app;
    this.clients = [];
    this.leads = [];
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">CRM & Client Pipeline</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Manage client relationships, pitch proposals, and creative agency accounts.
            </p>
          </div>

          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-primary btn-sm" id="btnCreateClient">
              <i data-lucide="building"></i> Add New Client
            </button>
            <button type="button" class="btn btn-secondary btn-sm" id="btnCreateLead">
              <i data-lucide="plus"></i> New Deal / Opportunity
            </button>
          </div>
        </div>

        <!-- Deal Pipeline Stages (7 Stages) -->
        <div>
          <div style="margin-bottom: var(--space-3); display: flex; align-items: center; justify-content: space-between;">
            <h2 class="font-display font-bold text-sm text-white">Deal Funnel & Pitch Pipeline</h2>
            <span class="badge badge-emerald font-bold" id="pipelineTotalVal">Pipeline: $0</span>
          </div>

          <div id="pipelineContainer" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-3); overflow-x: auto; padding-bottom: var(--space-2);">
            <!-- Pipeline columns populated dynamically -->
          </div>
        </div>

        <!-- Client Accounts Table -->
        <div class="card" style="margin-top: var(--space-4);">
          <div class="card-header">
            <div class="card-title">Client Portfolio</div>
            <span class="badge badge-indigo" id="clientCountBadge">0 Clients</span>
          </div>
          <div class="card-body" style="padding: 0;">
            <div class="table-responsive" style="border: none; border-radius: 0;">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Company / Brand</th>
                    <th>Industry</th>
                    <th>Contact Person</th>
                    <th>Email & Phone</th>
                    <th>Status</th>
                    <th>Active Projects</th>
                  </tr>
                </thead>
                <tbody id="clientsTableBody">
                  <tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">Loading clients...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btnCreateClient')?.addEventListener('click', () => this.openClientModal());
    document.getElementById('btnCreateLead')?.addEventListener('click', () => this.openLeadModal());

    await this.loadCrmData();
  }

  async loadCrmData() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      // 1. Fetch Clients
      const { data: clients } = await supabase
        .from('clients')
        .select('*, projects(id, name)')
        .order('company_name', { ascending: true });

      this.clients = clients || [];

      // 2. Fetch Leads / Opportunities
      const { data: leads } = await supabase
        .from('leads')
        .select('*, client:clients(name, company_name)')
        .order('created_at', { ascending: false });

      this.leads = leads || [];

      this.renderPipeline();
      this.renderClientsTable();
    } catch (err) {
      console.warn('CRM fetch error:', err);
      this.renderPipeline();
      this.renderClientsTable();
    }
  }

  renderPipeline() {
    const container = document.getElementById('pipelineContainer');
    const totalValEl = document.getElementById('pipelineTotalVal');
    if (!container) return;

    const stages = [
      { id: 'new', label: 'New Lead' },
      { id: 'contacted', label: 'Contacted' },
      { id: 'qualified', label: 'Qualified' },
      { id: 'proposal_sent', label: 'Proposal Sent' },
      { id: 'negotiation', label: 'Negotiation' },
      { id: 'won', label: 'Closed Won' }
    ];

    const displayLeads = this.leads;

    let totalVal = 0;

    container.innerHTML = stages.map(s => {
      const stageLeads = displayLeads.filter(l => l.stage === s.id);
      const stageVal = stageLeads.reduce((acc, l) => acc + (Number(l.value) || 0), 0);
      totalVal += stageVal;

      return `
        <div class="glass-panel" style="padding: var(--space-3); min-height: 220px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-2); border-bottom: 1px solid var(--border-subtle); padding-bottom: 4px;">
            <span class="text-xs font-bold text-white">${s.label}</span>
            <span class="badge badge-slate" style="font-size: 10px;">${stageLeads.length}</span>
          </div>

          <div style="display: flex; flex-direction: column; gap: var(--space-2); flex: 1;">
            ${stageLeads.map(l => `
              <div class="card" style="padding: var(--space-2-5); background: var(--studio-950); border-color: var(--border-subtle);">
                <div class="font-semibold text-xs text-white">${escapeHTML(l.title)}</div>
                <div class="text-2xs text-muted" style="margin-top: 2px;">${escapeHTML(l.client?.company_name || 'Client')}</div>
                <div class="text-2xs font-mono font-bold text-emerald" style="margin-top: 4px;">${formatCurrency(l.value)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');

    if (totalValEl) totalValEl.textContent = `Active Pipeline: ${formatCurrency(totalVal)}`;
  }

  renderClientsTable() {
    const tbody = document.getElementById('clientsTableBody');
    const badge = document.getElementById('clientCountBadge');
    if (!tbody) return;

    const displayClients = this.clients;

    if (badge) badge.textContent = `${displayClients.length} Accounts`;
    if (displayClients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">No client accounts yet.</td></tr>';
      return;
    }

    tbody.innerHTML = displayClients.map(c => `
      <tr>
        <td>
          <div class="font-bold text-white">${escapeHTML(c.company_name)}</div>
        </td>
        <td><span class="badge badge-indigo">${escapeHTML(c.industry || 'General')}</span></td>
        <td class="text-xs text-muted">${escapeHTML(c.name || 'Direct')}</td>
        <td class="font-mono text-2xs text-dim">${escapeHTML(c.email || '—')}<br>${escapeHTML(c.phone || '')}</td>
        <td><span class="badge badge-emerald">${escapeHTML(c.status?.toUpperCase() || 'ACTIVE')}</span></td>
        <td class="text-xs text-white">${c.projects ? c.projects.length : 0} Projects</td>
      </tr>
    `).join('');
  }

  openClientModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    modalDialog.style.maxWidth = '480px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">Add Studio Client</h2>
        <button type="button" class="modal-close-btn" id="btnCancelClient">&times;</button>
      </div>

      <form id="createClientForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="clientCompany">Company / Brand Name *</label>
            <input id="clientCompany" type="text" required placeholder="e.g. Apex Holdings Ltd" class="form-control" />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="clientContact">Contact Person</label>
              <input id="clientContact" type="text" placeholder="e.g. Ahmed Samir" class="form-control" />
            </div>
            <div class="form-group">
              <label class="form-label" for="clientIndustry">Industry</label>
              <input id="clientIndustry" type="text" placeholder="e.g. Real Estate" class="form-control" />
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="clientEmail">Email Address</label>
              <input id="clientEmail" type="email" placeholder="contact@company.com" class="form-control" />
            </div>
            <div class="form-group">
              <label class="form-label" for="clientPhone">Phone Number</label>
              <input id="clientPhone" type="text" placeholder="+20 100 000 0000" class="form-control" />
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelClientAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Save Client</button>
        </div>
      </form>
    `;

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelClient')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelClientAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('createClientForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const companyName = document.getElementById('clientCompany').value.trim();
      const contactName = document.getElementById('clientContact').value.trim();
      const industry = document.getElementById('clientIndustry').value.trim();
      const email = document.getElementById('clientEmail').value.trim();
      const phone = document.getElementById('clientPhone').value.trim();

      const supabase = getSupabase();
      try {
        const { error } = await supabase.from('clients').insert({
          company_name: companyName,
          name: contactName || companyName,
          industry,
          email,
          phone,
          status: 'active',
          created_by: this.app.currentUser.id
        });

        if (error) throw error;
        Toast.success(`Client account "${companyName}" added!`, 'Client Portfolio');
        modalBackdrop.classList.remove('active');
        await this.loadCrmData();
      } catch (err) {
        console.error('Client error:', err);
        Toast.error(err.message || 'Failed to save client', 'Error');
      }
    });
  }

  openLeadModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    modalDialog.style.maxWidth = '480px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">New Deal / Opportunity</h2>
        <button type="button" class="modal-close-btn" id="btnCancelLead">&times;</button>
      </div>

      <form id="createLeadForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="dealTitle">Deal Title *</label>
            <input id="dealTitle" type="text" required placeholder="e.g. 2027 Rebrand & Expo Booth Fabrication" class="form-control" />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="dealValue">Estimated Value ($) *</label>
              <input id="dealValue" type="number" required value="35000" class="form-control" />
            </div>
            <div class="form-group">
              <label class="form-label" for="dealStage">Initial Stage</label>
              <select id="dealStage" class="form-control">
                <option value="new">New Lead</option>
                <option value="contacted">Contacted</option>
                <option value="qualified">Qualified</option>
                <option value="proposal_sent" selected>Proposal Sent</option>
                <option value="negotiation">Negotiation</option>
              </select>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelLeadAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Add Opportunity</button>
        </div>
      </form>
    `;

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelLead')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelLeadAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('createLeadForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const title = document.getElementById('dealTitle').value.trim();
      const value = Number(document.getElementById('dealValue').value) || 0;
      const stage = document.getElementById('dealStage').value;

      const supabase = getSupabase();
      try {
        const { error } = await supabase.from('leads').insert({
          title,
          value,
          stage,
          created_by: this.app.currentUser.id
        });

        if (error) throw error;
        Toast.success('Deal opportunity added to funnel!', 'Pipeline Updated');
        modalBackdrop.classList.remove('active');
        await this.loadCrmData();
      } catch (err) {
        console.error('Lead error:', err);
        Toast.error(err.message || 'Failed to add deal', 'Error');
      }
    });
  }
}
