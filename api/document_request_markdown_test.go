package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go/aws"
)

func TestParseDocumentRenderRequestAcceptsMarkdownSourceVariant(t *testing.T) {
	request, err := parseDocumentRenderRequest(`{
		"version":"1",
		"source":{"type":"markdown","content":"# {{report.title}}\n\n{{report.summary}}"},
		"css":"body { font-family: Arial, sans-serif; }",
		"data":{"report":{"title":"Monthly report","summary":"Ready."}},
		"options":{"format":"A4","margin":"18mm"}
	}`)
	if err != nil {
		t.Fatalf("parse markdown document request: %v", err)
	}
	if request.Source == nil || request.Source.Type != "markdown" {
		t.Fatalf("source = %#v", request.Source)
	}

	documentHTML, _, err := resolveDocumentRenderHTML(`{
		"version":"1",
		"source":{"type":"markdown","content":"# {{title}}\n\n| Value |\n| --- |\n| {{title}} |\n\n<script>alert(1)</script>"},
		"css":"body { font-family: Arial, sans-serif; }",
		"data":{"title":"Report"}
	}`)
	if err != nil {
		t.Fatalf("render markdown document: %v", err)
	}
	for _, expected := range []string{
		"<meta charset=\"utf-8\">",
		"body { font-family: Arial, sans-serif; }",
		"@page { size: A4; margin: 18mm; }",
		"<h1>Report</h1>",
		"<table>",
	} {
		if !strings.Contains(documentHTML, expected) {
			t.Fatalf("rendered HTML did not contain %q: %s", expected, documentHTML)
		}
	}
	if strings.Contains(documentHTML, "<script>") || strings.Contains(documentHTML, "alert(1)") {
		t.Fatalf("raw Markdown HTML was retained: %s", documentHTML)
	}
}

func TestDocumentSourceVariantRejectsConflictsAndInvalidTypes(t *testing.T) {
	tests := []struct {
		name string
		body string
		code string
	}{
		{"html conflict", `{"version":"1","html":"<p>Hi</p>","source":{"type":"markdown","content":"# Hi"},"data":{}}`, "document_source_conflict"},
		{"invalid type", `{"version":"1","source":{"type":"html","content":"<p>Hi</p>"},"data":{}}`, "document_source_type_invalid"},
		{"missing content", `{"version":"1","source":{"type":"markdown","content":""},"data":{}}`, "document_source_content_required"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseDocumentRenderRequest(test.body)
			assertDocumentErrorCode(t, err, test.code)
		})
	}
}

func TestResolveDocumentMarkdownEscapesBindingValuesAsPlainText(t *testing.T) {
	markdown, err := resolveDocumentMarkdown("# {{title}}\n\n{{body}}", map[string]any{
		"title": "Report *draft*",
		"body":  "[Open](https://example.test) <script>alert(1)</script>",
	})
	if err != nil {
		t.Fatalf("resolve markdown: %v", err)
	}
	for _, expected := range []string{
		"Report \\*draft\\*",
		"\\[Open\\]\\(https://example\\.test\\)",
		"&lt;script&gt;alert\\(1\\)&lt;/script&gt;",
	} {
		if !strings.Contains(markdown, expected) {
			t.Fatalf("resolved Markdown did not contain %q: %s", expected, markdown)
		}
	}

	html, err := renderMarkdownToHTML(markdown)
	if err != nil {
		t.Fatalf("convert resolved Markdown: %v", err)
	}
	if strings.Contains(html, "<em>draft</em>") || strings.Contains(html, "<a href=") || strings.Contains(html, "<script>") {
		t.Fatalf("binding created Markdown or HTML structure: %s", html)
	}
}

func TestMarkdownDocumentReusesHTMLAndCSSSafetyChecks(t *testing.T) {
	tests := []struct {
		name string
		body string
		code string
	}{
		{
			name: "generated remote image",
			body: `{"version":"1","source":{"type":"markdown","content":"![logo](https://example.test/logo.png)"},"data":{}}`,
			code: "document_asset_disallowed",
		},
		{
			name: "CSS asset",
			body: `{"version":"1","source":{"type":"markdown","content":"# Report"},"css":"body { background: url(https://example.test/pattern.png); }","data":{}}`,
			code: "document_asset_disallowed",
		},
		{
			name: "author page rule",
			body: `{"version":"1","source":{"type":"markdown","content":"@page { size: A3; }"},"data":{}}`,
			code: "document_page_settings_disallowed",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := resolveDocumentRenderHTML(test.body)
			assertDocumentErrorCode(t, err, test.code)
		})
	}
}

func TestMarkdownDocumentConvertsCommonMarkStructuresAndNestedBindings(t *testing.T) {
	documentHTML, _, err := resolveDocumentRenderHTML(`{
		"version":"1",
		"source":{"type":"markdown","content":"# {{report.title}}\n\n{{report.summary}}\n\n- First item\n- [x] {{report.status}}\n\n| Customer | Status |\n| --- | --- |\n| {{customer.name}} | {{report.status}} |"},
		"data":{"report":{"title":"Monthly report","summary":"Prepared for Ada.","status":"Ready"},"customer":{"name":"Ada & Sons"}}
	}`)
	if err != nil {
		t.Fatalf("render Markdown document: %v", err)
	}
	for _, expected := range []string{
		"<h1>Monthly report</h1>",
		"<ul>",
		"<table>",
		"Ada &amp; Sons",
		"type=\"checkbox\"",
	} {
		if !strings.Contains(documentHTML, expected) {
			t.Fatalf("document HTML did not contain %q: %s", expected, documentHTML)
		}
	}
}

func TestMarkdownDocumentDoesNotRetainUnsafeLinkSchemes(t *testing.T) {
	documentHTML, _, err := resolveDocumentRenderHTML(`{
		"version":"1",
		"source":{"type":"markdown","content":"[Unsafe link](javascript:alert(1))"},
		"data":{}
	}`)
	if err != nil {
		var renderErr *renderError
		if !errors.As(err, &renderErr) || renderErr.Code != "document_url_unsafe" {
			t.Fatalf("unexpected unsafe-link error: %#v", err)
		}
		return
	}
	if strings.Contains(strings.ToLower(documentHTML), "javascript:") {
		t.Fatalf("unsafe URL scheme reached document shell: %s", documentHTML)
	}
}

func TestMarkdownDocumentWebhookUsesExistingDeliveryPayload(t *testing.T) {
	previousClient := sqsClient
	t.Cleanup(func() { sqsClient = previousClient })
	fake := &fakeSQS{}
	sqsClient = fake
	t.Setenv("WEBHOOK_QUEUE_URL", "https://sqs.us-east-1.amazonaws.com/123/renderpdf-webhooks")

	_, request, err := resolveDocumentRenderHTML(`{
		"version":"1",
		"source":{"type":"markdown","content":"# {{title}}"},
		"data":{"title":"Report"},
		"webhookUrl":"https://example.test/hooks/pdf",
		"webhookSecret":"signing-secret"
	}`)
	if err != nil {
		t.Fatalf("resolve Markdown document: %v", err)
	}
	event := webhookEvent{ID: "markdown-request-1", URL: request.WebhookURL, Secret: request.WebhookSecret, PDFURL: "https://bucket.example.test/markdown-request-1.pdf", PDFSize: 2048, CreatedAt: time.Now().UTC()}
	if err := enqueueWebhook(context.Background(), event); err != nil {
		t.Fatalf("enqueue Markdown webhook: %v", err)
	}
	var queued webhookEvent
	if fake.input == nil || json.Unmarshal([]byte(aws.StringValue(fake.input.MessageBody)), &queued) != nil {
		t.Fatal("expected a queued Markdown webhook event")
	}
	if queued.ID != event.ID || queued.URL != event.URL || queued.Secret != event.Secret {
		t.Fatalf("queued webhook = %#v, want %#v", queued, event)
	}
}

func TestMarkdownSourceValidationIsStrictAndStructured(t *testing.T) {
	deepData := `"value"`
	for i := 0; i < maxDocumentDataDepth; i++ {
		deepData = `{"value":` + deepData + `}`
	}
	tests := []struct {
		name   string
		body   string
		code   string
		status int
	}{
		{"unknown source field", `{"version":"1","source":{"type":"markdown","content":"# Hi","unsafe":true},"data":{}}`, "document_request_invalid", 400},
		{"oversized Markdown", `{"version":"1","source":{"type":"markdown","content":"` + strings.Repeat("x", maxDocumentMarkdownBytes+1) + `"},"data":{}}`, "document_source_too_large", 413},
		{"nested data", `{"version":"1","source":{"type":"markdown","content":"# Hi"},"data":` + deepData + `}`, "document_data_too_deep", 422},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseDocumentRenderRequest(test.body)
			var renderErr *renderError
			if !errors.As(err, &renderErr) || renderErr.Code != test.code || renderErr.Status != test.status {
				t.Fatalf("error = %#v, want %d %q", err, test.status, test.code)
			}
		})
	}
}

func TestMarkdownAnalyticsUsesNormalizedSourceMetadata(t *testing.T) {
	request, err := parseDocumentRenderRequest(`{
		"version":"1",
		"source":{"type":"markdown","content":"# {{report.title}}"},
		"data":{"report":{"title":"Monthly report"}},
		"options":{},
		"webhookUrl":"https://example.test/pdf",
		"webhookSecret":"secret"
	}`)
	if err != nil {
		t.Fatalf("parse Markdown document request: %v", err)
	}
	normalized, err := normalizedDocumentDefinitionJSON(request)
	if err != nil {
		t.Fatalf("normalize Markdown document definition: %v", err)
	}
	if !strings.Contains(string(normalized), `"source":{"type":"markdown"`) {
		t.Fatalf("normalized definition did not preserve Markdown source: %s", normalized)
	}
	if strings.Contains(string(normalized), "webhookUrl") || strings.Contains(string(normalized), "secret") {
		t.Fatalf("normalized definition must exclude delivery settings: %s", normalized)
	}

	previousClient, previousTable := ddbClient, tableName
	t.Cleanup(func() { ddbClient, tableName = previousClient, previousTable })
	fake := &fakeDynamoDB{}
	ddbClient, tableName = fake, "renderpdf-usage"
	trackUsage(context.Background(), requestAnalytics{
		RequestID: "request-markdown-1", Plan: "api", Status: "success",
		SourceType: request.Source.Type, SourceMode: "inline", SourceVersion: request.Version,
		SourceBytes: normalizedDocumentDefinitionBytes(request),
	})
	if fake.putInput == nil {
		t.Fatal("expected analytics write")
	}
	item := fake.putInput.Item
	for attribute, want := range map[string]string{
		"requestId":     "request-markdown-1",
		"sourceType":    "markdown",
		"sourceMode":    "inline",
		"sourceVersion": "1",
	} {
		if got := aws.StringValue(item[attribute].S); got != want {
			t.Fatalf("%s = %q, want %q", attribute, got, want)
		}
	}
	if got := aws.StringValue(item["sourceBytes"].N); got == "" || got == "0" {
		t.Fatalf("sourceBytes = %q, want normalized source size", got)
	}
}
