// Sample HTML documents for the landing page interactive playground.
const PLAYGROUND_TEMPLATES = {
  "agreement": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="renderpdf:no-header-footer" content="true">
  <title>Design and Development Services Agreement</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');

    @page { size: A4; margin: 9mm 11mm; }

    :root {
      --ink: #272a2f;
      --muted: #696e74;
      --line: #d6d9dc;
      --accent: #5e6369;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--ink);
      font-family: "IBM Plex Sans", Arial, sans-serif;
      font-size: 9.5pt;
      line-height: 1.3;
    }

    .document {
      width: 180mm;
      margin: 0 auto;
    }

    .topline,
    .signature-row {
      display: flex;
      justify-content: space-between;
    }

    .topline {
      margin-bottom: 5mm;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Courier New", monospace;
      font-size: 7pt;
      letter-spacing: .01em;
    }

    .address,
    .reference { width: 38%; }

    .reference { text-align: right; }

    .brand {
      margin: 0 0 5mm;
      font-size: 16pt;
      font-weight: 700;
      letter-spacing: -1.1px;
    }

    .document-kicker,
    .label {
      display: block;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Courier New", monospace;
      font-size: 7pt;
      font-weight: 700;
      letter-spacing: .1em;
      text-transform: uppercase;
    }

    .document-kicker { margin: 0 0 1.5mm; }

    h1 {
      margin: 0 0 4mm;
      font-size: 18pt;
      letter-spacing: -.75px;
      line-height: 1.08;
    }

    h2 {
      margin: 0 0 1mm;
      font-size: 10pt;
      break-after: avoid;
      page-break-after: avoid;
    }

    .parties {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 7mm;
      margin: 0 0 4mm;
      padding: 2.5mm 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .label { margin-bottom: 1mm; }

    .party-name { font-size: 11pt; font-weight: 700; }

    .meta {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 3mm;
      margin-bottom: 4mm;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .meta-value { font-size: 10pt; font-weight: 600; }

    .intro {
      max-width: 122mm;
      margin: 0 0 3mm;
    }

    .clauses {
      margin: 0;
      padding: 0;
      list-style: none;
      counter-reset: clause;
    }

    .clauses > li {
      display: grid;
      grid-template-columns: 14mm 1fr;
      gap: 5mm;
      padding: 2mm 0;
      border-top: 1px solid var(--line);
      counter-increment: clause;
      break-inside: auto;
      page-break-inside: auto;
    }

    .clauses > li::before {
      padding-top: 1mm;
      color: var(--accent);
      content: "0" counter(clause);
      font-family: "IBM Plex Mono", "Courier New", monospace;
      font-size: 7.5pt;
      font-weight: 700;
      letter-spacing: .08em;
    }

    .clauses p { margin: 0; }

    .scope {
      margin-top: 1.5mm;
      padding: 1.75mm 2.5mm;
      border-left: 2px solid var(--accent);
      background: #f1f2f2;
      white-space: pre-line;
      orphans: 3;
      widows: 3;
    }

    .signatures {
      margin-top: 4mm;
      padding-top: 2.5mm;
      border-top: 1px solid var(--ink);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .signature-row { gap: 9mm; }
    .signature { width: 48%; }
    .signature-line { height: 7mm; margin-bottom: 1mm; border-bottom: 1px solid var(--ink); }
    .signature-name { font-size: 9pt; font-weight: 700; }

    .signature-caption,
    .footer-note {
      color: var(--muted);
      font-family: "IBM Plex Mono", "Courier New", monospace;
      font-size: 7.5pt;
    }

    .footer-note {
      margin: 3mm 0 0;
      font-size: 7pt;
      text-align: right;
    }

    @media screen {
      body { padding: 12.5mm 0; background: #eef1f3; }
      .document { width: 210mm; min-height: 297mm; padding: 9mm 11mm; background: #fff; box-shadow: 0 8px 24px rgba(23, 32, 42, .16); }
    }

    @media print {
      .document {
        display: flex;
        flex-direction: column;
        width: auto;
        min-height: 279mm;
        margin: 0;
      }

      .signatures { margin-top: auto; padding-top: 2.5mm; }
      .signature-line { height: 7mm; margin-bottom: 1mm; }
      .footer-note { margin-top: 3mm; }
    }
  </style>
</head>
<body>
  <main class="document a4-page pin-signatures">
    <header class="topline">
      <div class="address">RenderPDF<br>Document Services<br>Kyiv, Ukraine</div>
      <div class="reference">Agreement date<br>August 9, 2026</div>
    </header>

    <div class="brand">RenderPDF</div>
    <p class="document-kicker">Service agreement</p>
    <h1>Design and Development Services Agreement</h1>

    <section class="parties" aria-label="Agreement parties">
      <div>
        <span class="label">Service provider</span>
        <div class="party-name">RenderPDF Studio LLC</div>
      </div>
      <div>
        <span class="label">Client</span>
        <div class="party-name">Northstar Ventures Ltd.</div>
      </div>
    </section>

    <section class="meta" aria-label="Contract terms">
      <div><span class="label">Effective from</span><div class="meta-value">August 15, 2026</div></div>
      <div><span class="label">Term ends</span><div class="meta-value">November 15, 2026</div></div>
      <div><span class="label">Payment terms</span><div class="meta-value">50% on commencement; 50% on final delivery, due within 14 days</div></div>
    </section>

    <p class="intro">This agreement sets out the terms under which RenderPDF Studio LLC will provide services to Northstar Ventures Ltd. The parties agree to collaborate in good faith throughout the term described below.</p>

    <ol class="clauses">
      <li><div><h2>Scope of services</h2><p>The provider will perform the following agreed scope of work:</p><div class="scope">Brand identity refinement
Responsive marketing website design and development
Content-management handover and launch support</div></div></li>
      <li><div><h2>Term and delivery</h2><p>Services begin on August 15, 2026 and conclude on November 15, 2026, unless the parties agree in writing to change the schedule or scope.</p></div></li>
      <li><div><h2>Fees and payment</h2><p>Northstar Ventures Ltd. will pay invoices in accordance with 50% on commencement; 50% on final delivery, due within 14 days. Any change to fees or deliverables requires written approval from both parties.</p></div></li>
      <li><div><h2>Confidentiality</h2><p>Each party will protect the other party’s non-public information and use it solely to perform this agreement, except where disclosure is required by law.</p></div></li>
      <li><div><h2>Acceptance</h2><p>By signing below, each party confirms it has authority to enter into this agreement and accepts the terms set out in this document.</p></div></li>
    </ol>

    <section class="signatures" aria-label="Signatures">
      <span class="label">Accepted and agreed</span>
      <div class="signature-row">
        <div class="signature"><div class="signature-line"></div><div class="signature-name">RenderPDF Studio LLC</div><div class="signature-caption">Authorized representative / Date</div></div>
        <div class="signature"><div class="signature-line"></div><div class="signature-name">Northstar Ventures Ltd.</div><div class="signature-caption">Authorized representative / Date</div></div>
      </div>
      <p class="footer-note">RenderPDF · Design and Development Services Agreement · August 9, 2026</p>
    </section>
  </main>
</body>
</html>`,
  "invoice": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="renderpdf:no-header-footer" content="true">
  <title>Invoice INV-2048</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
    @page { size: A4; margin: 12mm 14mm; }
    :root {
      --ink: #1e293b;
      --muted: #64748b;
      --line: #e2e8f0;
      --accent: #0284c7;
      --badge-bg: #e0f2fe;
      --badge-text: #0369a1;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 9.5pt;
      line-height: 1.4;
      background: #fff;
    }
    .invoice-container {
      width: 182mm;
      margin: 0 auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 7mm;
      border-bottom: 2px solid var(--line);
    }
    .brand-title {
      font-size: 18pt;
      font-weight: 700;
      letter-spacing: -.5px;
      color: var(--ink);
    }
    .brand-sub {
      font-size: 8pt;
      color: var(--muted);
      margin-top: 1mm;
    }
    .invoice-badge {
      display: inline-block;
      padding: 1.5mm 3.5mm;
      border-radius: 4px;
      background: var(--badge-bg);
      color: var(--badge-text);
      font-family: "IBM Plex Mono", monospace;
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: .05em;
      text-transform: uppercase;
    }
    .invoice-id {
      margin-top: 2mm;
      font-size: 14pt;
      font-weight: 700;
      font-family: "IBM Plex Mono", monospace;
      text-align: right;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 5mm;
      margin: 6mm 0;
      padding: 3mm 4mm;
      background: #f8fafc;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    .meta-item .label {
      font-family: "IBM Plex Mono", monospace;
      font-size: 7pt;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 1mm;
    }
    .meta-item .val {
      font-size: 9pt;
      font-weight: 600;
    }
    .parties-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10mm;
      margin: 6mm 0 8mm;
    }
    .party-title {
      font-family: "IBM Plex Mono", monospace;
      font-size: 7pt;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .08em;
      margin-bottom: 2mm;
    }
    .party-name { font-size: 11pt; font-weight: 700; margin-bottom: 1.5mm; }
    .party-address { color: var(--muted); font-size: 9pt; line-height: 1.45; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 5mm 0;
    }
    th {
      font-family: "IBM Plex Mono", monospace;
      font-size: 7pt;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--muted);
      border-bottom: 1px solid var(--line);
      padding: 3mm 2mm;
      text-align: left;
    }
    th.right, td.right { text-align: right; }
    td {
      padding: 3.5mm 2mm;
      border-bottom: 1px solid var(--line);
      font-size: 9pt;
    }
    td.item-desc strong { display: block; font-weight: 600; }
    td.item-desc span { color: var(--muted); font-size: 8pt; }
    .totals-area {
      display: flex;
      justify-content: flex-end;
      margin-top: 4mm;
    }
    .totals-table {
      width: 72mm;
    }
    .totals-table div {
      display: flex;
      justify-content: space-between;
      padding: 1.5mm 0;
      font-size: 9pt;
    }
    .totals-table .total-due {
      border-top: 2px solid var(--ink);
      margin-top: 2mm;
      padding-top: 2.5mm;
      font-size: 12pt;
      font-weight: 700;
      color: var(--ink);
    }
    .footer {
      margin-top: 10mm;
      padding-top: 5mm;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 8pt;
      display: flex;
      justify-content: space-between;
    }
    @media screen {
      body { padding: 12mm 0; background: #f1f5f9; }
      .invoice-container { background: #fff; padding: 12mm; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    }
  </style>
</head>
<body>
  <main class="invoice-container">
    <header class="header">
      <div>
        <div class="brand-title">RenderPDF Studio LLC</div>
        <div class="brand-sub">131 Continental Dr, Suite 305 · Newark, DE 19713 · billing@renderpdf.vberkoz.com</div>
      </div>
      <div>
        <div style="text-align: right;"><span class="invoice-badge">Invoice</span></div>
        <div class="invoice-id">#INV-2048</div>
      </div>
    </header>

    <section class="meta-grid" aria-label="Invoice metadata">
      <div class="meta-item"><div class="label">Issue Date</div><div class="val">September 21, 2026</div></div>
      <div class="meta-item"><div class="label">Due Date</div><div class="val">October 5, 2026</div></div>
      <div class="meta-item"><div class="label">PO Number</div><div class="val">PO-94107</div></div>
      <div class="meta-item"><div class="label">Payment Terms</div><div class="val">Net 14 Days</div></div>
    </section>

    <section class="parties-grid">
      <div>
        <div class="party-title">Billed To</div>
        <div class="party-name">Acme Corporation</div>
        <div class="party-address">
          Attn: Accounting &amp; Finance<br>
          500 Tech Parkway, Suite 400<br>
          San Francisco, CA 94107<br>
          accounting@acmecorp.com
        </div>
      </div>
      <div>
        <div class="party-title">Payable To</div>
        <div class="party-name">RenderPDF Studio LLC</div>
        <div class="party-address">
          Bank: Silicon Valley Bank<br>
          Routing (ABA): 121140399<br>
          Account: 9402-8810-24<br>
          SWIFT: SVBKUS6S
        </div>
      </div>
    </section>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="right">Qty</th>
          <th class="right">Unit Price</th>
          <th class="right">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="item-desc"><strong>RenderPDF Pro Tier Subscription</strong><span>20,000 PDFs/month, priority Chromium workers, webhook delivery</span></td>
          <td class="right">1</td>
          <td class="right">$49.00</td>
          <td class="right">$49.00</td>
        </tr>
        <tr>
          <td class="item-desc"><strong>Dedicated Outbound IP Allocation</strong><span>Static IP address for enterprise intranet firewall allowlists</span></td>
          <td class="right">1</td>
          <td class="right">$25.00</td>
          <td class="right">$25.00</td>
        </tr>
        <tr>
          <td class="item-desc"><strong>On-Demand Overage Top-up Pack</strong><span>2 packs × 1,000 high-speed PDF renders with no expiration</span></td>
          <td class="right">2</td>
          <td class="right">$5.00</td>
          <td class="right">$10.00</td>
        </tr>
      </tbody>
    </table>

    <div class="totals-area">
      <div class="totals-table">
        <div><span>Subtotal</span><span>$84.00</span></div>
        <div><span>Sales Tax (0.00%)</span><span>$0.00</span></div>
        <div class="total-due"><span>Total Due</span><span>$84.00 USD</span></div>
      </div>
    </div>

    <footer class="footer">
      <div>Thank you for your business. Please remit payment via ACH or wire within 14 days.</div>
      <div style="font-family: 'IBM Plex Mono', monospace;">Page 1 of 1</div>
    </footer>
  </main>
</body>
</html>`,
  "receipt": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="renderpdf:no-header-footer" content="true">
  <title>Payment Receipt RCP-8831</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
    @page { size: A4; margin: 15mm 20mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #17202a;
      font-family: "IBM Plex Mono", "Courier New", monospace;
      font-size: 9.5pt;
      line-height: 1.45;
      background: #fff;
    }
    .receipt-wrap {
      max-width: 140mm;
      margin: 0 auto;
      padding: 8mm 10mm;
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
    }
    .header {
      text-align: center;
      padding-bottom: 5mm;
      border-bottom: 1px dashed #94a3b8;
    }
    .brand {
      font-family: "IBM Plex Sans", sans-serif;
      font-size: 16pt;
      font-weight: 700;
      letter-spacing: -.5px;
      margin: 0 0 1mm;
    }
    .merchant-info {
      color: #64748b;
      font-size: 8pt;
      line-height: 1.35;
    }
    .receipt-title {
      margin-top: 3mm;
      font-size: 11pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .meta-rows {
      margin: 5mm 0;
      padding-bottom: 4mm;
      border-bottom: 1px dashed #94a3b8;
      font-size: 8.5pt;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 1.5mm;
    }
    .meta-label { color: #64748b; }
    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin: 4mm 0;
    }
    .items-table th {
      text-align: left;
      font-size: 8pt;
      color: #64748b;
      padding-bottom: 2mm;
      border-bottom: 1px solid #e2e8f0;
    }
    .items-table td {
      padding: 2.5mm 0;
      font-size: 9pt;
      border-bottom: 1px solid #f1f5f9;
    }
    .text-right { text-align: right; }
    .totals {
      margin-top: 4mm;
      padding-top: 3mm;
      border-top: 1px dashed #94a3b8;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      padding: 1.5mm 0;
      font-size: 9pt;
    }
    .grand-total {
      font-size: 13pt;
      font-weight: 700;
      border-top: 1px solid #17202a;
      margin-top: 2mm;
      padding-top: 2mm;
    }
    .payment-badge {
      display: inline-block;
      margin-top: 4mm;
      padding: 1.5mm 3mm;
      border-radius: 4px;
      background: #dcfce7;
      color: #166534;
      font-size: 8pt;
      font-weight: 700;
      text-align: center;
      width: 100%;
    }
    .footer {
      margin-top: 6mm;
      padding-top: 4mm;
      border-top: 1px dashed #94a3b8;
      text-align: center;
      color: #64748b;
      font-size: 7.5pt;
      line-height: 1.4;
    }
    .barcode {
      margin: 4mm auto 1mm;
      letter-spacing: 4px;
      font-size: 14pt;
      color: #17202a;
    }
    @media screen {
      body { padding: 12mm 0; background: #f8fafc; }
      .receipt-wrap { background: #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
    }
  </style>
</head>
<body>
  <div class="receipt-wrap">
    <header class="header">
      <h1 class="brand">RenderPDF Studio</h1>
      <div class="merchant-info">
        131 Continental Dr, Suite 305 · Newark, DE 19713<br>
        Merchant ID: RPDF-STRIPE-40291
      </div>
      <div class="receipt-title">Payment Receipt</div>
    </header>

    <div class="meta-rows">
      <div class="meta-row"><span class="meta-label">Receipt Number:</span><span>RCP-8831-2026</span></div>
      <div class="meta-row"><span class="meta-label">Date &amp; Time:</span><span>Sep 21, 2026 · 10:42 UTC</span></div>
      <div class="meta-row"><span class="meta-label">Customer Name:</span><span>Ada Lovelace</span></div>
      <div class="meta-row"><span class="meta-label">Payment Method:</span><span>Visa •••• 4242</span></div>
      <div class="meta-row"><span class="meta-label">Transaction ID:</span><span>tx_3N4yG82eZvKYlo2C</span></div>
    </div>

    <table class="items-table">
      <thead>
        <tr>
          <th>Description</th>
          <th class="text-right">Qty</th>
          <th class="text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>RenderPDF Starter Tier (Monthly)</td>
          <td class="text-right">1</td>
          <td class="text-right">$19.00</td>
        </tr>
        <tr>
          <td>Additional PDF Quota Pack (1,000)</td>
          <td class="text-right">1</td>
          <td class="text-right">$5.00</td>
        </tr>
      </tbody>
    </table>

    <div class="totals">
      <div class="total-row"><span>Subtotal</span><span>$24.00</span></div>
      <div class="total-row"><span>Tax (0%)</span><span>$0.00</span></div>
      <div class="total-row grand-total"><span>Total Paid</span><span>$24.00 USD</span></div>
    </div>

    <div class="payment-badge">✓ PAYMENT SUCCESSFUL · APPROVED</div>

    <footer class="footer">
      <div class="barcode">||| | ||||| ||| |||| || ||| ||||</div>
      <div>Auth Code: 893102 · Ref: 9401827410</div>
      <div>Payments securely processed via Paddle. Questions? support@renderpdf.vberkoz.com</div>
    </footer>
  </div>
</body>
</html>`,
  "boarding-pass": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="renderpdf:no-header-footer" content="true">
  <title>Boarding Pass - Flight SK-420</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
    @page { size: A4 landscape; margin: 15mm 15mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #0f172a;
      font-family: "IBM Plex Sans", sans-serif;
      font-size: 9.5pt;
      line-height: 1.35;
      background: #fff;
    }
    .pass-container {
      max-width: 250mm;
      margin: 10mm auto;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      overflow: hidden;
      display: grid;
      grid-template-columns: 2.3fr 1fr;
      box-shadow: 0 4px 16px rgba(0,0,0,0.06);
    }
    .main-ticket {
      padding: 8mm 10mm;
      background: #ffffff;
    }
    .stub-ticket {
      padding: 8mm 8mm;
      background: #f8fafc;
      border-left: 2px dashed #94a3b8;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .pass-topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 5mm;
      border-bottom: 2px solid #0284c7;
    }
    .airline-brand {
      display: flex;
      align-items: center;
      gap: 3mm;
      font-size: 16pt;
      font-weight: 800;
      letter-spacing: -.5px;
      color: #0284c7;
    }
    .flight-badge {
      font-family: "IBM Plex Mono", monospace;
      font-size: 9pt;
      font-weight: 700;
      background: #0284c7;
      color: #fff;
      padding: 1.5mm 3.5mm;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .route-display {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 6mm 0;
    }
    .city-block .code {
      font-size: 26pt;
      font-weight: 800;
      line-height: 1;
      letter-spacing: -.5px;
    }
    .city-block .name {
      font-size: 8.5pt;
      color: #64748b;
      margin-top: 1mm;
    }
    .flight-arrow {
      font-size: 18pt;
      color: #94a3b8;
      padding: 0 5mm;
    }
    .flight-details-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4mm;
      padding: 4mm 0;
      border-top: 1px solid #e2e8f0;
      border-bottom: 1px solid #e2e8f0;
    }
    .detail-item .label {
      font-family: "IBM Plex Mono", monospace;
      font-size: 7pt;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 1mm;
    }
    .detail-item .value {
      font-size: 11pt;
      font-weight: 700;
    }
    .detail-item .value.accent {
      color: #0284c7;
    }
    .barcode-section {
      margin-top: 5mm;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .barcode-graphic {
      font-family: "IBM Plex Mono", monospace;
      font-size: 20pt;
      letter-spacing: 3px;
      color: #1e293b;
    }
    .pass-note {
      font-size: 7.5pt;
      color: #64748b;
      max-width: 90mm;
    }
    .stub-header {
      font-family: "IBM Plex Mono", monospace;
      font-size: 7.5pt;
      color: #64748b;
      text-transform: uppercase;
      padding-bottom: 3mm;
      border-bottom: 1px solid #e2e8f0;
    }
    .stub-route {
      margin: 4mm 0;
      font-size: 14pt;
      font-weight: 700;
    }
    .stub-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 3mm;
      margin: 4mm 0;
    }
    .stub-grid .label {
      font-family: "IBM Plex Mono", monospace;
      font-size: 6.5pt;
      color: #64748b;
      text-transform: uppercase;
    }
    .stub-grid .val {
      font-size: 10pt;
      font-weight: 700;
    }
    .stub-barcode {
      font-family: "IBM Plex Mono", monospace;
      font-size: 14pt;
      letter-spacing: 2px;
      text-align: center;
      margin-top: 4mm;
    }
    @media screen {
      body { padding: 12mm 0; background: #e2e8f0; }
      .pass-container { background: #fff; }
    }
  </style>
</head>
<body>
  <div class="pass-container">
    <div class="main-ticket">
      <header class="pass-topbar">
        <div class="airline-brand">✈ SKYWAYS AIR</div>
        <div class="flight-badge">Boarding Pass · First / Business</div>
      </header>

      <div class="route-display">
        <div class="city-block">
          <div class="code">SFO</div>
          <div class="name">San Francisco Intl</div>
        </div>
        <div class="flight-arrow">✈ ➔ ➔</div>
        <div class="city-block" style="text-align: right;">
          <div class="code">LHR</div>
          <div class="name">London Heathrow</div>
        </div>
      </div>

      <div class="flight-details-grid">
        <div class="detail-item"><div class="label">Passenger</div><div class="value">LOVELACE / ADA</div></div>
        <div class="detail-item"><div class="label">Flight</div><div class="value accent">SK-420</div></div>
        <div class="detail-item"><div class="label">Gate</div><div class="value accent">B14</div></div>
        <div class="detail-item"><div class="label">Seat</div><div class="value accent">04A</div></div>
        <div class="detail-item"><div class="label">Date</div><div class="value">21 SEP 2026</div></div>
        <div class="detail-item"><div class="label">Boarding Time</div><div class="value">14:15</div></div>
        <div class="detail-item"><div class="label">Departure</div><div class="value">14:55</div></div>
        <div class="detail-item"><div class="label">Group / Class</div><div class="value">GROUP 1 / J</div></div>
      </div>

      <div class="barcode-section">
        <div class="barcode-graphic">||||| |||| || |||||| ||||| |||| |||</div>
        <div class="pass-note">Gate closes 15 minutes before departure. Priority security access included. Electronic ticket verified.</div>
      </div>
    </div>

    <div class="stub-ticket">
      <div>
        <div class="stub-header">Passenger Receipt Stub</div>
        <div class="stub-route">SFO ➔ LHR</div>
        <div class="stub-grid">
          <div><div class="label">Passenger</div><div class="val">A. LOVELACE</div></div>
          <div><div class="label">Flight</div><div class="val">SK-420</div></div>
          <div><div class="label">Date</div><div class="val">21 SEP</div></div>
          <div><div class="label">Seat</div><div class="val">04A</div></div>
          <div><div class="label">Gate</div><div class="val">B14</div></div>
          <div><div class="label">Class</div><div class="val">Business (J)</div></div>
        </div>
      </div>
      <div>
        <div class="stub-barcode">|||| |||||| ||||| ||||</div>
        <div style="font-family: 'IBM Plex Mono', monospace; font-size: 6.5pt; text-align: center; color: #64748b; margin-top: 1mm;">ETKT: 074 2490184910</div>
      </div>
    </div>
  </div>
</body>
</html>`,
  "certificate": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="renderpdf:no-header-footer" content="true">
  <title>Certificate of Achievement</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
    @page { size: A4 landscape; margin: 12mm 12mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #1e1b4b;
      font-family: "IBM Plex Sans", sans-serif;
      line-height: 1.4;
      background: #fff;
    }
    .cert-frame {
      max-width: 260mm;
      margin: 0 auto;
      border: 6px double #6366f1;
      padding: 12mm 18mm;
      position: relative;
      text-align: center;
      background: linear-gradient(135deg, #ffffff 0%, #fdfdff 100%);
    }
    .cert-frame::before {
      content: "";
      position: absolute;
      top: 3mm; left: 3mm; right: 3mm; bottom: 3mm;
      border: 1px solid #c7d2fe;
      pointer-events: none;
    }
    .brand-mark {
      font-family: "IBM Plex Mono", monospace;
      font-size: 9pt;
      font-weight: 700;
      letter-spacing: .25em;
      text-transform: uppercase;
      color: #4f46e5;
      margin-bottom: 4mm;
    }
    h1 {
      font-size: 32pt;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin: 0 0 2mm;
      color: #312e81;
    }
    .cert-sub {
      font-size: 11pt;
      color: #64748b;
      font-style: italic;
      margin-bottom: 6mm;
    }
    .recipient-name {
      font-size: 26pt;
      font-weight: 700;
      color: #1e1b4b;
      padding: 2mm 0;
      border-bottom: 2px solid #818cf8;
      display: inline-block;
      min-width: 140mm;
      margin-bottom: 5mm;
    }
    .cert-desc {
      font-size: 11.5pt;
      color: #334155;
      max-width: 180mm;
      margin: 0 auto 8mm;
      line-height: 1.6;
    }
    .cert-course {
      font-weight: 700;
      color: #4338ca;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      margin-top: 10mm;
      padding: 0 10mm;
    }
    .signature-block {
      text-align: center;
      width: 55mm;
    }
    .sig-line {
      border-bottom: 1px solid #334155;
      height: 10mm;
      margin-bottom: 2mm;
    }
    .sig-name {
      font-size: 9.5pt;
      font-weight: 700;
    }
    .sig-title {
      font-size: 7.5pt;
      color: #64748b;
      font-family: "IBM Plex Mono", monospace;
      text-transform: uppercase;
    }
    .seal-badge {
      width: 24mm;
      height: 24mm;
      border-radius: 50%;
      border: 3px dashed #6366f1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: "IBM Plex Mono", monospace;
      font-size: 6.5pt;
      font-weight: 700;
      color: #4338ca;
      letter-spacing: .05em;
      text-transform: uppercase;
    }
    .cert-footer {
      margin-top: 6mm;
      font-family: "IBM Plex Mono", monospace;
      font-size: 7pt;
      color: #94a3b8;
    }
    @media screen {
      body { padding: 10mm 0; background: #f1f5f9; }
      .cert-frame { background: #fff; box-shadow: 0 8px 30px rgba(79, 70, 229, 0.1); }
    }
  </style>
</head>
<body>
  <div class="cert-frame">
    <div class="brand-mark">RenderPDF Academy · Verification of Excellence</div>
    <h1>Certificate of Achievement</h1>
    <div class="cert-sub">This distinction is proudly conferred upon</div>
    <div class="recipient-name">Alan Turing</div>
    <div class="cert-desc">
      for successfully completing the rigorous curriculum and practical examination in<br>
      <span class="cert-course">High-Throughput Serverless PDF Architecture &amp; Chromium Systems</span><br>
      demonstrating outstanding proficiency in scalable document automation.
    </div>

    <div class="meta-row">
      <div class="signature-block">
        <div class="sig-line"></div>
        <div class="sig-name">Dr. Margaret Hamilton</div>
        <div class="sig-title">Director of Engineering</div>
      </div>
      <div class="seal-badge">
        <span>★ SEAL ★</span>
        <span>OFFICIAL</span>
        <span>2026</span>
      </div>
      <div class="signature-block">
        <div class="sig-line"></div>
        <div class="sig-name">Ada Lovelace</div>
        <div class="sig-title">Chief Systems Architect</div>
      </div>
    </div>

    <div class="cert-footer">
      Certificate ID: RPDF-2026-9842 · Issued: September 21, 2026 · Verify at: renderpdf.vberkoz.com/verify
    </div>
  </div>
</body>
</html>`,
};

if (typeof window !== 'undefined') {
  window.PLAYGROUND_TEMPLATES = PLAYGROUND_TEMPLATES;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PLAYGROUND_TEMPLATES };
}
