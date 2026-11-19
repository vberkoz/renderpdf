package main

import (
	"context"
	"encoding/base64"
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

func TestZeroRetentionAndBinaryPDFResponse(t *testing.T) {
	prevClient, prevTable, prevBucket := ddbClient, tableName, bucketName
	prevFileFactory := fileStoreFactory
	prevRender, prevPut, prevSign := renderHTMLPDF, putRenderedPDFObject, signRenderedPDFDownload
	t.Cleanup(func() {
		ddbClient, tableName, bucketName = prevClient, prevTable, prevBucket
		fileStoreFactory = prevFileFactory
		renderHTMLPDF, putRenderedPDFObject, signRenderedPDFDownload = prevRender, prevPut, prevSign
	})

	t.Setenv("FREE_MONTHLY_QUOTA", "25")
	tableName = "renderpdf-usage"
	bucketName = "renderpdf-pdfs"
	fakeDDB := &fakeDynamoDB{}
	ddbClient = fakeDDB

	fakePDF := []byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
	renderHTMLPDF = func(_ context.Context, _ string, _ documentRenderOptions) ([]byte, error) {
		return fakePDF, nil
	}

	s3Writes := 0
	s3Signs := 0
	fileCreates := 0
	putRenderedPDFObject = func(_, _ string, _ []byte) error {
		s3Writes++
		return nil
	}
	signRenderedPDFDownload = func(bucket, key string) (string, error) {
		s3Signs++
		return "https://signed.example.com/" + bucket + "/" + key, nil
	}
	fileStoreFactory = func() fileStore {
		return &countingFileStore{onCreate: func() { fileCreates++ }}
	}

	// 1. zeroRetention: true with JSON response -> 0 S3 writes, 0 fileStore writes, inline base64 data
	reqZeroJSON := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Body:       `{"version":"1","source":{"type":"html","content":"<h1>Zero Retention</h1>"},"options":{"zeroRetention":true}}`,
	}
	reqZeroJSON.RequestContext.Authorizer = map[string]interface{}{"userId": "customer-zero"}

	resp, err := handler(context.Background(), reqZeroJSON)
	if err != nil {
		t.Fatalf("zeroRetention JSON handler error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200; body=%s", resp.StatusCode, resp.Body)
	}
	if s3Writes != 0 || s3Signs != 0 || fileCreates != 0 {
		t.Fatalf("expected 0 S3 writes, 0 signs, 0 fileStore writes in zeroRetention, got s3Writes=%d s3Signs=%d fileCreates=%d", s3Writes, s3Signs, fileCreates)
	}
	if resp.Headers["X-Retention-Policy"] != "zero-retention" {
		t.Fatalf("expected X-Retention-Policy: zero-retention header, got %#v", resp.Headers)
	}
	var parsedResp Response
	if err := json.Unmarshal([]byte(resp.Body), &parsedResp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if !parsedResp.ZeroRetention || parsedResp.URL != "" || parsedResp.Data != base64.StdEncoding.EncodeToString(fakePDF) {
		t.Fatalf("unexpected zeroRetention JSON response: %#v", parsedResp)
	}

	// 2. zeroRetention: true with Accept: application/pdf -> binary base64-encoded APIGatewayProxyResponse, 0 S3 writes
	reqZeroBinary := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Headers:    map[string]string{"Accept": "application/pdf"},
		Body:       `{"version":"1","source":{"type":"html","content":"<h1>Zero Binary</h1>"},"label":"Invoice #42","options":{"zeroRetention":true}}`,
	}
	reqZeroBinary.RequestContext.Authorizer = map[string]interface{}{"userId": "customer-zero"}

	binResp, err := handler(context.Background(), reqZeroBinary)
	if err != nil {
		t.Fatalf("zeroRetention binary handler error: %v", err)
	}
	if binResp.StatusCode != 200 || !binResp.IsBase64Encoded {
		t.Fatalf("expected 200 IsBase64Encoded=true, got status=%d isBase64=%v", binResp.StatusCode, binResp.IsBase64Encoded)
	}
	if s3Writes != 0 || fileCreates != 0 {
		t.Fatalf("expected 0 S3 writes and 0 fileStore writes, got s3Writes=%d fileCreates=%d", s3Writes, fileCreates)
	}
	if binResp.Headers["Content-Type"] != "application/pdf" || !strings.Contains(binResp.Headers["Content-Disposition"], "Invoice 42.pdf") {
		t.Fatalf("unexpected binary headers: %#v", binResp.Headers)
	}
	decodedPDF, err := base64.StdEncoding.DecodeString(binResp.Body)
	if err != nil || string(decodedPDF) != string(fakePDF) {
		t.Fatalf("decoded binary body mismatch: err=%v got=%q", err, decodedPDF)
	}

	// 3. zeroRetention: true + webhookUrl -> rejected with 422 zero_retention_webhook_unsupported
	reqZeroWebhook := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Body:       `{"version":"1","source":{"type":"html","content":"<h1>Fail</h1>"},"webhookUrl":"https://example.com/webhook","options":{"zeroRetention":true}}`,
	}
	reqZeroWebhook.RequestContext.Authorizer = map[string]interface{}{"userId": "customer-zero"}

	hookResp, err := handler(context.Background(), reqZeroWebhook)
	if err != nil {
		t.Fatalf("zeroRetention webhook handler error: %v", err)
	}
	if hookResp.StatusCode != 422 || !strings.Contains(hookResp.Body, "zero_retention_webhook_unsupported") {
		t.Fatalf("expected 422 zero_retention_webhook_unsupported, got status=%d body=%s", hookResp.StatusCode, hookResp.Body)
	}

	// 4. Normal retention with options.responseFormat="binary" -> stores in S3 & fileStore AND returns binary PDF
	reqStoredBinary := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Body:       `{"version":"1","source":{"type":"html","content":"<h1>Stored Binary</h1>"},"options":{"responseFormat":"binary"}}`,
	}
	reqStoredBinary.RequestContext.Authorizer = map[string]interface{}{"userId": "customer-zero"}

	storedBinResp, err := handler(context.Background(), reqStoredBinary)
	if err != nil {
		t.Fatalf("stored binary handler error: %v", err)
	}
	if storedBinResp.StatusCode != 200 || !storedBinResp.IsBase64Encoded || storedBinResp.Headers["Content-Type"] != "application/pdf" {
		t.Fatalf("unexpected stored binary response: status=%d isBase64=%v headers=%#v", storedBinResp.StatusCode, storedBinResp.IsBase64Encoded, storedBinResp.Headers)
	}
	if s3Writes != 1 || fileCreates != 1 || storedBinResp.Headers["X-File-Id"] == "" {
		t.Fatalf("expected 1 S3 write, 1 fileStore create, and X-File-Id header, got s3Writes=%d fileCreates=%d headers=%#v", s3Writes, fileCreates, storedBinResp.Headers)
	}
}

type countingFileStore struct {
	noopTestFileStore
	onCreate func()
}

func (c *countingFileStore) Create(_ context.Context, _ storedFile) error {
	if c.onCreate != nil {
		c.onCreate()
	}
	return nil
}

