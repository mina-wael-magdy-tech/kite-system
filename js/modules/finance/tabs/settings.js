/**
 * KITE SYSTEM — Finance › Settings
 * Company details printed on invoices, default VAT and withholding rates, payment terms, invoice prefix and bank details.
 * Nothing is hardcoded: every rate here is editable. (Social insurance and income-tax brackets arrive with the Taxes step.)
 * Only the owner or finance manager can change them; the accountant can read them.
 */

import { Api } from '../../../services/api.js';
import { Toast } from '../../../services/toast-service.js';
import { Money } from '../../../services/money.js';
import { escapeHTML } from '../../../utils/helpers.js';

const FIELDS = [
  ['Company', [
    ['company_name_en', 'Company name (English)', 'text'], ['company_name_ar', 'Company name (Arabic)', 'text'],
    ['tax_registration_no', 'Tax registration number', 'text'], ['commercial_register_no', 'Commercial register no.', 'text'],
    ['phone', 'Phone', 'text'], ['email', 'Email', 'email'],
    ['address_en', 'Address (English)', 'text'], ['address_ar', 'Address (Arabic)', 'text']]],
  ['Invoicing defaults', [
    ['vat_rate', 'VAT rate %', 'number'], ['default_withholding_rate', 'Default withholding tax %', 'number'],
    ['default_payment_terms_days', 'Default payment terms (days)', 'number'], ['invoice_prefix', 'Invoice number prefix (A–Z, 0–9)', 'text']]]
];

export class SettingsTab {
  constructor(shell) { this.shell = shell; }

  html() {
    const s = this.shell.base.settings;
    const can = Money.isSenior();
    const field = ([name, label, type]) => `<div class="form-group"><label class="form-label" for="st_${name}">${label}</label>
      <input id="st_${name}" name="${name}" type="${type}" class="form-control" value="${escapeHTML(s[name] ?? '')}" ${type === 'number' ? 'step="0.01" min="0"' : ''} ${can ? '' : 'disabled'} /></div>`;
    return `<form id="stForm" class="card" style="padding: var(--space-4); display:flex; flex-direction:column; gap: var(--space-4);">
      ${FIELDS.map(([title, fs]) => `<div><div class="text-2xs font-bold text-dim uppercase" style="margin-bottom:6px">${title}</div><div class="fin-form">${fs.map(field).join('')}</div></div>`).join('')}
      <div><div class="text-2xs font-bold text-dim uppercase" style="margin-bottom:6px">Bank details (printed on every invoice)</div>
        <textarea id="st_bank_details" name="bank_details" rows="3" class="form-control" ${can ? '' : 'disabled'} placeholder="Bank, account name, IBAN, SWIFT">${escapeHTML(s.bank_details || '')}</textarea></div>
      <div id="stNote" class="text-2xs text-muted">${can ? 'Changing a rate affects NEW invoices only. Issued invoices keep the rates they were created with.' : 'Only the owner or the finance manager can change these settings.'}</div>
      ${can ? '<div><button type="submit" class="btn btn-primary btn-sm">Save settings</button></div>' : ''}
    </form>`;
  }

  async mount() {
    document.getElementById('stForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {};
      new FormData(e.target).forEach((v, k) => { body[k] = String(v).trim(); });
      try {
        await Api.finance('settings.update', body);
        Toast.success('Settings saved', 'Finance');
        await this.shell.reloadBase();
      } catch (err) { Toast.error(err.message, 'Could not save'); }
    });
  }
}
