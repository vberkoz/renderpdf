package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/aws/credentials"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/network"
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
	var body APIErrorResponse
	if err := json.Unmarshal([]byte(response.Body), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Code != "navigation_timeout" || body.Error == "" || body.Retryable == nil || *body.Retryable {
		t.Fatalf("body = %#v, want a navigation_timeout code, message, and retryable=false for 422", body)
	}

	origStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe stdout: %v", err)
	}
	os.Stdout = w
	response = renderErrorResponse(errors.New("internal Chrome URL and stack trace"), map[string]string{"X-Request-Id": "request-123"})
	_ = w.Close()
	os.Stdout = origStdout
	var logBuf bytes.Buffer
	if _, err := io.Copy(&logBuf, r); err != nil {
		t.Fatalf("read captured stdout: %v", err)
	}
	_ = r.Close()
	logged := logBuf.String()
	if !strings.Contains(logged, "request-123") || !strings.Contains(logged, "internal Chrome URL and stack trace") {
		t.Fatalf("expected log to contain requestId and underlying error, got %q", logged)
	}
	if response.StatusCode != 500 {
		t.Fatalf("status = %d, want 500", response.StatusCode)
	}
	body = APIErrorResponse{}
	if err := json.Unmarshal([]byte(response.Body), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Code != "rendering_failed" || body.Error != "PDF rendering failed" || body.RequestID != "request-123" || body.Retryable == nil || !*body.Retryable {
		t.Fatalf("unexpected generic rendering response: %#v", body)
	}
	if strings.Contains(response.Body, "internal Chrome URL") {
		t.Fatalf("response body leaked internal error: %s", response.Body)
	}
}

func TestErrorResponseUsesStableCodesAndRequestID(t *testing.T) {
	response := errorResponse(429, "Daily trial limit reached", map[string]string{"X-Request-Id": "request-456"})
	if response.StatusCode != 429 {
		t.Fatalf("status = %d, want 429", response.StatusCode)
	}
	var body APIErrorResponse
	if err := json.Unmarshal([]byte(response.Body), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Code != "rate_limited" || body.RequestID != "request-456" || body.Retryable == nil || !*body.Retryable {
		t.Fatalf("body = %#v, want stable code, request id, and retryable=true", body)
	}
	if response.Headers["Retry-After"] == "" {
		t.Fatalf("expected Retry-After header on 429 response, got %#v", response.Headers)
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
	ddbClient = &fakeDynamoDB{
		count: "1",
		getItem: func(input *dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
			if strings.HasPrefix(aws.StringValue(input.Key["requestId"].S), "TRIAL#") {
				return &dynamodb.GetItemOutput{
					Item: map[string]*dynamodb.AttributeValue{
						"requestCount": {N: aws.String("1")},
					},
				}, nil
			}
			return &dynamodb.GetItemOutput{}, nil
		},
	}

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
	if resp.Headers["X-Trial-Limit"] != "3" || resp.Headers["X-Trial-Remaining"] != "2" {
		t.Fatalf("trial render headers = %#v, want X-Trial-Limit=3 and X-Trial-Remaining=2", resp.Headers)
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
	if quotaResp.Headers["Cache-Control"] != "no-store, max-age=0" {
		t.Fatalf("trial quota Cache-Control = %q, want %q", quotaResp.Headers["Cache-Control"], "no-store, max-age=0")
	}
	if quotaResp.Headers["X-Trial-Limit"] != "3" || quotaResp.Headers["X-Trial-Remaining"] != "2" {
		t.Fatalf("trial quota headers = %#v, want X-Trial-Limit=3 and X-Trial-Remaining=2", quotaResp.Headers)
	}
	var quotaBody map[string]int
	if err := json.Unmarshal([]byte(quotaResp.Body), &quotaBody); err != nil {
		t.Fatalf("decode trial quota response: %v", err)
	}
	if quotaBody["limit"] != 3 || quotaBody["remaining"] != 2 {
		t.Fatalf("trial quota body = %#v, want limit=3 and remaining=2", quotaBody)
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

func TestRenderDiagnosticsCapturesSSRFWarningsAndErrorDetails(t *testing.T) {
	d := newRenderDiagnostics()
	d.recordSSRFBlocked("http://169.254.169.254/latest/meta-data?token=secret")
	d.listen(&network.EventRequestWillBeSent{
		RequestID: "req-img-1",
		Request:   &network.Request{URL: "https://cdn.example.com/missing.png?sig=abc"},
	})
	d.listen(&network.EventLoadingFailed{
		RequestID: "req-img-1",
		Type:      network.ResourceTypeImage,
	})

	warnings := d.warnings()
	if len(warnings) != 2 {
		t.Fatalf("expected 2 warnings, got %#v", warnings)
	}
	if warnings[0].Code != "ssrf_blocked" || warnings[0].URL != "http://169.254.169.254/latest/meta-data" {
		t.Fatalf("unexpected SSRF warning: %#v", warnings[0])
	}
	if warnings[1].Code != "image_loading_failed" || warnings[1].URL != "https://cdn.example.com/missing.png" {
		t.Fatalf("unexpected image warning: %#v", warnings[1])
	}

	err := d.error()
	var rErr *renderError
	if !errors.As(err, &rErr) || rErr.Code != "image_loading_failed" {
		t.Fatalf("expected image_loading_failed renderError, got %#v", err)
	}
	details, ok := rErr.Details.(map[string]any)
	if !ok || len(details["ssrfBlockedUrls"].([]string)) != 1 || len(details["failedAssetUrls"].([]string)) != 1 {
		t.Fatalf("unexpected error details: %#v", rErr.Details)
	}
	_ = cdp.MonotonicTime{}
}

func TestRenderJSONResponseIncludesFileIDPageCountAndWarnings(t *testing.T) {
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
	ddbClient = &fakeDynamoDB{}
	fileStoreFactory = func() fileStore { return &countingFileStore{} }

	renderHTMLPDF = func(ctx context.Context, _ string, _ documentRenderOptions) ([]byte, error) {
		if d := renderDiagnosticsFromContext(ctx); d != nil {
			d.recordSSRFBlocked("http://127.0.0.1:8080/internal")
		}
		return []byte("%PDF-1.4\n%%EOF\n"), nil
	}
	putRenderedPDFObject = func(_, _ string, _ []byte) error { return nil }
	signRenderedPDFDownload = func(bucket, key string) (string, error) {
		return "https://signed.example.com/" + bucket + "/" + key, nil
	}

	req := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Body:       `{"version":"1","source":{"type":"html","content":"<h1>Hello</h1>"}}`,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-ax"},
		},
	}
	resp, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler err = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200; body=%s", resp.StatusCode, resp.Body)
	}
	var parsed Response
	if err := json.Unmarshal([]byte(resp.Body), &parsed); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if parsed.FileID == "" || parsed.FileID != "file_"+parsed.RequestID || resp.Headers["X-File-Id"] != parsed.FileID {
		t.Fatalf("fileId mismatch: body=%#v headers=%#v", parsed, resp.Headers)
	}
	if parsed.PageCount != 1 {
		t.Fatalf("pageCount = %d, want 1", parsed.PageCount)
	}
	if len(parsed.Warnings) != 1 || parsed.Warnings[0].Code != "ssrf_blocked" || parsed.Warnings[0].URL != "http://127.0.0.1:8080/internal" {
		t.Fatalf("warnings = %#v, want ssrf_blocked", parsed.Warnings)
	}
	if resp.Headers["X-Quota-Limit"] != "25" || resp.Headers["X-Quota-Remaining"] != "24" {
		t.Fatalf("expected X-Quota-Limit=25 and X-Quota-Remaining=24, got %#v", resp.Headers)
	}
}

func TestAccountQuotaEndpointAndRetryAfterHeaders(t *testing.T) {
	prevClient, prevTable, prevSecret := ddbClient, tableName, trialSecret
	t.Cleanup(func() {
		ddbClient, tableName, trialSecret = prevClient, prevTable, prevSecret
	})

	t.Setenv("FREE_MONTHLY_QUOTA", "25")
	t.Setenv("TRIAL_DAILY_LIMIT", "3")
	tableName = "renderpdf-usage"
	trialSecret = []byte("01234567890123456789012345678901")
	monthKey := "USER_QUOTA#customer-q#" + time.Now().UTC().Format("2006-01")
	ddbClient = &fakeDynamoDB{
		getItem: func(input *dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
			if aws.StringValue(input.Key["requestId"].S) == monthKey {
				return &dynamodb.GetItemOutput{Item: map[string]*dynamodb.AttributeValue{
					"used":  {N: aws.String("4")},
					"limit": {N: aws.String("25")},
				}}, nil
			}
			return &dynamodb.GetItemOutput{}, nil
		},
	}

	quotaResp, err := handler(context.Background(), events.APIGatewayProxyRequest{
		HTTPMethod: "GET",
		Resource:   quotaResource,
		Path:       quotaResource,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-q"},
		},
	})
	if err != nil {
		t.Fatalf("GET /quota err = %v", err)
	}
	if quotaResp.StatusCode != 200 {
		t.Fatalf("GET /quota status = %d, want 200; body=%s", quotaResp.StatusCode, quotaResp.Body)
	}
	if quotaResp.Headers["X-Quota-Limit"] != "25" || quotaResp.Headers["X-Quota-Remaining"] != "21" {
		t.Fatalf("GET /quota headers = %#v", quotaResp.Headers)
	}
	var qBody struct {
		Limit     int    `json:"limit"`
		Used      int    `json:"used"`
		Remaining int    `json:"remaining"`
		Period    string `json:"period"`
	}
	if err := json.Unmarshal([]byte(quotaResp.Body), &qBody); err != nil {
		t.Fatalf("decode /quota: %v", err)
	}
	if qBody.Limit != 25 || qBody.Used != 4 || qBody.Remaining != 21 || qBody.Period != time.Now().UTC().Format("2006-01") {
		t.Fatalf("unexpected /quota body: %#v", qBody)
	}

	// Trial 429 includes Retry-After
	ddbClient = &fakeDynamoDB{
		updateErrors: []error{
			nil,
			awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "trial limit reached", nil),
		},
	}
	trial429, err := handler(context.Background(), events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   trialResource,
		Path:       trialResource,
		Body:       `{"html":"<h1>Trial</h1>"}`,
		Headers:    map[string]string{"X-RenderPDF-Viewer-IP": "203.0.113.99"},
	})
	if err != nil {
		t.Fatalf("trial 429 err = %v", err)
	}
	if trial429.StatusCode != 429 || trial429.Headers["Retry-After"] == "" {
		t.Fatalf("expected 429 with Retry-After, got status=%d headers=%#v", trial429.StatusCode, trial429.Headers)
	}

	// Account 429 includes Retry-After + X-Quota-Limit/Remaining
	ddbClient = &fakeDynamoDB{
		updateErr: awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "quota exhausted", nil),
	}
	acc429, err := handler(context.Background(), events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Body:       `{"version":"1","source":{"type":"html","content":"<h1>Hi</h1>"}}`,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-q"},
		},
	})
	if err != nil {
		t.Fatalf("account 429 err = %v", err)
	}
	if acc429.StatusCode != 429 || acc429.Headers["Retry-After"] == "" || acc429.Headers["X-Quota-Limit"] != "25" || acc429.Headers["X-Quota-Remaining"] != "0" {
		t.Fatalf("expected 429 with Retry-After and quota headers, got status=%d headers=%#v", acc429.StatusCode, acc429.Headers)
	}
}

type idempotentMockDDB struct {
	mu    sync.Mutex
	items map[string]map[string]*dynamodb.AttributeValue
	used  int
}

func (m *idempotentMockDDB) GetItem(input *dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if item, ok := m.items[aws.StringValue(input.Key["requestId"].S)]; ok {
		return &dynamodb.GetItemOutput{Item: item}, nil
	}
	return &dynamodb.GetItemOutput{}, nil
}

func (m *idempotentMockDDB) PutItem(input *dynamodb.PutItemInput) (*dynamodb.PutItemOutput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := aws.StringValue(input.Item["requestId"].S)
	if aws.StringValue(input.ConditionExpression) != "" {
		if existing, ok := m.items[key]; ok {
			expUnix := int64(0)
			if existing["expiresAt"] != nil && existing["expiresAt"].N != nil {
				expUnix, _ = strconv.ParseInt(*existing["expiresAt"].N, 10, 64)
			}
			nowUnix := int64(0)
			if input.ExpressionAttributeValues != nil && input.ExpressionAttributeValues[":now"] != nil && input.ExpressionAttributeValues[":now"].N != nil {
				nowUnix, _ = strconv.ParseInt(*input.ExpressionAttributeValues[":now"].N, 10, 64)
			}
			if expUnix > nowUnix {
				return nil, awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "Conditional check failed", nil)
			}
		}
	}
	m.items[key] = input.Item
	return &dynamodb.PutItemOutput{}, nil
}

func (m *idempotentMockDDB) UpdateItem(input *dynamodb.UpdateItemInput) (*dynamodb.UpdateItemOutput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	reqID := aws.StringValue(input.Key["requestId"].S)
	if strings.HasPrefix(reqID, "IDEMPOTENCY#") {
		if item, ok := m.items[reqID]; ok && ddbAttrString(item, "status") == "in_progress" {
			item["status"] = &dynamodb.AttributeValue{S: aws.String("failed")}
			item["expiresAt"] = &dynamodb.AttributeValue{N: aws.String("0")}
		}
		return &dynamodb.UpdateItemOutput{}, nil
	}
	if input.ExpressionAttributeValues != nil && input.ExpressionAttributeValues[":minusOne"] != nil {
		if m.used > 0 {
			m.used--
		}
		return &dynamodb.UpdateItemOutput{}, nil
	}
	m.used++
	return &dynamodb.UpdateItemOutput{
		Attributes: map[string]*dynamodb.AttributeValue{
			"used":  {N: aws.String(strconv.Itoa(m.used))},
			"limit": {N: aws.String("25")},
		},
	}, nil
}

func TestIdempotencyKeyReplayAndConflict(t *testing.T) {
	prevClient, prevTable, prevBucket := ddbClient, tableName, bucketName
	prevFileFactory := fileStoreFactory
	prevRender, prevPut, prevSign := renderHTMLPDF, putRenderedPDFObject, signRenderedPDFDownload
	t.Cleanup(func() {
		ddbClient, tableName, bucketName = prevClient, prevTable, prevBucket
		fileStoreFactory = prevFileFactory
		renderHTMLPDF, putRenderedPDFObject, signRenderedPDFDownload = prevRender, prevPut, prevSign
	})

	t.Setenv("FREE_MONTHLY_QUOTA", "25")
	t.Setenv("DOCUMENT_STORE_TABLE_NAME", "renderpdf-docs")
	tableName = "renderpdf-usage"
	bucketName = "renderpdf-pdfs"
	mockDDB := &idempotentMockDDB{items: make(map[string]map[string]*dynamodb.AttributeValue)}
	ddbClient = mockDDB
	fileStoreFactory = func() fileStore { return &countingFileStore{} }

	renderCalls := 0
	renderHTMLPDF = func(_ context.Context, _ string, _ documentRenderOptions) ([]byte, error) {
		renderCalls++
		return []byte("%PDF-1.4\n%%EOF\n"), nil
	}
	putRenderedPDFObject = func(_, _ string, _ []byte) error { return nil }
	signRenderedPDFDownload = func(bucket, key string) (string, error) {
		return "https://signed.example.com/" + bucket + "/" + key, nil
	}

	reqBody := `{"version":"1","source":{"type":"html","content":"<h1>Idempotent</h1>"}}`
	req := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Headers:    map[string]string{"Idempotency-Key": "idem-render-1"},
		Body:       reqBody,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-idem"},
		},
	}

	first, err := handler(context.Background(), req)
	if err != nil || first.StatusCode != 200 {
		t.Fatalf("first render status=%d err=%v body=%s", first.StatusCode, err, first.Body)
	}
	if first.Headers["X-Idempotent-Replay"] != "" {
		t.Fatalf("first call must not set X-Idempotent-Replay")
	}

	second, err := handler(context.Background(), req)
	if err != nil || second.StatusCode != 200 {
		t.Fatalf("second render status=%d err=%v body=%s", second.StatusCode, err, second.Body)
	}
	if second.Headers["X-Idempotent-Replay"] != "true" {
		t.Fatalf("expected X-Idempotent-Replay: true, got %#v", second.Headers)
	}
	if second.Body != first.Body || renderCalls != 1 || mockDDB.used != 1 {
		t.Fatalf("idempotent replay re-executed work: renderCalls=%d used=%d first=%s second=%s", renderCalls, mockDDB.used, first.Body, second.Body)
	}

	// Different body with same key -> 409 conflict
	conflictReq := req
	conflictReq.Body = `{"version":"1","source":{"type":"html","content":"<h1>Different</h1>"}}`
	conflict, err := handler(context.Background(), conflictReq)
	if err != nil || conflict.StatusCode != 409 || !strings.Contains(conflict.Body, "idempotency_key_conflict") {
		t.Fatalf("expected 409 idempotency_key_conflict, got status=%d err=%v body=%s", conflict.StatusCode, err, conflict.Body)
	}

	// Invalid Idempotency-Key -> 400
	badKeyReq := req
	badKeyReq.Headers = map[string]string{"Idempotency-Key": strings.Repeat("x", 257)}
	badKeyResp, err := handler(context.Background(), badKeyReq)
	if err != nil || badKeyResp.StatusCode != 400 || !strings.Contains(badKeyResp.Body, "idempotency_key_invalid") {
		t.Fatalf("expected 400 idempotency_key_invalid, got status=%d err=%v body=%s", badKeyResp.StatusCode, err, badKeyResp.Body)
	}

	// POST /batches Idempotency-Key replay using a local stub DynamoDB HTTP endpoint
	transactCalls := 0
	ddbSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := r.Header.Get("X-Amz-Target")
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		if strings.Contains(target, "TransactWriteItems") {
			transactCalls++
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer ddbSrv.Close()
	sessLocal, _ := session.NewSession(&aws.Config{
		Endpoint:    aws.String(ddbSrv.URL),
		Region:      aws.String("us-east-1"),
		Credentials: credentials.NewStaticCredentials("test", "test", ""),
	})
	dbLocal := dynamodb.New(sessLocal)
	batchReq := events.APIGatewayProxyRequest{
		HTTPMethod: http.MethodPost,
		Path:       batchResource,
		Headers:    map[string]string{"Idempotency-Key": "idem-batch-1"},
		Body:       `{"version":"1","items":[{"definition":{"version":"1","source":{"type":"html","content":"<p>1</p>"}}}]}`,
	}
	b1 := createBatch(context.Background(), batchReq, "customer-idem", map[string]string{"Content-Type": "application/json"}, dbLocal)
	if b1.StatusCode != http.StatusCreated {
		t.Fatalf("first batch status=%d body=%s", b1.StatusCode, b1.Body)
	}
	b2 := createBatch(context.Background(), batchReq, "customer-idem", map[string]string{"Content-Type": "application/json"}, dbLocal)
	if b2.StatusCode != http.StatusCreated || b2.Headers["X-Idempotent-Replay"] != "true" || b2.Body != b1.Body || transactCalls != 1 {
		t.Fatalf("batch replay failed: status=%d headers=%#v transactCalls=%d b1=%s b2=%s", b2.StatusCode, b2.Headers, transactCalls, b1.Body, b2.Body)
	}
}

func TestIdempotencyHardeningZeroRetentionFormatLockAndBinaryS3(t *testing.T) {
	prevClient, prevTable, prevBucket := ddbClient, tableName, bucketName
	prevFileFactory := fileStoreFactory
	prevRender, prevPut, prevGet, prevSign := renderHTMLPDF, putRenderedPDFObject, getRenderedPDFObject, signRenderedPDFDownload
	t.Cleanup(func() {
		ddbClient, tableName, bucketName = prevClient, prevTable, prevBucket
		fileStoreFactory = prevFileFactory
		renderHTMLPDF, putRenderedPDFObject, getRenderedPDFObject, signRenderedPDFDownload = prevRender, prevPut, prevGet, prevSign
	})

	t.Setenv("FREE_MONTHLY_QUOTA", "25")
	tableName = "renderpdf-usage"
	bucketName = "renderpdf-pdfs"
	mockDDB := &idempotentMockDDB{items: make(map[string]map[string]*dynamodb.AttributeValue)}
	ddbClient = mockDDB
	fileStoreFactory = func() fileStore { return &countingFileStore{} }

	s3Objects := make(map[string][]byte)
	var s3Mu sync.Mutex
	putRenderedPDFObject = func(bucket, key string, pdfBytes []byte) error {
		s3Mu.Lock()
		defer s3Mu.Unlock()
		s3Objects[bucket+"/"+key] = append([]byte(nil), pdfBytes...)
		return nil
	}
	getRenderedPDFObject = func(bucket, key string) ([]byte, error) {
		s3Mu.Lock()
		defer s3Mu.Unlock()
		if b, ok := s3Objects[bucket+"/"+key]; ok {
			return b, nil
		}
		return nil, errors.New("not found")
	}
	signRenderedPDFDownload = func(bucket, key string) (string, error) {
		return "https://signed.example.com/" + bucket + "/" + key, nil
	}

	countIdempotencyItems := func() int {
		mockDDB.mu.Lock()
		defer mockDDB.mu.Unlock()
		n := 0
		for k := range mockDDB.items {
			if strings.HasPrefix(k, "IDEMPOTENCY#") {
				n++
			}
		}
		return n
	}

	// 1. zeroRetention + Idempotency-Key -> 422 and nothing stored in DynamoDB
	renderCalls := 0
	renderHTMLPDF = func(_ context.Context, _ string, _ documentRenderOptions) ([]byte, error) {
		renderCalls++
		return []byte("%PDF-1.4\n%%EOF\n"), nil
	}
	zrReq := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Headers:    map[string]string{"Idempotency-Key": "idem-zr-1"},
		Body:       `{"version":"1","source":{"type":"html","content":"<p>ZR</p>"},"options":{"zeroRetention":true}}`,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-zr"},
		},
	}
	zrResp, err := handler(context.Background(), zrReq)
	if err != nil || zrResp.StatusCode != 422 || !strings.Contains(zrResp.Body, "zero_retention_idempotency_unsupported") {
		t.Fatalf("expected 422 zero_retention_idempotency_unsupported, got status=%d err=%v body=%s", zrResp.StatusCode, err, zrResp.Body)
	}
	if countIdempotencyItems() != 0 || renderCalls != 0 {
		t.Fatalf("expected 0 IDEMPOTENCY records and 0 renders for rejected zeroRetention+Idempotency-Key, got items=%d renderCalls=%d", countIdempotencyItems(), renderCalls)
	}

	// zeroRetention without Idempotency-Key succeeds and still writes no idempotency record
	zrNoKeyReq := zrReq
	zrNoKeyReq.Headers = nil
	zrOK, err := handler(context.Background(), zrNoKeyReq)
	if err != nil || zrOK.StatusCode != 200 || countIdempotencyItems() != 0 {
		t.Fatalf("expected 200 and 0 DDB idempotency items for zeroRetention without key, got status=%d err=%v items=%d", zrOK.StatusCode, err, countIdempotencyItems())
	}

	// 2. Large binary PDF (>400KB) caches S3 pointer, replays from S3, and rejects Accept format mismatch
	largePDF := append([]byte("%PDF-1.4\n"), bytes.Repeat([]byte("A"), 450*1024)...)
	largePDF = append(largePDF, []byte("\n%%EOF\n")...)
	renderCalls = 0
	mockDDB.used = 0
	renderHTMLPDF = func(_ context.Context, _ string, _ documentRenderOptions) ([]byte, error) {
		renderCalls++
		return largePDF, nil
	}

	binReq := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Headers:    map[string]string{"Idempotency-Key": "idem-bin-1", "Accept": "application/pdf"},
		Body:       `{"version":"1","source":{"type":"html","content":"<p>Big</p>"}}`,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-bin"},
		},
	}
	binFirst, err := handler(context.Background(), binReq)
	if err != nil || binFirst.StatusCode != 200 || !binFirst.IsBase64Encoded {
		t.Fatalf("binary render failed: status=%d err=%v b64=%v", binFirst.StatusCode, err, binFirst.IsBase64Encoded)
	}

	// Verify DynamoDB record stores S3 pointer, not inline responseBody
	idemRecKey := aws.StringValue(idempotencyRecordKey("customer-bin", "POST:/api/v1/render", "idem-bin-1")["requestId"].S)
	stored := mockDDB.items[idemRecKey]
	if stored == nil || ddbAttrString(stored, "responseObjectKey") == "" || ddbAttrString(stored, "responseBody") != "" {
		t.Fatalf("expected S3 pointer without inline responseBody, got %#v", stored)
	}

	binReplay, err := handler(context.Background(), binReq)
	if err != nil || binReplay.StatusCode != 200 || !binReplay.IsBase64Encoded || binReplay.Headers["X-Idempotent-Replay"] != "true" {
		t.Fatalf("binary replay failed: status=%d err=%v headers=%#v", binReplay.StatusCode, err, binReplay.Headers)
	}
	if binReplay.Body != binFirst.Body || renderCalls != 1 || mockDDB.used != 1 {
		t.Fatalf("binary replay mismatch or re-executed: renderCalls=%d used=%d", renderCalls, mockDDB.used)
	}

	// Same body + same Idempotency-Key with Accept: application/json -> 409 idempotency_key_conflict
	jsonMismatchReq := binReq
	jsonMismatchReq.Headers = map[string]string{"Idempotency-Key": "idem-bin-1", "Accept": "application/json"}
	mismatchResp, err := handler(context.Background(), jsonMismatchReq)
	if err != nil || mismatchResp.StatusCode != 409 || !strings.Contains(mismatchResp.Body, "idempotency_key_conflict") {
		t.Fatalf("expected 409 idempotency_key_conflict on Accept mismatch, got status=%d err=%v body=%s", mismatchResp.StatusCode, err, mismatchResp.Body)
	}

	// 3. In-flight concurrency lock -> 409 idempotency_in_progress with Retry-After: 2
	startedCh := make(chan struct{})
	releaseRenderCh := make(chan struct{})
	renderHTMLPDF = func(_ context.Context, _ string, _ documentRenderOptions) ([]byte, error) {
		close(startedCh)
		<-releaseRenderCh
		return []byte("%PDF-1.4\n%%EOF\n"), nil
	}
	concReq := events.APIGatewayProxyRequest{
		HTTPMethod: "POST",
		Resource:   renderResource,
		Path:       renderResource,
		Headers:    map[string]string{"Idempotency-Key": "idem-conc-1"},
		Body:       `{"version":"1","source":{"type":"html","content":"<p>Conc</p>"}}`,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-conc"},
		},
	}
	firstDone := make(chan events.APIGatewayProxyResponse, 1)
	go func() {
		r, _ := handler(context.Background(), concReq)
		firstDone <- r
	}()
	<-startedCh
	inFlightResp, err := handler(context.Background(), concReq)
	if err != nil || inFlightResp.StatusCode != 409 || !strings.Contains(inFlightResp.Body, "idempotency_in_progress") || inFlightResp.Headers["Retry-After"] != "2" {
		t.Fatalf("expected 409 idempotency_in_progress with Retry-After: 2, got status=%d err=%v headers=%#v body=%s", inFlightResp.StatusCode, err, inFlightResp.Headers, inFlightResp.Body)
	}
	close(releaseRenderCh)
	if r1 := <-firstDone; r1.StatusCode != 200 {
		t.Fatalf("in-flight primary request failed: status=%d body=%s", r1.StatusCode, r1.Body)
	}

	// 4. Failed render releases lock so retry with the same key succeeds
	failAttempt := 0
	renderHTMLPDF = func(_ context.Context, _ string, _ documentRenderOptions) ([]byte, error) {
		failAttempt++
		if failAttempt == 1 {
			return nil, &renderError{Code: "navigation_failed", Message: "boom", Status: 422}
		}
		return []byte("%PDF-1.4\n%%EOF\n"), nil
	}
	retryReq := concReq
	retryReq.Headers = map[string]string{"Idempotency-Key": "idem-retry-after-fail"}
	failedResp, err := handler(context.Background(), retryReq)
	if err != nil || failedResp.StatusCode != 422 {
		t.Fatalf("expected first failed render 422, got status=%d err=%v", failedResp.StatusCode, err)
	}
	recoveredResp, err := handler(context.Background(), retryReq)
	if err != nil || recoveredResp.StatusCode != 200 {
		t.Fatalf("expected retry after failure to succeed with 200, got status=%d err=%v body=%s", recoveredResp.StatusCode, err, recoveredResp.Body)
	}
}

