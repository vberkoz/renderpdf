package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
)

func TestIsDocumentRenderRequest(t *testing.T) {
	if !isDocumentRenderRequest(events.APIGatewayProxyRequest{Resource: dashboardDocumentRenderResource}) {
		t.Fatal("expected dashboard render-document resource to be recognized")
	}
	if isDocumentRenderRequest(events.APIGatewayProxyRequest{Path: renderResource}) {
		t.Fatal("expected canonical render route to be normalized before document compilation")
	}
}

func TestParseDocumentRenderRequestAcceptsVersionOneContract(t *testing.T) {
	request, err := parseDocumentRenderRequest(`{
		"version":"1",
		"html":"<main><h1>{{title}}</h1><p>{{body}}</p></main>",
		"css":"body { font-family: Arial, sans-serif; } h1 { color: #123456; }",
		"data":{"title":"Monthly report","body":"Prepared for Ada & Sons."},
		"options":{"format":"A4","margin":"18mm"}
	}`)
	if err != nil {
		t.Fatalf("parse document request: %v", err)
	}
	if request.Version != "1" || request.Options.Format != "A4" || request.Options.Margin != "18mm" {
		t.Fatalf("parsed request = %#v", request)
	}
	if request.Data["title"] != "Monthly report" {
		t.Fatalf("data = %#v", request.Data)
	}
}

func TestResolveDocumentRenderHTMLPreservesWebhookSettings(t *testing.T) {
	documentHTML, request, err := resolveDocumentRenderHTML(`{
		"version":"1",
		"html":"<p>{{title}}</p>",
		"css":"",
		"data":{"title":"Report"},
		"webhookUrl":"https://example.test/pdf",
		"webhookSecret":"signing-secret"
	}`)
	if err != nil {
		t.Fatalf("resolve document render HTML: %v", err)
	}
	if !strings.Contains(documentHTML, "<p>Report</p>") {
		t.Fatalf("document HTML = %q", documentHTML)
	}
	if request.WebhookURL != "https://example.test/pdf" || request.WebhookSecret != "signing-secret" {
		t.Fatalf("notification settings = %#v", request)
	}
}

func TestParseDocumentRenderRequestAppliesLayoutDefaults(t *testing.T) {
	request, err := parseDocumentRenderRequest(`{"version":"1","html":"<p>Hi</p>","css":"","data":{},"options":{}}`)
	if err != nil {
		t.Fatalf("parse document request: %v", err)
	}
	if request.Options.Format != defaultDocumentFormat || request.Options.Margin != defaultDocumentMargin {
		t.Fatalf("options = %#v, want defaults", request.Options)
	}
}

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

func assertDocumentErrorCode(t *testing.T, err error, want string) {
	t.Helper()
	var renderErr *renderError
	if !errors.As(err, &renderErr) || renderErr.Code != want {
		t.Fatalf("error = %#v, want code %q", err, want)
	}
}

func TestDocumentAnalyticsUsesNormalizedSourceMetadata(t *testing.T) {
	request, err := parseDocumentRenderRequest(`{
		"version":"1",
		"html":"<p>{{title}}</p>",
		"css":"",
		"data":{"title":"Report"},
		"options":{},
		"webhookUrl":"https://example.test/pdf",
		"webhookSecret":"secret"
	}`)
	if err != nil {
		t.Fatalf("parse document request: %v", err)
	}
	if got := normalizedDocumentDefinitionBytes(request); got <= 0 {
		t.Fatalf("normalized source bytes = %d, want a positive value", got)
	}
	normalized, err := normalizedDocumentDefinitionJSON(request)
	if err != nil {
		t.Fatalf("normalize document definition: %v", err)
	}
	if strings.Contains(string(normalized), "webhookUrl") || strings.Contains(string(normalized), "secret") {
		t.Fatalf("normalized definition must exclude delivery settings: %s", normalized)
	}

	previousClient, previousTable := ddbClient, tableName
	t.Cleanup(func() { ddbClient, tableName = previousClient, previousTable })
	fake := &fakeDynamoDB{}
	ddbClient, tableName = fake, "renderpdf-usage"
	trackUsage(context.Background(), requestAnalytics{
		RequestID: "request-document-1", Plan: "api", Status: "success",
		SourceType: "document_json", SourceMode: "inline", SourceVersion: request.Version,
		SourceBytes: normalizedDocumentDefinitionBytes(request),
	})
	if fake.putInput == nil {
		t.Fatal("expected analytics write")
	}
	item := fake.putInput.Item
	if got := aws.StringValue(item["requestId"].S); got != "request-document-1" {
		t.Fatalf("requestId = %q", got)
	}
	if got := aws.StringValue(item["sourceType"].S); got != "document_json" {
		t.Fatalf("sourceType = %q", got)
	}
	if got := aws.StringValue(item["sourceMode"].S); got != "inline" {
		t.Fatalf("sourceMode = %q", got)
	}
	if got := aws.StringValue(item["sourceVersion"].S); got != "1" {
		t.Fatalf("sourceVersion = %q", got)
	}
	if got := aws.StringValue(item["sourceBytes"].N); got == "0" || got == "" {
		t.Fatalf("sourceBytes = %q", got)
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

func TestResolveDocumentHTMLEscapesBoundValues(t *testing.T) {
	html, err := resolveDocumentHTML(`<h1>{{title}}</h1><p>{{customer.name}}</p>`, map[string]any{
		"title":    "Monthly report",
		"customer": map[string]any{"name": "Ada & Sons <Ltd>"},
	})
	if err != nil {
		t.Fatalf("resolve document HTML: %v", err)
	}
	if html != `<h1>Monthly report</h1><p>Ada &amp; Sons &lt;Ltd&gt;</p>` {
		t.Fatalf("resolved HTML = %q", html)
	}
}

func TestBuildDocumentHTMLCreatesControlledShell(t *testing.T) {
	request, err := parseDocumentRenderRequest(`{
		"version":"1",
		"html":"<main><h1>{{title}}</h1></main>",
		"css":"main { color: #123456; }",
		"data":{"title":"Ada & Sons"},
		"options":{"format":"Letter","margin":"0.5in"}
	}`)
	if err != nil {
		t.Fatalf("parse document request: %v", err)
	}
	documentHTML, err := buildDocumentHTML(request)
	if err != nil {
		t.Fatalf("build document HTML: %v", err)
	}
	for _, expected := range []string{
		"<!doctype html>",
		"<meta charset=\"utf-8\">",
		"main { color: #123456; }",
		"@page { size: Letter; margin: 0.5in; }",
		"<body>\n<main><h1>Ada &amp; Sons</h1></main>",
	} {
		if !strings.Contains(documentHTML, expected) {
			t.Fatalf("document HTML did not contain %q: %s", expected, documentHTML)
		}
	}
}

func TestDocumentRenderProducesPDFWhenChromeIsAvailable(t *testing.T) {
	if _, err := os.Stat("/opt/google/chrome/chrome"); os.IsNotExist(err) {
		t.Skip("Chrome not available - test only runs in the Lambda image")
	}
	documentHTML, _, err := resolveDocumentRenderHTML(`{
		"version":"1",
		"html":"<main><h1>{{report.title}}</h1><p>{{customer.name}}</p></main>",
		"css":"body { font-family: Arial, sans-serif; }",
		"data":{"report":{"title":"Monthly report"},"customer":{"name":"Ada & Sons"}},
		"options":{"format":"A4","margin":"18mm"}
	}`)
	if err != nil {
		t.Fatalf("resolve document render HTML: %v", err)
	}
	pdf, err := generateDocumentPDF(context.Background(), documentHTML)
	if err != nil {
		t.Fatalf("generate document PDF: %v", err)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF")) {
		t.Fatalf("generated output is not a PDF: %q", pdf[:min(len(pdf), 16)])
	}
}

func TestMarkdownDocumentProducesPDFWhenChromeIsAvailable(t *testing.T) {
	if _, err := os.Stat("/opt/google/chrome/chrome"); os.IsNotExist(err) {
		t.Skip("Chrome not available - test only runs in the Lambda image")
	}
	documentHTML, _, err := resolveDocumentRenderHTML(`{
		"version":"1",
		"source":{"type":"markdown","content":"# {{report.title}}\n\n{{customer.name}}"},
		"data":{"report":{"title":"Monthly report"},"customer":{"name":"Ada & Sons"}}
	}`)
	if err != nil {
		t.Fatalf("resolve Markdown document: %v", err)
	}
	pdf, err := generateDocumentPDF(context.Background(), documentHTML)
	if err != nil {
		t.Fatalf("generate Markdown PDF: %v", err)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF")) {
		t.Fatalf("generated output is not a PDF: %q", pdf[:min(len(pdf), 16)])
	}
}

func TestParseDocumentRenderRequestRejectsInvalidContract(t *testing.T) {
	tests := []struct {
		name string
		body string
		code string
	}{
		{"malformed JSON", `{"version":"1"`, "document_request_invalid"},
		{"unknown field", `{"version":"1","html":"<p>Hi</p>","data":{},"unexpected":true}`, "document_request_invalid"},
		{"trailing payload", `{"version":"1","html":"<p>Hi</p>","data":{}} {}`, "document_request_invalid"},
		{"unsupported version", `{"version":"2","html":"<p>Hi</p>","data":{}}`, "document_version_unsupported"},
		{"missing html", `{"version":"1","data":{}}`, "document_html_required"},
		{"missing data", `{"version":"1","html":"<p>Hi</p>"}`, "document_data_required"},
		{"missing binding", `{"version":"1","html":"<p>{{customer.name}}</p>","data":{"customer":{}}}`, "document_binding_missing"},
		{"unknown binding", `{"version":"1","html":"<p>{{customer.name}}</p>","data":{"customer":{"name":"Ada","email":"ada@example.test"}}}`, "document_binding_unknown"},
		{"invalid binding", `{"version":"1","html":"<p>{{customer-name}}</p>","data":{}}`, "document_binding_invalid"},
		{"unsupported format", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"format":"A3"}}`, "document_format_invalid"},
		{"invalid margin unit", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"margin":"10px"}}`, "document_margin_invalid"},
		{"excessive margin", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"margin":"51mm"}}`, "document_margin_invalid"},
		{"unknown option", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"orientation":"landscape"}}`, "document_request_invalid"},
		{"page settings in CSS", `{"version":"1","html":"<p>Hi</p>","css":"@page { size: A3; }","data":{}}`, "document_page_settings_disallowed"},
		{"page settings in HTML", `{"version":"1","html":"<style>@page { margin: 0; }</style><p>Hi</p>","data":{}}`, "document_page_settings_disallowed"},
		{"script tag", `{"version":"1","html":"<script>alert(1)</script>","data":{}}`, "document_html_unsafe"},
		{"event handler", `{"version":"1","html":"<p onclick=\"alert(1)\">Hi</p>","data":{}}`, "document_html_unsafe"},
		{"embedded frame", `{"version":"1","html":"<iframe src=\"https://example.test\"></iframe>","data":{}}`, "document_html_unsafe"},
		{"remote image", `{"version":"1","html":"<img src=\"https://example.test/logo.png\">","data":{}}`, "document_asset_disallowed"},
		{"local image", `{"version":"1","html":"<img src=\"file:///tmp/logo.png\">","data":{}}`, "document_asset_disallowed"},
		{"unsafe URL", `{"version":"1","html":"<a href=\"javascript:alert(1)\">Hi</a>","data":{}}`, "document_url_unsafe"},
		{"local URL", `{"version":"1","html":"<a href=\"file:///tmp/source.html\">Hi</a>","data":{}}`, "document_url_unsafe"},
		{"CSS import", `{"version":"1","html":"<p>Hi</p>","css":"@import url('https://example.test/a.css');","data":{}}`, "document_css_unsafe"},
		{"CSS asset", `{"version":"1","html":"<p>Hi</p>","css":"p { background: url(https://example.test/a.png); }","data":{}}`, "document_asset_disallowed"},
		{"inline CSS asset", `{"version":"1","html":"<p style=\"background: url(https://example.test/a.png)\">Hi</p>","data":{}}`, "document_asset_disallowed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseDocumentRenderRequest(test.body)
			var renderErr *renderError
			if !errors.As(err, &renderErr) || renderErr.Code != test.code {
				t.Fatalf("error = %#v, want code %q", err, test.code)
			}
		})
	}
}

func TestParseDocumentRenderRequestEnforcesSizeAndDepthLimits(t *testing.T) {
	tests := []struct {
		name string
		body string
		code string
	}{
		{"html size", `{"version":"1","html":"` + strings.Repeat("x", maxDocumentHTMLBytes+1) + `","data":{}}`, "document_html_too_large"},
		{"css size", `{"version":"1","html":"<p>Hi</p>","css":"` + strings.Repeat("x", maxDocumentCSSBytes+1) + `","data":{}}`, "document_css_too_large"},
		{"data size", `{"version":"1","html":"<p>Hi</p>","data":{"value":"` + strings.Repeat("x", maxDocumentDataBytes) + `"}}`, "document_data_too_large"},
		{"request size", string(make([]byte, maxDocumentRequestBytes+1)), "document_request_too_large"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseDocumentRenderRequest(test.body)
			var renderErr *renderError
			if !errors.As(err, &renderErr) || renderErr.Code != test.code {
				t.Fatalf("error = %#v, want code %q", err, test.code)
			}
		})
	}

	deepData := `"value"`
	for i := 0; i < maxDocumentDataDepth; i++ {
		deepData = `{"value":` + deepData + `}`
	}
	_, err := parseDocumentRenderRequest(`{"version":"1","html":"<p>Hi</p>","data":` + deepData + `}`)
	var renderErr *renderError
	if !errors.As(err, &renderErr) || renderErr.Code != "document_data_too_deep" {
		t.Fatalf("data depth error = %#v, want document_data_too_deep", err)
	}
}

func TestValidateDocumentRenderInputSize(t *testing.T) {
	err := validateDocumentRenderInputSize(strings.Repeat("x", maxDocumentRenderInputBytes+1), "")
	var renderErr *renderError
	if !errors.As(err, &renderErr) || renderErr.Code != "document_render_input_too_large" {
		t.Fatalf("error = %#v, want document_render_input_too_large", err)
	}
}
