/**
 * KITE SYSTEM — Finance PDFs (invoice now; payslip and expense voucher reuse the same helpers later)
 * Real PDF files built in the browser with pdf-lib + the Cairo font (Arabic and Latin), so Arabic letters join
 * correctly and mixed Arabic / English / number lines read in the right order.
 * The heavy library (vendor/pdf-bundle.js, ~1.3 MB) is only loaded the first time somebody exports a PDF.
 * All amounts come from the server's stored figures; nothing is recalculated here.
 */

import { drawBidi, wrap } from '../utils/bidi-text.js';

let libPromise = null;
const fontCache = {};

function loadLib() {
  if (window.KitePdf) return Promise.resolve();
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf-bundle.js';
      s.onload = () => resolve();
      s.onerror = () => { libPromise = null; reject(new Error('Could not load the PDF engine. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

async function fontBytes(name) {
  if (!fontCache[name]) {
    const res = await fetch(`fonts/${name}`);
    if (!res.ok) throw new Error('Could not load the PDF font.');
    fontCache[name] = await res.arrayBuffer();
  }
  return fontCache[name];
}

const fmtMoney = (n) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
const fmtQty = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(Number(n) || 0);
const fmtDate = (d) => (d ? String(d).slice(0, 10) : '');

/** Labels: both languages, one of them, or "ar / en" */
function labeller(language) {
  return (ar, en) => (language === 'ar' ? ar : language === 'en' ? en : `${ar} / ${en}`);
}

export const FinancePdf = {
  /**
   * @param {{ invoice: object, items: object[], payments?: object[], client: object, billing?: object, settings: object }} d
   * @returns {Promise<Blob>}
   */
  async invoice(d) {
    await loadLib();
    const { PDFDocument, rgb, fontkit, degrees } = window.KitePdf;
    const { invoice: inv, items, client, billing, settings: st } = d;
    const lang = inv.language || 'both';
    const L = labeller(lang);
    const rtl = lang !== 'en';                      // Arabic or bilingual invoices are laid out right to left
    const baseDir = rtl ? 'rtl' : 'ltr';

    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    pdf.setTitle(`${inv.invoice_number}`);
    pdf.setProducer('Kite System');
    const font = await pdf.embedFont(await fontBytes('cairo-400.ttf'), { subset: true });
    const bold = await pdf.embedFont(await fontBytes('cairo-700.ttf'), { subset: true });

    const W = 595.28, H = 841.89, M = 40;
    const ink = rgb(0.08, 0.12, 0.18), grey = rgb(0.4, 0.45, 0.52), red = rgb(0.88, 0.11, 0.16), line = rgb(0.85, 0.88, 0.92);
    const start = rtl ? W - M : M;                  // where text lines begin
    const dirAlign = rtl ? 'right' : 'left';

    const pages = [];
    let page, y;
    const T = (text, o) => drawBidi(page, o.font || font, text, { color: ink, baseDir, ...o });

    const newPage = () => {
      page = pdf.addPage([W, H]); pages.push(page);
      page.drawRectangle({ x: 0, y: H - 86, width: W, height: 86, color: red });
      const nameAr = st.company_name_ar || '', nameEn = st.company_name_en || '';
      const left = lang === 'ar' ? nameAr : nameEn;
      T(left || nameEn, { x: M, y: H - 42, size: 19, font: bold, color: rgb(1, 1, 1), baseDir: lang === 'ar' ? 'rtl' : 'ltr', align: lang === 'ar' ? 'left' : 'left' });
      if (lang === 'both' && nameAr) T(nameAr, { x: W - M, y: H - 42, size: 19, font: bold, color: rgb(1, 1, 1), align: 'right', baseDir: 'rtl' });
      const title = inv.kind === 'payable' ? L('فاتورة مورد', 'Supplier invoice') : L('فاتورة ضريبية', 'Tax Invoice');
      T(title, { x: W - M, y: H - 68, size: 12, color: rgb(1, 1, 1), align: 'right' });
      if (st.tax_registration_no) T(`${L('الرقم الضريبي', 'Tax ID')}: ${st.tax_registration_no}`, { x: M, y: H - 68, size: 9, color: rgb(1, 1, 1), baseDir: 'ltr' });
      y = H - 118;
    };
    newPage();

    // ---- invoice facts (left) and client (right)
    const factsL = rtl ? M : W - M - 215;           // box of 215pt on the side opposite the client block
    const fact = (label, value, yy) => {
      if (rtl) {
        T(label, { x: factsL + 215, y: yy, size: 9, color: grey, align: 'right' });
        T(value, { x: factsL, y: yy, size: 10, align: 'left', baseDir: 'ltr' });
      } else {
        T(label, { x: factsL, y: yy, size: 9, color: grey, align: 'left' });
        T(value, { x: factsL + 215, y: yy, size: 10, align: 'right', baseDir: 'ltr' });
      }
    };
    const clientName = (lang === 'en' ? (billing?.legal_name_en || client?.company_name) : (billing?.legal_name_ar || billing?.legal_name_en || client?.company_name)) || '';
    const factsTop = y;
    fact(L('رقم الفاتورة', 'Invoice No'), inv.invoice_number, y); y -= 16;
    fact(L('تاريخ الإصدار', 'Issue date'), fmtDate(inv.issue_date), y); y -= 16;
    fact(L('تاريخ الاستحقاق', 'Due date'), fmtDate(inv.due_date), y); y -= 16;
    if (inv.currency) { fact(L('العملة', 'Currency'), inv.currency, y); y -= 16; }

    let cy = factsTop;
    T(L('العميل', 'Bill to'), { x: rtl ? W - M : M, y: cy, size: 8.5, color: grey, align: rtl ? 'right' : 'left' }); cy -= 15;
    for (const ln of wrap(bold, 12, clientName, 260, baseDir)) { T(ln, { x: rtl ? W - M : M, y: cy, size: 12, font: bold, align: rtl ? 'right' : 'left' }); cy -= 15; }
    if (billing?.tax_registration_no) { T(`${L('الرقم الضريبي', 'Tax ID')}: ${billing.tax_registration_no}`, { x: rtl ? W - M : M, y: cy, size: 9.5, align: rtl ? 'right' : 'left' }); cy -= 13; }
    if (billing?.billing_address) {
      for (const ln of wrap(font, 9.5, billing.billing_address, 260, baseDir).slice(0, 3)) { T(ln, { x: rtl ? W - M : M, y: cy, size: 9.5, align: rtl ? 'right' : 'left', color: grey }); cy -= 12; }
    }
    y = Math.min(y, cy) - 22;

    // ---- items table. Columns, left to right on the page: total | disc | vat | price | qty | description
    const col = rtl
      ? { total: M + 62, vat: M + 112, disc: M + 160, price: M + 232, qty: M + 280, desc: W - M - 4 }
      : { desc: M + 4, qty: W - M - 270, price: W - M - 205, disc: W - M - 140, vat: W - M - 85, total: W - M - 4 };
    const descWidth = rtl ? (W - M - 4) - (M + 300) : (W - M - 290) - (M + 4);
    const numAlign = 'right';
    const head = () => {
      const two = lang === 'both';
      page.drawRectangle({ x: M, y: y - (two ? 12 : 7), width: W - 2 * M, height: two ? 30 : 22, color: rgb(0.93, 0.95, 0.97) });
      const hs = { size: 8, font: bold };
      const cell = (ar, en, x, align) => {
        if (two) { T(ar, { x, y: y + 5, align, ...hs }); T(en, { x, y: y - 6, align, ...hs, baseDir: 'ltr' }); }
        else T(lang === 'ar' ? ar : en, { x, y, align, ...hs });
      };
      cell('البيان', 'Description', col.desc, rtl ? 'right' : 'left');
      cell('الكمية', 'Qty', col.qty, numAlign);
      cell('السعر', 'Price', col.price, numAlign);
      cell('خصم %', 'Disc %', col.disc, numAlign);
      cell('ض.ق.م %', 'VAT %', col.vat, numAlign);
      cell('الإجمالي', 'Total', col.total, numAlign);
      y -= two ? 18 : 12;
    };
    head();

    for (const it of items) {
      const descs = [];
      if (lang !== 'en' && it.description_ar) descs.push(it.description_ar);
      if (lang !== 'ar' && it.description_en) descs.push(it.description_en);
      if (!descs.length) descs.push(it.description_ar || it.description_en || '');
      const lines = descs.flatMap(t => wrap(font, 9.5, t, descWidth, /[؀-ۿ]/.test(t) ? 'rtl' : baseDir));
      const need = Math.max(1, lines.length) * 12 + 10;
      if (y - need < 190) { newPage(); head(); }
      y -= 16;
      lines.forEach((ln, i) => T(ln, { x: col.desc, y: y - i * 12, size: 9.5, align: rtl ? 'right' : 'left', baseDir: /[؀-ۿ]/.test(ln) ? 'rtl' : baseDir }));
      T(fmtQty(it.quantity), { x: col.qty, y, size: 9.5, align: numAlign, baseDir: 'ltr' });
      T(fmtMoney(it.unit_price), { x: col.price, y, size: 9.5, align: numAlign, baseDir: 'ltr' });
      T(Number(it.discount_pct) ? fmtQty(it.discount_pct) : '—', { x: col.disc, y, size: 9.5, align: numAlign, baseDir: 'ltr' });
      T(fmtQty(it.vat_rate), { x: col.vat, y, size: 9.5, align: numAlign, baseDir: 'ltr' });
      T(fmtMoney(it.line_total), { x: col.total, y, size: 9.5, align: numAlign, baseDir: 'ltr' });
      y -= Math.max(0, lines.length - 1) * 12 + 6;
      page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.5, color: line });
    }

    // ---- totals
    if (y < 215) newPage();
    y -= 14;
    const cur = inv.currency || 'EGP';
    T(lang === 'ar' ? `جميع المبالغ بـ ${cur === 'EGP' ? 'الجنيه المصري' : cur}` : lang === 'en' ? `All amounts in ${cur}` : `جميع المبالغ بالجنيه المصري (${cur}) / All amounts in ${cur}`,
      { x: start, y, size: 8.5, color: grey, align: dirAlign });
    y -= 18;
    // boxed to the side opposite the description column
    const TW = 280;
    const tx = (rtl ? M : W - M - TW);
    const trow = (label, value, o = {}) => {
      const size = o.size || 10, f = o.bold ? bold : font, c = o.color || ink;
      if (rtl) {
        T(label, { x: tx + TW, y, size, font: f, align: 'right', color: c });
        T(value, { x: tx, y, size, font: f, align: 'left', baseDir: 'ltr', color: c });
      } else {
        T(label, { x: tx, y, size, font: f, align: 'left', color: c });
        T(value, { x: tx + TW, y, size, font: f, align: 'right', baseDir: 'ltr', color: c });
      }
      y -= o.gap || 16;
    };
    const gross = Number(inv.subtotal) + Number(inv.discount_total);
    if (Number(inv.discount_total) > 0) {
      trow(L('الإجمالي قبل الخصم', 'Gross'), fmtMoney(gross));
      trow(L('الخصم', 'Discount'), `(${fmtMoney(inv.discount_total)})`);
    }
    trow(L('المجموع الفرعي', 'Subtotal'), fmtMoney(inv.subtotal));
    trow(L('ضريبة القيمة المضافة', 'VAT'), fmtMoney(inv.vat_amount));
    trow(L('إجمالي الفاتورة', 'Invoice total'), fmtMoney(inv.total), { bold: true });
    if (Number(inv.withholding_amount) > 0) {
      trow(`${L('خصم ضريبة المنبع', 'Withholding tax')} ${fmtQty(inv.withholding_rate)}%`, `(${fmtMoney(inv.withholding_amount)})`);
    }
    y -= 4;
    page.drawRectangle({ x: tx - 8, y: y - 7, width: TW + 16, height: 24, color: rgb(0.99, 0.93, 0.93) });
    trow(L('المستحق على العميل', 'Net payable'), fmtMoney(inv.net_receivable), { bold: true, size: 11.5, color: red, gap: 20 });
    if (Number(inv.amount_paid) > 0) {
      trow(L('المدفوع', 'Paid'), `(${fmtMoney(inv.amount_paid)})`);
      trow(L('المتبقي', 'Balance due'), fmtMoney(inv.balance), { bold: true });
    }

    // ---- notes and bank details
    y -= 14;
    const noteBlock = (title, text) => {
      if (!text) return;
      T(title, { x: start, y, size: 9, font: bold, align: dirAlign, color: grey }); y -= 13;
      for (const ln of String(text).split(/\r?\n/).flatMap(p => wrap(font, 9.5, p, W - 2 * M, baseDir))) {
        if (y < 60) { newPage(); }
        T(ln, { x: start, y, size: 9.5, align: dirAlign, baseDir: /[؀-ۿ]/.test(ln) ? 'rtl' : baseDir }); y -= 12.5;
      }
      y -= 6;
    };
    noteBlock(L('ملاحظات', 'Notes'), inv.notes);
    const terms = Math.max(0, Math.round((new Date(inv.due_date) - new Date(inv.issue_date)) / 86400000));
    noteBlock(L('شروط الدفع', 'Payment terms'), lang === 'en' ? `Payment due within ${terms} days of the issue date.`
      : lang === 'ar' ? `الدفع خلال ${terms} يومًا من تاريخ الإصدار.` : `الدفع خلال ${terms} يومًا من تاريخ الإصدار. Payment due within ${terms} days.`);
    noteBlock(L('بيانات التحويل البنكي', 'Bank details'), st.bank_details);

    // ---- footer + stamps on every page
    pages.forEach((p, i) => {
      page = p;
      T(`${st.company_name_en || ''}${st.phone ? ' · ' + st.phone : ''}${st.email ? ' · ' + st.email : ''}`, { x: W / 2, y: 26, size: 8, color: grey, align: 'center', baseDir: 'ltr' });
      T(`${i + 1} / ${pages.length}`, { x: W - M, y: 26, size: 8, color: grey, align: 'right', baseDir: 'ltr' });
      const stamp = { void: 'VOID', draft: 'DRAFT', paid: 'PAID' }[inv.status];
      if (stamp) {
        p.drawText(stamp, { x: 130, y: 330, size: 90, font: bold, opacity: 0.1, rotate: degrees(35),
          color: inv.status === 'paid' ? rgb(0.1, 0.6, 0.35) : rgb(0.88, 0.11, 0.16) });
      }
    });

    const bytes = await pdf.save();
    return new Blob([bytes], { type: 'application/pdf' });
  },

  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
};
