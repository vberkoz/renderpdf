package main

import (
	"strings"
	"testing"
)

func TestRenderMarkdownToHTMLUsesDocumentCommonMarkProfile(t *testing.T) {
	html, err := renderMarkdownToHTML("# Report\n\n~~Complete~~\n\n| Name | Value |\n| --- | --- |\n| Ada | 42 |\n\n- [x] Reviewed")
	if err != nil {
		t.Fatalf("render markdown: %v", err)
	}
	for _, expected := range []string{
		"<h1>Report</h1>",
		"<del>Complete</del>",
		"<table>",
		"<input checked=\"\" disabled=\"\" type=\"checkbox\">",
	} {
		if !strings.Contains(html, expected) {
			t.Fatalf("HTML did not contain %q: %s", expected, html)
		}
	}
}

func TestRenderMarkdownToHTMLDoesNotEnableRawHTML(t *testing.T) {
	html, err := renderMarkdownToHTML("<script>alert('x')</script>")
	if err != nil {
		t.Fatalf("render markdown: %v", err)
	}
	if strings.Contains(html, "<script>") || strings.Contains(html, "alert('x')") {
		t.Fatalf("raw HTML was rendered: %s", html)
	}
}
