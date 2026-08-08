package main

import (
	"context"
	"os"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func TestStarterTemplatesAreValidAndDocumented(t *testing.T) {
	starters := starterTemplates()
	if len(starters) != 4 {
		t.Fatalf("starter count = %d, want 4", len(starters))
	}
	for _, starter := range starters {
		t.Run(string(starter.Type), func(t *testing.T) {
			if _, err := html.Parse(strings.NewReader(starter.HTML)); err != nil {
				t.Fatalf("parse HTML: %v", err)
			}
			if !strings.Contains(strings.ToLower(starter.HTML), "<!doctype html>") || len(starter.Variables) == 0 {
				t.Fatalf("starter is missing HTML document structure or variable documentation")
			}
			rendered, err := renderTemplateHTML(starter.HTML, starter.ExampleVariables)
			if err != nil {
				t.Fatalf("render example variables: %v", err)
			}
			if strings.Contains(rendered, "{{") {
				t.Fatalf("rendered HTML still has unresolved placeholders")
			}
		})
	}
}

func TestStarterTemplatesProducePDFsWhenChromeIsAvailable(t *testing.T) {
	if _, err := os.Stat("/opt/google/chrome/chrome"); os.IsNotExist(err) {
		t.Skip("Chrome not available - PDF rendering runs in the Lambda image")
	}
	for _, starter := range starterTemplates() {
		t.Run(string(starter.Type), func(t *testing.T) {
			rendered, err := renderTemplateHTML(starter.HTML, starter.ExampleVariables)
			if err != nil {
				t.Fatalf("resolve starter: %v", err)
			}
			pdf, err := generatePDF(context.Background(), injectPrintCSS(rendered))
			if err != nil {
				t.Fatalf("generate PDF: %v", err)
			}
			if len(pdf) < 5 || string(pdf[:5]) != "%PDF-" {
				t.Fatalf("output is not a readable PDF")
			}
		})
	}
}
