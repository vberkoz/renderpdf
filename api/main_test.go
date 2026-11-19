package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
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

func TestHandlerBlocksSanctionedCountry(t *testing.T) {
	ctx := context.Background()
	req := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Path:       "/api/v1/render",
		Headers: map[string]string{
			"CloudFront-Viewer-Country": "RU",
		},
	}
	resp, err := handler(ctx, req)
	if err != nil {
		t.Fatalf("handler err = %v", err)
	}
	if resp.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
	if !strings.Contains(resp.Body, "international sanctions") {
		t.Fatalf("body = %s, want mention of sanctions", resp.Body)
	}
}

func TestTrialModeIsolatesDocumentStoreAndBlocksNonTrialRoutes(t *testing.T) {
	previousClient, previousTable, previousBucket, previousSecret := ddbClient, tableName, bucketName, trialSecret
	previousFileFactory, previousSourceFactory, previousTemplateFactory := fileStoreFactory, sourceStoreFactory, templateStoreFactory
	previousRender, previousPut, previousSign := renderHTMLPDF, putRenderedPDFObject, signRenderedPDFDownload
	t.Cleanup(func() {
		ddbClient, tableName, bucketName, trialSecret = previousClient, previousTable, previousBucket, previousSecret
		fileStoreFactory, sourceStoreFactory, templateStoreFactory = previousFileFactory, previousSourceFactory, previousTemplateFactory
		renderHTMLPDF, putRenderedPDFObject, signRenderedPDFDownload = previousRender, previousPut, previousSign
	})

	t.Setenv("TRIAL_MODE_ONLY", "true")
	t.Setenv("TRIAL_DAILY_LIMIT", "3")
	tableName = "renderpdf-usage"
	bucketName = "renderpdf-pdfs"
	trialSecret = []byte("01234567890123456789012345678901")
	ddbClient = &fakeDynamoDB{count: "1"}

	fileStoreFactory = func() fileStore {
		t.Fatal("trial mode must not invoke fileStoreFactory")
		return nil
	}
	sourceStoreFactory = func() sourceStore {
		t.Fatal("trial mode must not invoke sourceStoreFactory")
		return nil
	}
	templateStoreFactory = func() templateStore {
		t.Fatal("trial mode must not invoke templateStoreFactory")
		return nil
	}

	var putBucket, putKey string
	renderHTMLPDF = func(context.Context, string, documentRenderOptions) ([]byte, error) {
		return []byte("%PDF-1.4\n%%EOF\n"), nil
	}
	putRenderedPDFObject = func(bucket, key string, _ []byte) error {
		putBucket, putKey = bucket, key
		return nil
	}
	signRenderedPDFDownload = func(bucket, key string) (string, error) {
		return "https://signed.example.com/" + bucket + "/" + key, nil
	}

	resp, err := handler(context.Background(), events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   trialResource,
		Path:       trialResource,
		Body:       `{"html":"<h1>Trial</h1>"}`,
		Headers:    map[string]string{"X-RenderPDF-Viewer-IP": "203.0.113.8"},
	})
	if err != nil {
		t.Fatalf("trial render err = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("trial render status = %d, want 200; body=%s", resp.StatusCode, resp.Body)
	}
	if putBucket != "renderpdf-pdfs" || !strings.HasPrefix(putKey, "files/trial/") || !strings.HasSuffix(putKey, ".pdf") {
		t.Fatalf("unexpected trial S3 target bucket=%q key=%q", putBucket, putKey)
	}

	quotaResp, err := handler(context.Background(), events.APIGatewayProxyRequest{
		HTTPMethod: "GET",
		Resource:   trialQuotaResource,
		Path:       trialQuotaResource,
		Headers:    map[string]string{"X-RenderPDF-Viewer-IP": "203.0.113.8"},
	})
	if err != nil {
		t.Fatalf("trial quota err = %v", err)
	}
	if quotaResp.StatusCode != 200 {
		t.Fatalf("trial quota status = %d, want 200; body=%s", quotaResp.StatusCode, quotaResp.Body)
	}

	blockedRoutes := []struct {
		method string
		path   string
	}{
		{"GET", "/api/v1/files"},
		{"GET", "/api/v1/sources"},
		{"POST", "/api/v1/batches"},
		{"POST", "/api/v1/merge"},
		{"GET", "/api/v1/templates"},
	}
	for _, route := range blockedRoutes {
		blockedResp, blockedErr := handler(context.Background(), events.APIGatewayProxyRequest{
			HTTPMethod: route.method,
			Resource:   route.path,
			Path:       route.path,
		})
		if blockedErr != nil {
			t.Fatalf("%s %s err = %v", route.method, route.path, blockedErr)
		}
		if blockedResp.StatusCode != 404 {
			t.Fatalf("%s %s status = %d, want 404; body=%s", route.method, route.path, blockedResp.StatusCode, blockedResp.Body)
		}
	}
}

