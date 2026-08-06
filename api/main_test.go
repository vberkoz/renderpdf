package main

import (
	"context"
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
