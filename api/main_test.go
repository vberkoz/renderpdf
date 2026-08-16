package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func TestPDFGeneration(t *testing.T) {
	// Skip if Chrome not available (local dev environment)
	if _, err := os.Stat("/opt/google/chrome/chrome"); os.IsNotExist(err) {
		t.Skip("Chrome not available - test only runs in Lambda environment")
	}

	html := `<h1>Test</h1><p>This is a test PDF generation.</p>`

	ctx := context.Background()
	pdfBytes, err := generatePDF(ctx, injectPrintCSS(html))
	if err != nil {
		t.Fatalf("PDF generation failed: %v", err)
	}

	if len(pdfBytes) == 0 {
		t.Fatal("PDF is empty")
	}

	err = os.WriteFile("/tmp/test.pdf", pdfBytes, 0644)
	if err != nil {
		t.Fatalf("Failed to write PDF: %v", err)
	}

	t.Logf("✅ PDF GENERATION TEST PASSED")
	t.Logf("   Size: %d bytes", len(pdfBytes))
	t.Logf("   File: /tmp/test.pdf")
}

func TestRenderDiagnosticsReturnsActionableErrors(t *testing.T) {
	tests := []struct {
		name string
		set  func(*renderDiagnostics)
		code string
	}{
		{"image", func(d *renderDiagnostics) { d.imageFail = true }, "image_loading_failed"},
		{"css", func(d *renderDiagnostics) { d.cssFail = true }, "css_parsing_error"},
		{"javascript", func(d *renderDiagnostics) { d.jsFail = true }, "javascript_exception"},
		{"javascript takes precedence", func(d *renderDiagnostics) { d.imageFail, d.cssFail, d.jsFail = true, true, true }, "javascript_exception"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			diagnostics := newRenderDiagnostics()
			test.set(diagnostics)
			err := diagnostics.error()
			var renderErr *renderError
			if !errors.As(err, &renderErr) || renderErr.Code != test.code {
				t.Fatalf("error = %#v, want code %q", err, test.code)
			}
		})
	}
}

func TestRenderErrorResponseIsSafeAndStructured(t *testing.T) {
	response := renderErrorResponse(&renderError{
		Code:    "navigation_timeout",
		Message: "Navigation timed out while loading the page",
	}, map[string]string{"Content-Type": "application/json"})
	if response.StatusCode != 422 {
		t.Fatalf("status = %d, want 422", response.StatusCode)
	}
	var body map[string]string
	if err := json.Unmarshal([]byte(response.Body), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["code"] != "navigation_timeout" || body["error"] == "" {
		t.Fatalf("body = %#v, want a navigation_timeout code and message", body)
	}

	response = renderErrorResponse(errors.New("internal Chrome URL and stack trace"), map[string]string{"X-Request-Id": "request-123"})
	if response.StatusCode != 500 {
		t.Fatalf("status = %d, want 500", response.StatusCode)
	}
	if err := json.Unmarshal([]byte(response.Body), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["code"] != "rendering_failed" || body["error"] != "PDF rendering failed" || body["requestId"] != "request-123" {
		t.Fatalf("unexpected generic rendering response: %#v", body)
	}
}

func TestErrorResponseUsesStableCodesAndRequestID(t *testing.T) {
	response := errorResponse(429, "Daily trial limit reached", map[string]string{"X-Request-Id": "request-456"})
	if response.StatusCode != 429 {
		t.Fatalf("status = %d, want 429", response.StatusCode)
	}
	var body map[string]string
	if err := json.Unmarshal([]byte(response.Body), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["code"] != "rate_limited" || body["requestId"] != "request-456" {
		t.Fatalf("body = %#v, want stable code and request id", body)
	}
}
