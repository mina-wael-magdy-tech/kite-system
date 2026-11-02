# PULSE STUDIO OS — Google Sites Embedding Guide

## 1. Overview
The agency utilizes **Google Sites** as its internal company intranet / portal, while **PULSE STUDIO OS** is hosted on a separate production web server (e.g. Hostinger) and embedded seamlessly into Google Sites via an `iframe`.

> [!NOTE]
> Google Sites is solely the portal frame — all authentication, PostgreSQL records, real-time messaging, and permissions run through Supabase on the standalone application instance.

---

> [!WARNING]
> **Sign-in inside an iframe can fail.** Modern browsers (Safari, Chrome with third-party-storage blocking) may refuse to persist the Supabase session for a framed site. Always offer the full-screen link (section 4) and test embedded login on Safari and Chrome before announcing it. Only the origins listed in `frame-ancestors` can embed the app; keep that list minimal.

## 2. Server-Side Security Configuration (Essential)
By default, many web hosts send an `X-Frame-Options: SAMEORIGIN` or `X-Frame-Options: DENY` header which prevents Google Sites from embedding the site. 

To allow secure embedding within Google Sites, your web host must configure the modern **Content-Security-Policy `frame-ancestors`** directive.

### 2.1 Hostinger / Apache (`.htaccess`)
The provided `.htaccess` already sends a CSP with `frame-ancestors 'self' https://sites.google.com`. If you edit it, keep the whole policy (script/connect restrictions) and only change `frame-ancestors`. Do not replace it with the shorter snippet below, which would drop those protections:

```apache
# Allow Google Sites embedding while protecting against malicious framing
Header set Content-Security-Policy "frame-ancestors 'self' https://sites.google.com https://*.google.com;"

# Remove legacy blocking header
Header unset X-Frame-Options
```

### 2.2 Nginx Server Block (if using VPS)
```nginx
# Allow embedding from Google Sites
add_header Content-Security-Policy "frame-ancestors 'self' https://sites.google.com https://*.google.com;";
```

---

## 3. Embedding into Google Sites (Step-by-Step)

### Step 3.1: Copy Your Standalone Application URL
Ensure your standalone application is live and accessible over HTTPS:
```text
https://os.pulsestudio.agency/index.html
```
*(Or your temporary testing domain / Hostinger URL).*

### Step 3.2: Open Google Sites Editor
1. Open [Google Sites](https://sites.google.com) and navigate to your Agency Company Portal page (e.g., "Operations Hub" or "Studio OS").
2. In the right-hand panel, select the **Insert** tab.
3. Click on the **Embed** tool (`<> Embed`).

### Step 3.3: Embed by URL
1. In the modal, choose **By URL**.
2. Paste your standalone application URL: `https://your-domain.com/index.html`.
3. Google Sites will show a preview of PULSE STUDIO OS. Select **Whole page** and click **Insert**.

### Step 3.4: Adjust Frame Dimensions
1. Drag the corner handles of the embedded block to expand it across the full width of the portal layout.
2. Drag the bottom handle downward to set a tall viewport height (minimum **850px** or **1000px** recommended) so staff can scroll the Kanban board and deliverables comfortably.
3. Click **Publish** in Google Sites.

---

## 4. Standalone Access Link
Always provide staff with a fallback link directly to the standalone URL (`https://your-domain.com/login.html`) directly in the header or navigation bar of your Google Sites portal:
> **"Open PULSE STUDIO OS in Fullscreen Window ↗"**

This gives power users and project managers the flexibility to work in a dedicated browser tab while keeping the portal unified for daily check-ins.
