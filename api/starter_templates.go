package main

// StarterTemplate is a bundled document definition customers can copy into
// their own template storage. Variable paths use the same {{path.to.value}}
// contract as every customer-authored template.
type StarterTemplate struct {
	Name             string
	Type             TemplateType
	HTML             string
	Variables        []StarterTemplateVariable
	ExampleVariables map[string]any
}

type StarterTemplateVariable struct {
	Path        string `json:"path"`
	Description string `json:"description"`
}

func starterTemplates() []StarterTemplate {
	return []StarterTemplate{
		{
			Name: "Invoice",
			Type: TemplateTypeInvoice,
			HTML: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice {{invoice.number}}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');body{font-family:"IBM Plex Sans",Arial,sans-serif;font-size:11pt;line-height:1.45;color:#172033;margin:48px}header{display:flex;justify-content:space-between;border-bottom:3px solid #2563eb;padding-bottom:20px}h1{margin:0}.meta{text-align:right;color:#526075}.total{margin-top:32px;text-align:right;font-size:22px;font-weight:bold}.label{color:#526075;font-family:"IBM Plex Mono","Courier New",monospace;font-size:12px;text-transform:uppercase;letter-spacing:.08em}</style>
</head><body><header><div><div class="label">Invoice</div><h1>{{invoice.number}}</h1></div><div class="meta">Issued {{invoice.issueDate}}<br>Due {{invoice.dueDate}}</div></header><main><h2>Bill to</h2><p><strong>{{customer.name}}</strong><br>{{customer.address}}</p><p>{{invoice.description}}</p><p class="total">Total: {{invoice.total}}</p></main></body></html>`,
			Variables: []StarterTemplateVariable{
				{"invoice.number", "Invoice identifier"}, {"invoice.issueDate", "Issue date"}, {"invoice.dueDate", "Payment due date"}, {"invoice.description", "Description of goods or services"}, {"invoice.total", "Formatted amount due"}, {"customer.name", "Customer name"}, {"customer.address", "Customer billing address"},
			},
			ExampleVariables: map[string]any{"invoice": map[string]any{"number": "INV-1042", "issueDate": "August 8, 2026", "dueDate": "August 22, 2026", "description": "Design and implementation services", "total": "$1,250.00"}, "customer": map[string]any{"name": "Ada & Sons", "address": "42 Analytical Engine Way\nLondon"}},
		},
		{
			Name: "Contract",
			Type: TemplateTypeContract,
			HTML: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{contract.title}}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');body{font-family:"IBM Plex Sans",Arial,sans-serif;font-size:11pt;color:#1f2937;line-height:1.45;margin:54px}h1{text-align:center;text-transform:uppercase;letter-spacing:.08em}section{margin:28px 0}.signature{margin-top:80px;display:flex;justify-content:space-between}.line{border-top:1px solid #374151;padding-top:8px;width:42%}</style>
</head><body><h1>{{contract.title}}</h1><p>This agreement is made on {{contract.date}} between <strong>{{party.one.name}}</strong> and <strong>{{party.two.name}}</strong>.</p><section><h2>Scope</h2><p>{{contract.scope}}</p></section><section><h2>Term</h2><p>This agreement begins {{contract.startDate}} and ends {{contract.endDate}}.</p></section><section><h2>Payment</h2><p>{{contract.paymentTerms}}</p></section><div class="signature"><div class="line">{{party.one.name}}</div><div class="line">{{party.two.name}}</div></div></body></html>`,
			Variables: []StarterTemplateVariable{
				{"contract.title", "Contract title"}, {"contract.date", "Agreement date"}, {"contract.scope", "Scope of work"}, {"contract.startDate", "Start date"}, {"contract.endDate", "End date"}, {"contract.paymentTerms", "Payment terms"}, {"party.one.name", "First party legal name"}, {"party.two.name", "Second party legal name"},
			},
			ExampleVariables: map[string]any{"contract": map[string]any{"title": "Professional Services Agreement", "date": "August 8, 2026", "scope": "Provider will design and implement the reporting dashboard.", "startDate": "August 15, 2026", "endDate": "November 15, 2026", "paymentTerms": "$8,000 due within 14 days of each monthly invoice."}, "party": map[string]any{"one": map[string]any{"name": "Acme Studio LLC"}, "two": map[string]any{"name": "Ada & Sons Ltd"}}},
		},
		{
			Name: "Certificate",
			Type: TemplateTypeCertificate,
			HTML: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{certificate.title}}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');body{font-family:"IBM Plex Sans",Arial,sans-serif;font-size:11pt;text-align:center;color:#312e81;margin:38px;border:12px double #a78bfa;padding:62px}h1{font-size:42px;text-transform:uppercase;letter-spacing:.1em;margin:0}.recipient{font-size:34px;margin:35px 0;color:#111827}.detail{font-size:19px;line-height:1.45}.date{margin-top:40px;font-family:"IBM Plex Mono","Courier New",monospace;font-size:15px;color:#4b5563}</style>
</head><body><h1>{{certificate.title}}</h1><p class="detail">This certificate is proudly presented to</p><p class="recipient">{{recipient.name}}</p><p class="detail">for {{certificate.achievement}}</p><p class="date">Awarded on {{certificate.date}}<br>Certificate No. {{certificate.number}}</p></body></html>`,
			Variables: []StarterTemplateVariable{
				{"certificate.title", "Certificate heading"}, {"certificate.achievement", "Achievement being recognized"}, {"certificate.date", "Award date"}, {"certificate.number", "Certificate identifier"}, {"recipient.name", "Recipient name"},
			},
			ExampleVariables: map[string]any{"certificate": map[string]any{"title": "Certificate of Achievement", "achievement": "successfully completing the Advanced Design Systems program", "date": "August 8, 2026", "number": "CERT-2026-008"}, "recipient": map[string]any{"name": "Ada Lovelace"}},
		},
		{
			Name: "Receipt",
			Type: TemplateTypeReceipt,
			HTML: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Receipt {{receipt.number}}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');body{font-family:"IBM Plex Mono","Courier New",monospace;font-size:10pt;line-height:1.45;max-width:520px;margin:42px auto;color:#111827}header{text-align:center;border-bottom:1px dashed #6b7280;padding-bottom:18px}h1{font-family:"IBM Plex Sans",Arial,sans-serif;font-size:24px;margin:0}.row{display:flex;justify-content:space-between;margin:12px 0}.total{border-top:1px dashed #6b7280;margin-top:22px;padding-top:16px;font-size:20px;font-weight:bold}.foot{text-align:center;color:#6b7280;margin-top:30px;font-size:13px}</style>
</head><body><header><h1>{{merchant.name}}</h1><p>{{merchant.address}}</p><p>Receipt {{receipt.number}} · {{receipt.date}}</p></header><main><div class="row"><span>{{receipt.description}}</span><span>{{receipt.amount}}</span></div><div class="row total"><span>Total paid</span><span>{{receipt.total}}</span></div></main><p class="foot">Thank you, {{customer.name}}.</p></body></html>`,
			Variables: []StarterTemplateVariable{
				{"merchant.name", "Merchant name"}, {"merchant.address", "Merchant address"}, {"receipt.number", "Receipt identifier"}, {"receipt.date", "Payment date"}, {"receipt.description", "Purchased item or service"}, {"receipt.amount", "Line-item amount"}, {"receipt.total", "Formatted total paid"}, {"customer.name", "Customer name"},
			},
			ExampleVariables: map[string]any{"merchant": map[string]any{"name": "RenderPDF", "address": "Kyiv, Ukraine"}, "receipt": map[string]any{"number": "RCP-1042", "date": "August 8, 2026", "description": "Professional PDF rendering", "amount": "$49.00", "total": "$49.00"}, "customer": map[string]any{"name": "Ada & Sons"}},
		},
	}
}
