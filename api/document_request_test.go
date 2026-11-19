package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"

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

func TestBuildDocumentHTMLSupportsLandscape(t *testing.T) {
	falseVal := false
	portraitHTML, err := buildDocumentHTMLFromResolvedHTML("<p>Hi</p>", "", documentRenderOptions{
		Format:    "Letter",
		Margin:    "0.5in",
		Landscape: &falseVal,
	})
	if err != nil {
		t.Fatalf("portrait build error = %v", err)
	}
	if !strings.Contains(portraitHTML, "@page { size: Letter; margin: 0.5in; }") {
		t.Fatalf("expected portrait @page rule, got: %s", portraitHTML)
	}

	trueVal := true
	landscapeHTML, err := buildDocumentHTMLFromResolvedHTML("<p>Hi</p>", "", documentRenderOptions{
		Format:    "Letter",
		Margin:    "0.5in",
		Landscape: &trueVal,
	})
	if err != nil {
		t.Fatalf("landscape build error = %v", err)
	}
	if !strings.Contains(landscapeHTML, "@page { size: Letter landscape; margin: 0.5in; }") {
		t.Fatalf("expected landscape @page rule, got: %s", landscapeHTML)
	}
}

func TestMergeDocumentRenderOptions(t *testing.T) {
	trueVal := true
	falseVal := false
	base := documentRenderOptions{
		Format:              "A4",
		Margin:              "18mm",
		Landscape:           &trueVal,
		DisplayHeaderFooter: &trueVal,
		HeaderTemplate:      "<div>Base Header</div>",
		Watermark:           &watermarkOptions{Text: "DRAFT"},
	}
	override := documentRenderOptions{
		Format:              "Letter",
		Landscape:           &falseVal,
		DisplayHeaderFooter: &falseVal,
		TimeoutMs:           3000,
	}

	merged := mergeDocumentRenderOptions(base, override)
	if merged.Format != "Letter" {
		t.Fatalf("Format = %q, want Letter", merged.Format)
	}
	if merged.Margin != "18mm" {
		t.Fatalf("Margin = %q, want preserved 18mm", merged.Margin)
	}
	if merged.Landscape == nil || *merged.Landscape != false {
		t.Fatalf("Landscape = %#v, want false", merged.Landscape)
	}
	if merged.DisplayHeaderFooter == nil || *merged.DisplayHeaderFooter != false {
		t.Fatalf("DisplayHeaderFooter = %#v, want false", merged.DisplayHeaderFooter)
	}
	if merged.HeaderTemplate != "<div>Base Header</div>" {
		t.Fatalf("HeaderTemplate = %q, want preserved base header", merged.HeaderTemplate)
	}
	if merged.Watermark == nil || merged.Watermark.Text != "DRAFT" {
		t.Fatalf("Watermark = %#v, want preserved DRAFT", merged.Watermark)
	}
	if merged.TimeoutMs != 3000 {
		t.Fatalf("TimeoutMs = %d, want 3000", merged.TimeoutMs)
	}
	if base.Landscape == nil || *base.Landscape != true {
		t.Fatalf("base.Landscape mutated: %#v", base.Landscape)
	}
	*merged.Landscape = true
	if *override.Landscape != false {
		t.Fatalf("override.Landscape aliased to merged pointer")
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
		{"unsafe headerTemplate", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"headerTemplate":"<div><script>alert(1)</script></div>"}}`, "document_html_unsafe"},
		{"unsafe footerTemplate", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"footerTemplate":"<div><iframe src=\"https://evil.test\"></iframe></div>"}}`, "document_html_unsafe"},
		{"oversized headerTemplate", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"headerTemplate":"` + strings.Repeat("x", maxDocumentTemplateBytes+1) + `"}}`, "document_template_too_large"},
		{"oversized footerTemplate", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"footerTemplate":"` + strings.Repeat("x", maxDocumentTemplateBytes+1) + `"}}`, "document_template_too_large"},
		{"invalid permissions", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"permissions":"invalid"}}`, "document_permissions_invalid"},
		{"password too long", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"password":"` + strings.Repeat("x", 129) + `"}}`, "document_password_invalid"},
		{"ownerPassword too long", `{"version":"1","html":"<p>Hi</p>","data":{},"options":{"ownerPassword":"` + strings.Repeat("x", 129) + `"}}`, "document_password_invalid"},
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

func TestDocumentOptionsValidationAndPlaceholders(t *testing.T) {
	reqJSON := `{
		"version": "1",
		"html": "<h1>Test</h1>",
		"data": {},
		"options": {
			"headerTemplate": "<div style=\"font-size:10px;\"><span class=\"title\"></span> - <span class=\"date\"></span></div>",
			"footerTemplate": "<div style=\"font-size:10px;\">Page <span class=\"pageNumber\"></span> of <span class=\"totalPages\"></span></div>",
			"displayHeaderFooter": false,
			"password": "user-secret",
			"ownerPassword": "owner-secret",
			"permissions": "print"
		}
	}`
	req, err := parseDocumentRenderRequest(reqJSON)
	if err != nil {
		t.Fatalf("parseDocumentRenderRequest error = %v", err)
	}
	if req.Options.DisplayHeaderFooter == nil || *req.Options.DisplayHeaderFooter != false {
		t.Fatalf("expected displayHeaderFooter to be false, got %#v", req.Options.DisplayHeaderFooter)
	}
	if !strings.Contains(req.Options.FooterTemplate, "pageNumber") {
		t.Fatalf("expected pageNumber placeholder, got %s", req.Options.FooterTemplate)
	}
	if !strings.Contains(req.Options.FooterTemplate, "totalPages") {
		t.Fatalf("expected totalPages placeholder, got %s", req.Options.FooterTemplate)
	}
	if !strings.Contains(req.Options.HeaderTemplate, "date") || !strings.Contains(req.Options.HeaderTemplate, "title") {
		t.Fatalf("expected date and title placeholder, got %s", req.Options.HeaderTemplate)
	}
	if req.Options.Password != "user-secret" || req.Options.OwnerPassword != "owner-secret" || req.Options.Permissions != "print" {
		t.Fatalf("unexpected password options: %#v", req.Options)
	}
}

func TestDocumentOptionsPageNumbersValidation(t *testing.T) {
	validJSON := `{
		"version": "1",
		"html": "<h1>Test</h1>",
		"data": {},
		"options": {
			"pageNumbers": {
				"format": "Page {page} of {total}",
				"position": "bottom-right",
				"startPage": 2,
				"excludeCover": true,
				"startNumber": 1,
				"fontSize": 10,
				"color": "0.3 0.3 0.3"
			}
		}
	}`
	req, err := parseDocumentRenderRequest(validJSON)
	if err != nil {
		t.Fatalf("valid pageNumbers options failed to parse: %v", err)
	}
	if req.Options.PageNumbers == nil {
		t.Fatalf("expected pageNumbers to be parsed")
	}
	if req.Options.PageNumbers.Format != "Page {page} of {total}" || req.Options.PageNumbers.Position != "bottom-right" {
		t.Fatalf("unexpected pageNumbers values: %#v", req.Options.PageNumbers)
	}

	invalidTests := []struct {
		name string
		json string
		code string
	}{
		{"missing {page} placeholder", `{"version":"1","html":"<p>x</p>","data":{},"options":{"pageNumbers":{"format":"Page X of Y"}}}`, "document_page_number_format_invalid"},
		{"invalid position", `{"version":"1","html":"<p>x</p>","data":{},"options":{"pageNumbers":{"position":"middle-center"}}}`, "document_page_number_position_invalid"},
		{"negative startPage", `{"version":"1","html":"<p>x</p>","data":{},"options":{"pageNumbers":{"startPage":-1}}}`, "document_page_number_start_page_invalid"},
		{"negative startNumber", `{"version":"1","html":"<p>x</p>","data":{},"options":{"pageNumbers":{"startNumber":-1}}}`, "document_page_number_start_number_invalid"},
		{"fontSize too large", `{"version":"1","html":"<p>x</p>","data":{},"options":{"pageNumbers":{"fontSize":100}}}`, "document_page_number_font_size_invalid"},
		{"color wrong parts", `{"version":"1","html":"<p>x</p>","data":{},"options":{"pageNumbers":{"color":"0.5 0.5"}}}`, "document_page_number_color_invalid"},
		{"color out of range", `{"version":"1","html":"<p>x</p>","data":{},"options":{"pageNumbers":{"color":"0.5 1.5 0.2"}}}`, "document_page_number_color_invalid"},
		{"color non-numeric", `{"version":"1","html":"<p>x</p>","data":{},"options":{"pageNumbers":{"color":"red green blue"}}}`, "document_page_number_color_invalid"},
	}

	for _, tc := range invalidTests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseDocumentRenderRequest(tc.json)
			if err == nil {
				t.Fatalf("expected error for %s, got nil", tc.name)
			}
			var renderErr *renderError
			if !errors.As(err, &renderErr) || renderErr.Code != tc.code {
				t.Fatalf("expected %s code, got %#v", tc.code, err)
			}
		})
	}
}

