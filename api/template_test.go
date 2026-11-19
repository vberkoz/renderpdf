package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestRenderTemplateHTMLInterpolatesNestedVariables(t *testing.T) {
	html, err := renderTemplateHTML(`<h1>Invoice {{invoice.number}}</h1><p>{{customer.name}}</p>`, map[string]any{
		"invoice":  map[string]any{"number": "INV-1042"},
		"customer": map[string]any{"name": "Ada & Sons"},
	})
	if err != nil {
		t.Fatalf("render template: %v", err)
	}
	if want := `<h1>Invoice INV-1042</h1><p>Ada &amp; Sons</p>`; html != want {
		t.Fatalf("HTML = %q, want %q", html, want)
	}
}

func TestRenderTemplateHTMLRejectsMissingAndUnknownVariables(t *testing.T) {
	tests := []struct {
		name      string
		template  string
		variables map[string]any
		code      string
	}{
		{"missing", `<p>{{customer.name}}</p>`, map[string]any{"customer": map[string]any{}}, missingTemplateVariableCode},
		{"unknown", `<p>{{customer.name}}</p>`, map[string]any{"customer": map[string]any{"name": "Ada", "email": "ada@example.com"}}, unknownTemplateVariableCode},
		{"invalid placeholder", `<p>{{customer-name}}</p>`, map[string]any{}, invalidTemplateVariableCode},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := renderTemplateHTML(test.template, test.variables)
			var renderErr *renderError
			if !errors.As(err, &renderErr) {
				t.Fatalf("error = %v, want renderError", err)
			}
			if renderErr.Status != 422 || renderErr.Code != test.code {
				t.Fatalf("error = %#v, want status 422 and code %q", renderErr, test.code)
			}
		})
	}
}

func TestTemplateVariablePaths(t *testing.T) {
	got := templateVariablePaths(`{{customer.name}} {{invoice.number}} {{customer.name}}`)
	want := []string{"customer.name", "invoice.number"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("paths = %#v, want %#v", got, want)
	}
}

func TestRenderTemplateBarcodeHelper(t *testing.T) {
	// 1. Basic {{barcode '128' trackingId}}
	tmpl := `<div class="box">{{barcode '128' trackingId}}</div>`
	html, err := renderTemplateHTML(tmpl, map[string]any{
		"trackingId": "TRK-987654",
	})
	if err != nil {
		t.Fatalf("render barcode helper failed: %v", err)
	}
	if !strings.Contains(html, "<svg") || !strings.Contains(html, "</svg>") {
		t.Fatalf("expected inline SVG in output, got: %s", html)
	}
	if !strings.Contains(html, "TRK-987654") {
		t.Fatalf("expected text label for barcode value in SVG")
	}

	// 2. Barcode helper with options: width, height, text=false, color
	tmplOpts := `<div>{{barcode '128' trackingId width="240px" height="60px" text=false color="#1e3a8a"}}</div>`
	htmlOpts, err := renderTemplateHTML(tmplOpts, map[string]any{
		"trackingId": "TRK-987654",
	})
	if err != nil {
		t.Fatalf("render barcode helper with options failed: %v", err)
	}
	if !strings.Contains(htmlOpts, `width="240px"`) || !strings.Contains(htmlOpts, `height="60px"`) {
		t.Fatalf("expected width 240px and height 60px in SVG, got: %s", htmlOpts)
	}
	if !strings.Contains(htmlOpts, `fill="#1e3a8a"`) {
		t.Fatalf("expected custom color in SVG")
	}

	// 3. Positional args: {{barcode 'code39' code "180px" "40px"}}
	tmplPos := `<div>{{barcode 'code39' code "180px" "40px"}}</div>`
	htmlPos, err := renderTemplateHTML(tmplPos, map[string]any{
		"code": "XYZ123",
	})
	if err != nil {
		t.Fatalf("render barcode positional failed: %v", err)
	}
	if !strings.Contains(htmlPos, `width="180px"`) {
		t.Fatalf("expected width 180px, got: %s", htmlPos)
	}
}

func TestRenderTemplateQRCodeHelper(t *testing.T) {
	// 1. Basic {{qrcode url}}
	tmpl := `<div class="qr">{{qrcode paymentUrl}}</div>`
	html, err := renderTemplateHTML(tmpl, map[string]any{
		"paymentUrl": "https://renderpdf.vberkoz.com/pay/100",
	})
	if err != nil {
		t.Fatalf("render qrcode helper failed: %v", err)
	}
	if !strings.Contains(html, "<svg") || !strings.Contains(html, `shape-rendering="crispEdges"`) {
		t.Fatalf("expected QR SVG with crispEdges, got: %s", html)
	}

	// 2. QRCode helper with options: size, level, color, background
	tmplOpts := `<div>{{qrcode paymentUrl size="160px" level="H" color="#047857" background="#ecfdf5"}}</div>`
	htmlOpts, err := renderTemplateHTML(tmplOpts, map[string]any{
		"paymentUrl": "https://renderpdf.vberkoz.com/pay/100",
	})
	if err != nil {
		t.Fatalf("render qrcode helper with options failed: %v", err)
	}
	if !strings.Contains(htmlOpts, `width="160px"`) || !strings.Contains(htmlOpts, `height="160px"`) {
		t.Fatalf("expected 160px width and height, got: %s", htmlOpts)
	}
	if !strings.Contains(htmlOpts, `fill="#047857"`) || !strings.Contains(htmlOpts, `fill="#ecfdf5"`) {
		t.Fatalf("expected custom fg and bg colors in QR SVG, got: %s", htmlOpts)
	}
}

func TestRenderTemplateMixedHelpersAndVariables(t *testing.T) {
	tmpl := `
	<h1>Order #{{order.id}}</h1>
	<p>Customer: {{customer.name}}</p>
	<div class="tracking">
		{{barcode '128' order.trackingNumber width="200px" height="50px"}}
	</div>
	<div class="qr">
		{{qrcode order.paymentLink size="120px" level="M"}}
	</div>`

	html, err := renderTemplateHTML(tmpl, map[string]any{
		"order": map[string]any{
			"id":             "ORD-5541",
			"trackingNumber": "TRK-2026-X",
			"paymentLink":    "https://pay.example.com/ord-5541",
		},
		"customer": map[string]any{
			"name": "Jane Doe",
		},
	})
	if err != nil {
		t.Fatalf("mixed template render failed: %v", err)
	}

	if !strings.Contains(html, "Order #ORD-5541") {
		t.Errorf("expected interpolated order ID")
	}
	if !strings.Contains(html, "Customer: Jane Doe") {
		t.Errorf("expected interpolated customer name")
	}
	if strings.Count(html, "<svg") != 2 {
		t.Errorf("expected 2 SVGs rendered (barcode + QR), got count %d", strings.Count(html, "<svg"))
	}
}

func TestRenderTemplateHelperValidation(t *testing.T) {
	// Missing variable used in barcode helper
	tmplMissing := `<div>{{barcode '128' missingTrackingId}}</div>`
	_, err := renderTemplateHTML(tmplMissing, map[string]any{})
	var renderErr *renderError
	if !errors.As(err, &renderErr) || renderErr.Code != missingTemplateVariableCode {
		t.Fatalf("expected missingTemplateVariableCode, got: %v", err)
	}

	// Unknown variable when barcode helper consumes its variable
	tmplUnknown := `<div>{{barcode '128' trackingId}}</div>`
	_, err = renderTemplateHTML(tmplUnknown, map[string]any{
		"trackingId": "TRK-123",
		"unusedVar":   "extra",
	})
	if !errors.As(err, &renderErr) || renderErr.Code != unknownTemplateVariableCode {
		t.Fatalf("expected unknownTemplateVariableCode, got: %v", err)
	}

	// Helper literal only (no variables needed)
	tmplLiteral := `<div>{{barcode '128' 'STATIC-CODE'}}</div>`
	html, err := renderTemplateHTML(tmplLiteral, map[string]any{})
	if err != nil {
		t.Fatalf("expected success with literal barcode args, got error: %v", err)
	}
	if !strings.Contains(html, "<svg") {
		t.Fatalf("expected SVG for literal barcode")
	}
}

func TestTemplateVariablePathsWithHelpers(t *testing.T) {
	tmpl := `
		<h1>{{customer.name}}</h1>
		<div>{{barcode '128' order.tracking}}</div>
		<div>{{barcode '39' 'LITERAL_NOT_A_VAR'}}</div>
		<div>{{qrcode payment.url size="100px"}}</div>
	`
	got := templateVariablePaths(tmpl)
	want := []string{"customer.name", "order.tracking", "payment.url"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("templateVariablePaths = %#v, want %#v", got, want)
	}
}
