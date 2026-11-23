package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/google/uuid"
	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

const (
	quotaResource          = "/api/v1/quota"
	dashboardQuotaResource = "/api/v1/dashboard/quota"
)

type Request struct {
	HTML          string                 `json:"html"`
	WebhookURL    string                 `json:"webhookUrl,omitempty"`
	WebhookSecret string                 `json:"webhookSecret,omitempty"`
	Options       *documentRenderOptions `json:"options,omitempty"`
}

type URLRequest struct {
	URL           string                 `json:"url"`
	Headers       map[string]string      `json:"headers,omitempty"`
	Cookies       []urlCookie            `json:"cookies,omitempty"`
	WebhookURL    string                 `json:"webhookUrl,omitempty"`
	WebhookSecret string                 `json:"webhookSecret,omitempty"`
	Options       *documentRenderOptions `json:"options,omitempty"`
}

type Response struct {
	RequestID     string          `json:"requestId"`
	FileID        string          `json:"fileId,omitempty"`
	URL           string          `json:"url,omitempty"`
	Size          int64           `json:"size"`
	PageCount     int             `json:"pageCount,omitempty"`
	Data          string          `json:"data,omitempty"`
	ZeroRetention bool            `json:"zeroRetention,omitempty"`
	Warnings      []renderWarning `json:"warnings,omitempty"`
}

var (
	renderHTMLPDF        = generatePDFWithOptions
	putRenderedPDFObject = func(bucket, key string, pdfBytes []byte) error {
		_, err := s3Client.PutObject(&s3.PutObjectInput{
			Bucket: aws.String(bucket),
			Key:    aws.String(key),
			Body:   bytes.NewReader(pdfBytes),
		})
		return err
	}
	signRenderedPDFDownload = presignPDFDownload
)

func addDeprecationHeaders(headers map[string]string, successorPath string) {
	if headers == nil {
		return
	}
	headers["Deprecation"] = "true"
	headers["Sunset"] = "Wed, 30 Dec 2026 23:59:59 GMT"
	headers["Link"] = fmt.Sprintf("<%s>; rel=\"successor-version\"", successorPath)
}

func isAccountQuotaRequest(request events.APIGatewayProxyRequest) bool {
	p := strings.TrimSuffix(request.Path, "/")
	if p == "" {
		p = strings.TrimSuffix(request.Resource, "/")
	}
	return p == quotaResource || p == dashboardQuotaResource
}

func countPDFPages(pdfBytes []byte) int {
	if len(pdfBytes) == 0 {
		return 0
	}
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	if count, err := pdfapi.PageCount(bytes.NewReader(pdfBytes), conf); err == nil && count > 0 {
		return count
	}
	if bytes.HasPrefix(pdfBytes, []byte("%PDF-")) {
		return 1
	}
	return 0
}

func handler(ctx context.Context, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	requestID := uuid.NewString()
	corsHeaders := map[string]string{
		"Content-Type":                  "application/json",
		"Access-Control-Allow-Origin":   "*",
		"Access-Control-Allow-Headers":  "Content-Type,Accept,X-Amz-Date,Authorization,X-Amz-Security-Token,Idempotency-Key",
		"Access-Control-Allow-Methods":  "GET,POST,OPTIONS",
		"Access-Control-Expose-Headers": "X-Request-Id,X-Trial-Limit,X-Trial-Remaining,X-Quota-Limit,X-Quota-Remaining,Retry-After,X-File-Id,X-Retention-Policy,X-Idempotent-Replay",
		"X-Request-Id":                  requestID,
	}
	if request.HTTPMethod == "OPTIONS" {
		return events.APIGatewayProxyResponse{StatusCode: 200, Headers: corsHeaders}, nil
	}
	if isSanctionedCountry(requestCountry(request)) {
		return errorResponse(403, "Access from this region is restricted in compliance with international sanctions.", corsHeaders), nil
	}
	if trialModeOnly() && !isTrialRequest(request) && !isTrialQuotaRequest(request) {
		return errorResponse(404, "Not found", corsHeaders), nil
	}
	if isAccountQuotaRequest(request) {
		if request.HTTPMethod != "GET" {
			return errorResponse(405, "Method not allowed", corsHeaders), nil
		}
		customerID := authorizerValue(request, "userId")
		if customerID == "" {
			return errorResponse(401, "Authentication is required", corsHeaders), nil
		}
		corsHeaders["Cache-Control"] = "no-store, max-age=0"
		quota, err := currentAccountQuota(customerID, time.Now().UTC())
		if err != nil {
			fmt.Printf("Account quota lookup failed: %v\n", err)
			return errorResponse(503, "Account quota is temporarily unavailable", corsHeaders), nil
		}
		setAccountQuotaHeaders(quota, corsHeaders)
		return jsonResponse(200, map[string]any{
			"limit":     quota.Limit,
			"used":      quota.Used,
			"remaining": quota.Remaining,
			"period":    quota.Period,
		}, corsHeaders), nil
	}
	if isTemplateRequest(request) {
		return handleTemplateRequest(ctx, request, corsHeaders, templateStoreFactory()), nil
	}
	if isSourceRequest(request) {
		return handleSourceRequest(ctx, request, corsHeaders, sourceStoreFactory()), nil
	}
	if isFileRequest(request) {
		return handleFileRequest(ctx, request, corsHeaders, fileStoreFactory()), nil
	}
	if isBatchRequest(request) {
		return handleBatchRequest(ctx, request, corsHeaders), nil
	}
	if isMergeRequest(request) {
		return handleMergeRequest(ctx, request, corsHeaders), nil
	}
	if isTrialQuotaRequest(request) {
		corsHeaders["Cache-Control"] = "no-store, max-age=0"
		quota, err := currentTrialQuota(trialViewerIP(request), time.Now().UTC())
		if err != nil {
			fmt.Printf("Trial quota lookup failed: %v\n", err)
			return errorResponse(503, "Trial quota is temporarily unavailable", corsHeaders), nil
		}
		corsHeaders["X-Trial-Limit"] = fmt.Sprintf("%d", quota.Limit)
		corsHeaders["X-Trial-Remaining"] = fmt.Sprintf("%d", quota.Remaining)
		return jsonResponse(200, map[string]int{"limit": quota.Limit, "remaining": quota.Remaining}, corsHeaders), nil
	}
	if isPackageUploadRequest(request) {
		addDeprecationHeaders(corsHeaders, fileUploadResource)
		if request.HTTPMethod != "POST" || trialModeOnly() {
			return errorResponse(404, "Not found", corsHeaders), nil
		}
		response, err := createPackageUpload(authorizerValue(request, "userId"))
		if err != nil {
			fmt.Printf("Package upload initialization failed: %v\n", err)
			return errorResponse(503, "Package uploads are temporarily unavailable", corsHeaders), nil
		}
		return jsonResponse(200, response, corsHeaders), nil
	}
	isTrial := isTrialRequest(request)
	normalized, normalizeErr := normalizeRenderRequest(ctx, request, authorizerValue(request, "userId"))
	if normalizeErr != nil {
		return renderErrorResponse(normalizeErr, corsHeaders), nil
	}
	isURLRender := normalized.Kind == renderKindURL
	isPackageRender := normalized.Kind == renderKindUpload
	isTemplateRender := normalized.Kind == renderKindTemplate
	isDocumentRender := normalized.Kind == renderKindDocument
	if (isCanonicalRenderRequest(request) || isDocumentRender || isTemplateRender || isURLRender || isPackageRender) && request.HTTPMethod != "POST" {
		return errorResponse(404, "Not found", corsHeaders), nil
	}
	plan := "api"
	if isTrial {
		plan = "trial"
	}
	startedAt := time.Now()
	analytics := requestAnalytics{
		RequestID:  requestID,
		Plan:       plan,
		Status:     "error",
		ErrorType:  "unknown",
		HTMLBytes:  int64(len(normalized.Body)),
		Country:    requestCountry(request),
		CustomerID: authorizerValue(request, "userId"),
		APIKeyID:   authorizerValue(request, "apiKeyId"),
	}
	defer func() {
		analytics.DurationMs = maxInt64(1, time.Since(startedAt).Milliseconds())
		trackUsage(ctx, analytics)
	}()

	if trialModeOnly() && !isTrial {
		analytics.ErrorType = "not_found"
		return errorResponse(404, "Not found", corsHeaders), nil
	}
	if isTrial && len(request.Body) > (2*trialMaxHTMLBytes())+64*1024 {
		analytics.ErrorType = "validation"
		return errorResponse(413, "HTML exceeds the trial size limit", corsHeaders), nil
	}
	if isTemplateRender && analytics.CustomerID == "" {
		analytics.ErrorType = "unauthorized"
		return errorResponse(401, "Authentication is required", corsHeaders), nil
	}

	var idemKey string
	if !isTrial && analytics.CustomerID != "" && request.HTTPMethod == "POST" {
		var idemErr *renderError
		idemKey, idemErr = extractIdempotencyKey(request.Headers)
		if idemErr != nil {
			analytics.ErrorType = "validation"
			return renderErrorResponse(idemErr, corsHeaders), nil
		}
	}

	var html, renderURL, packageURL, webhookURL, webhookSecret, displayName string
	var documentOptions documentRenderOptions
	var packageCleanup func()
	defer func() {
		if packageCleanup != nil {
			packageCleanup()
		}
	}()
	if isDocumentRender {
		documentHTML, documentRequest, err := resolveDocumentRenderHTML(normalized.Body)
		if err != nil {
			analytics.ErrorType = "validation"
			return renderErrorResponse(err, corsHeaders), nil
		}
		html = documentHTML
		documentOptions = documentRequest.Options
		displayName = documentRequest.Label
		webhookURL, webhookSecret = documentRequest.WebhookURL, documentRequest.WebhookSecret
		analytics.HTMLBytes = int64(len(html))
		analytics.SourceType = "document_json"
		if documentRequest.Source != nil {
			analytics.SourceType = documentRequest.Source.Type
		}
		if normalized.Canonical {
			analytics.SourceType = normalized.SourceType
		}
		analytics.SourceMode = "inline"
		analytics.SourceVersion = documentRequest.Version
		analytics.SourceBytes = normalizedDocumentDefinitionBytes(documentRequest)
	} else if isTemplateRender {
		resolvedHTML, templateRequest, err := resolveTemplateRenderHTML(ctx, templateStoreFactory(), analytics.CustomerID, normalized.Body)
		if err != nil {
			analytics.ErrorType = "validation"
			return templateRenderErrorResponse(err, corsHeaders), nil
		}
		html = resolvedHTML
		if templateRequest.Options != nil {
			documentOptions = *templateRequest.Options
		}
		displayName = templateRequest.Label
		webhookURL, webhookSecret = templateRequest.WebhookURL, templateRequest.WebhookSecret
		analytics.HTMLBytes = int64(len(html))
	} else if isURLRender {
		var req URLRequest
		if err := json.Unmarshal([]byte(normalized.Body), &req); err != nil {
			analytics.ErrorType = "validation"
			return errorResponse(400, "Invalid request", corsHeaders), nil
		}
		validatedURL, err := validateRenderURL(req.URL)
		if err != nil {
			analytics.ErrorType = "validation"
			return errorResponse(400, err.Error(), corsHeaders), nil
		}
		scrubbedHeaders, err := validateAndScrubURLHeaders(validatedURL, req.Headers)
		if err != nil {
			analytics.ErrorType = "validation"
			return renderErrorResponse(err, corsHeaders), nil
		}
		validatedCookies, err := validateURLCookies(validatedURL, req.Cookies)
		if err != nil {
			analytics.ErrorType = "validation"
			return renderErrorResponse(err, corsHeaders), nil
		}
		if req.Options != nil {
			if err := validateDocumentOptions(req.Options); err != nil {
				analytics.ErrorType = "validation"
				return renderErrorResponse(err, corsHeaders), nil
			}
			documentOptions = *req.Options
		}
		documentOptions.CustomHeaders = scrubbedHeaders
		documentOptions.CustomCookies = validatedCookies
		renderURL = validatedURL
		webhookURL = req.WebhookURL
		webhookSecret = req.WebhookSecret
		analytics.HTMLBytes = int64(len(renderURL))
	} else if isPackageRender {
		var req packageRenderRequest
		if err := json.Unmarshal([]byte(normalized.Body), &req); err != nil {
			analytics.ErrorType = "validation"
			return errorResponse(400, "Invalid request", corsHeaders), nil
		}
		preparedURL, packageBytes, cleanup, err := preparePackage(ctx, analytics.CustomerID, req.UploadID, req.Entrypoint)
		if err != nil {
			analytics.ErrorType = "validation"
			return errorResponse(422, err.Error(), corsHeaders), nil
		}
		packageURL, packageCleanup = preparedURL, cleanup
		if req.Options != nil {
			if err := validateDocumentOptions(req.Options); err != nil {
				analytics.ErrorType = "validation"
				return renderErrorResponse(err, corsHeaders), nil
			}
			documentOptions = *req.Options
		}
		webhookURL, webhookSecret = req.WebhookURL, req.WebhookSecret
		analytics.HTMLBytes = packageBytes
	} else {
		var req Request
		if err := json.Unmarshal([]byte(normalized.Body), &req); err != nil {
			analytics.ErrorType = "validation"
			return errorResponse(400, "Invalid request", corsHeaders), nil
		}
		if strings.TrimSpace(req.HTML) == "" {
			analytics.ErrorType = "validation"
			return errorResponse(400, "HTML is required", corsHeaders), nil
		}
		if isTrial && len(req.HTML) > trialMaxHTMLBytes() {
			analytics.ErrorType = "validation"
			return errorResponse(413, "HTML exceeds the trial size limit", corsHeaders), nil
		}
		if req.Options != nil {
			if err := validateDocumentOptions(req.Options); err != nil {
				analytics.ErrorType = "validation"
				return renderErrorResponse(err, corsHeaders), nil
			}
			documentOptions = *req.Options
		}
		html = req.HTML
		webhookURL = req.WebhookURL
		webhookSecret = req.WebhookSecret
		analytics.HTMLBytes = int64(len(html))
	}
	if normalized.Canonical && !isDocumentRender {
		analytics.SourceType = normalized.SourceType
		analytics.SourceMode = normalized.SourceMode
		analytics.SourceVersion = normalized.SourceVersion
		analytics.SourceBytes = int64(len(normalized.Body))
	}
	if documentOptions.isZeroRetention() && webhookURL != "" {
		analytics.ErrorType = "validation"
		return errorResponseWithCode(422, "zero_retention_webhook_unsupported", "webhooks are not supported when options.zeroRetention is true because no download URL is persisted", corsHeaders), nil
	}
	if documentOptions.isZeroRetention() && idemKey != "" {
		analytics.ErrorType = "validation"
		return errorResponseWithCode(422, "zero_retention_idempotency_unsupported", "Idempotency-Key is not supported when options.zeroRetention is true because no response data is persisted", corsHeaders), nil
	}
	if webhookURL != "" {
		if isTrial {
			analytics.ErrorType = "validation"
			return errorResponse(400, "Webhooks require an authenticated request", corsHeaders), nil
		}
		validatedWebhookURL, err := validateWebhookURL(webhookURL)
		if err != nil {
			analytics.ErrorType = "validation"
			return errorResponse(400, err.Error(), corsHeaders), nil
		}
		webhookURL = validatedWebhookURL
	}
	binaryResponse := wantsBinaryPDFResponse(request, documentOptions)
	var idemPayload string
	var idemLocked bool
	if !isTrial && analytics.CustomerID != "" && request.HTTPMethod == "POST" && idemKey != "" {
		format := "json"
		if binaryResponse {
			format = "binary"
		}
		idemPayload = format + "\n" + request.Body
		if replayed, handled, acquired := claimIdempotencyKey(analytics.CustomerID, "POST:/api/v1/render", idemKey, idemPayload, corsHeaders, time.Now().UTC()); handled {
			if replayed.StatusCode >= 200 && replayed.StatusCode < 300 {
				analytics.Status = "success"
				analytics.ErrorType = ""
			} else {
				analytics.ErrorType = "validation"
			}
			return *replayed, nil
		} else if acquired {
			idemLocked = true
			defer func() {
				if idemLocked {
					releaseIdempotencyLock(analytics.CustomerID, "POST:/api/v1/render", idemKey)
				}
			}()
		}
	}
	var quota *trialQuota
	if isTrial {
		slot, err := acquireTrialSlot(requestID, time.Now().UTC())
		if err != nil {
			if err == errTrialCapacityReached {
				analytics.ErrorType = "capacity"
				corsHeaders["Retry-After"] = "10"
				return errorResponse(503, "Trial capacity is busy; try again shortly", corsHeaders), nil
			}
			analytics.ErrorType = "quota"
			fmt.Printf("Trial capacity error: %v\n", err)
			return errorResponse(503, "Trial service temporarily unavailable", corsHeaders), nil
		}
		defer releaseTrialSlot(slot)

		quota, err = consumeTrialQuota(trialViewerIP(request), time.Now().UTC())
		if err != nil {
			if err == errTrialLimitExceeded {
				analytics.ErrorType = "rate_limit"
				corsHeaders["X-Trial-Limit"] = fmt.Sprintf("%d", trialDailyLimit())
				corsHeaders["X-Trial-Remaining"] = "0"
				corsHeaders["Retry-After"] = fmt.Sprintf("%d", secondsUntilUTCMidnight(time.Now().UTC()))
				return errorResponse(429, "Daily trial limit reached", corsHeaders), nil
			}
			analytics.ErrorType = "quota"
			fmt.Printf("Trial quota error: %v\n", err)
			return errorResponse(503, "Trial service temporarily unavailable", corsHeaders), nil
		}
		corsHeaders["X-Trial-Limit"] = fmt.Sprintf("%d", quota.Limit)
		corsHeaders["X-Trial-Remaining"] = fmt.Sprintf("%d", quota.Remaining)
	}
	var reservedAccountQuota *accountQuota
	if !isTrial {
		now := time.Now().UTC()
		customerEmail := authorizerValue(request, "email")
		reservedQuota, quotaErr := reserveAccountQuota(analytics.CustomerID, customerEmail, now)
		if quotaErr != nil {
			if errors.Is(quotaErr, errAccountQuotaExceeded) {
				analytics.ErrorType = "rate_limit"
				setAccountQuotaExceededHeaders(analytics.CustomerID, corsHeaders, now)
				return errorResponse(429, "Monthly PDF quota reached", corsHeaders), nil
			}
			analytics.ErrorType = "quota"
			fmt.Printf("Account quota error: %v\n", quotaErr)
			return errorResponse(503, "Account quota is temporarily unavailable", corsHeaders), nil
		}
		reservedAccountQuota = reservedQuota
		setAccountQuotaHeaders(reservedAccountQuota, corsHeaders)
	}

	renderStartedAt := time.Now()
	diag := newRenderDiagnostics()
	renderCtx := withRenderDiagnostics(ctx, diag)
	var pdfBytes []byte
	var err error
	if isDocumentRender {
		pdfBytes, err = generateDocumentPDFWithOptions(renderCtx, html, documentOptions)
	} else if isURLRender {
		pdfBytes, err = generatePDFURLWithDocumentOptions(renderCtx, renderURL, documentOptions)
	} else if isPackageRender {
		pdfBytes, err = generatePDFURLWithDocumentOptions(renderCtx, packageURL, documentOptions)
	} else {
		html = injectPrintCSS(html)
		html = rewriteTfoot(html)
		html = transformBarcodes(html)
		pdfBytes, err = renderHTMLPDF(renderCtx, html, documentOptions)
	}
	analytics.RenderMs = maxInt64(1, time.Since(renderStartedAt).Milliseconds())
	if err != nil {
		fmt.Printf("PDF generation failed for %s: %v\n", requestID, err)
		if renderErr, ok := err.(*renderError); ok {
			analytics.ErrorType = renderErr.Code
			if renderErr.Status == 504 {
				analytics.Status = "timeout"
			}
		} else if errors.Is(err, context.DeadlineExceeded) {
			analytics.Status = "timeout"
			analytics.ErrorType = "render_timeout"
		} else {
			analytics.ErrorType = "render"
		}
		refundTrialQuota(quota)
		refundAccountQuota(reservedAccountQuota)
		restoreTrialRemainingHeader(quota, corsHeaders)
		restoreAccountQuotaRemainingHeader(reservedAccountQuota, corsHeaders)
		return renderErrorResponse(err, corsHeaders), nil
	}

	if displayName == "" {
		displayName = normalized.Label
	}
	pageCount := countPDFPages(pdfBytes)
	warnings := diag.warnings()

	if documentOptions.isZeroRetention() {
		analytics.Status = "success"
		analytics.ErrorType = ""
		analytics.PDFBytes = int64(len(pdfBytes))
		corsHeaders["X-Retention-Policy"] = "zero-retention"
		if binaryResponse {
			return binaryPDFResponse(pdfBytes, displayName, "", corsHeaders), nil
		}
		resp := Response{
			RequestID:     requestID,
			Size:          int64(len(pdfBytes)),
			PageCount:     pageCount,
			Data:          base64.StdEncoding.EncodeToString(pdfBytes),
			ZeroRetention: true,
			Warnings:      warnings,
		}
		return jsonResponse(200, resp, corsHeaders), nil
	}

	ownerKeyID := analytics.CustomerID
	if isTrial {
		ownerKeyID = ""
	}
	key := renderedPDFObjectKey(ownerKeyID, requestID)
	if !isTrial {
		if err := ensurePrivateFileStorage(ctx, analytics.CustomerID, int64(len(pdfBytes))); err != nil {
			refundTrialQuota(quota)
			refundAccountQuota(reservedAccountQuota)
			restoreTrialRemainingHeader(quota, corsHeaders)
			restoreAccountQuotaRemainingHeader(reservedAccountQuota, corsHeaders)
			return renderErrorResponse(err, corsHeaders), nil
		}
	}
	err = putRenderedPDFObject(bucketName, key, pdfBytes)
	if err != nil {
		analytics.ErrorType = "storage"
		fmt.Printf("PDF storage failed for %s: %v\n", requestID, err)
		refundTrialQuota(quota)
		refundAccountQuota(reservedAccountQuota)
		restoreTrialRemainingHeader(quota, corsHeaders)
		restoreAccountQuotaRemainingHeader(reservedAccountQuota, corsHeaders)
		return errorResponseWithCode(500, "storage_failed", "PDF storage is temporarily unavailable", corsHeaders), nil
	}

	url, err := signRenderedPDFDownload(bucketName, key)
	if err != nil {
		analytics.ErrorType = "storage"
		fmt.Printf("PDF download URL signing failed for %s: %v\n", requestID, err)
		return errorResponseWithCode(503, "download_url_unavailable", "PDF download URL is temporarily unavailable", corsHeaders), nil
	}
	fileID := ""
	if !isTrial {
		fileID = "file_" + requestID
		corsHeaders["X-File-Id"] = fileID
		checksum := sha256.Sum256(pdfBytes)
		expiresAt := time.Now().UTC().Add(maxPDFRetentionDays * 24 * time.Hour)
		if err := fileStoreFactory().Create(ctx, storedFile{ID: fileID, Kind: "rendered_pdf", ContentType: "application/pdf", SizeBytes: int64(len(pdfBytes)), Checksum: "sha256:" + hex.EncodeToString(checksum[:]), DisplayName: displayName, RetentionExpiresAt: &expiresAt, Origin: map[string]string{"requestId": requestID}, OwnerID: analytics.CustomerID, Bucket: bucketName, ObjectKey: key, CreatedAt: time.Now().UTC()}); err != nil {
			fmt.Printf("PDF file metadata write skipped for %s: %v\n", requestID, err)
		}
	}
	analytics.Status = "success"
	analytics.ErrorType = ""
	analytics.PDFBytes = int64(len(pdfBytes))

	resp := Response{
		RequestID: requestID,
		FileID:    fileID,
		URL:       url,
		Size:      int64(len(pdfBytes)),
		PageCount: pageCount,
		Warnings:  warnings,
	}
	if webhookURL != "" {
		if err := enqueueWebhook(ctx, webhookEvent{
			ID: requestID, URL: webhookURL, Secret: webhookSecret, PDFURL: url,
			PDFSize: int64(len(pdfBytes)), CreatedAt: time.Now().UTC(),
		}); err != nil {
			// The PDF is successfully stored and should remain available even when
			// the asynchronous notification path is temporarily unavailable.
			fmt.Printf("Webhook enqueue failed for %s: %v\n", requestID, err)
		}
	}

	if binaryResponse {
		out := binaryPDFResponse(pdfBytes, displayName, fileID, corsHeaders)
		if saveIdempotencyResponseWithObject(analytics.CustomerID, "POST:/api/v1/render", idemKey, idemPayload, out, bucketName, key, time.Now().UTC()) {
			idemLocked = false
		}
		return out, nil
	}
	out := jsonResponse(200, resp, corsHeaders)
	if saveIdempotencyResponseWithObject(analytics.CustomerID, "POST:/api/v1/render", idemKey, idemPayload, out, "", "", time.Now().UTC()) {
		idemLocked = false
	}
	return out, nil
}

func headerValue(headers map[string]string, name string) string {
	for k, v := range headers {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return ""
}

func wantsBinaryPDFResponse(request events.APIGatewayProxyRequest, options documentRenderOptions) bool {
	if options.isBinaryResponse() {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(options.ResponseFormat), "json") {
		return false
	}
	accept := strings.ToLower(headerValue(request.Headers, "Accept"))
	return strings.Contains(accept, "application/pdf")
}

func sanitizePDFFilename(displayName string) string {
	name := strings.TrimSpace(displayName)
	if name == "" {
		return "document.pdf"
	}
	var clean strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == ' ' {
			clean.WriteRune(r)
		}
	}
	safe := strings.TrimSpace(clean.String())
	if safe == "" {
		return "document.pdf"
	}
	if !strings.HasSuffix(strings.ToLower(safe), ".pdf") {
		safe += ".pdf"
	}
	return safe
}

func binaryPDFResponse(pdfBytes []byte, displayName, fileID string, baseHeaders map[string]string) events.APIGatewayProxyResponse {
	headers := make(map[string]string, len(baseHeaders)+3)
	for k, v := range baseHeaders {
		headers[k] = v
	}
	headers["Content-Type"] = "application/pdf"
	headers["Content-Disposition"] = fmt.Sprintf(`inline; filename="%s"`, sanitizePDFFilename(displayName))
	if fileID != "" {
		headers["X-File-Id"] = fileID
	}
	return events.APIGatewayProxyResponse{
		StatusCode:      200,
		Headers:         headers,
		Body:            base64.StdEncoding.EncodeToString(pdfBytes),
		IsBase64Encoded: true,
	}
}

func main() {
	if os.Getenv("BATCH_OUTBOX_DISPATCHER") == "true" {
		lambda.Start(batchOutboxDispatcherHandler)
		return
	}
	if os.Getenv("BATCH_RECONCILER") == "true" {
		lambda.Start(batchRetryExhaustedHandler)
		return
	}
	if os.Getenv("BATCH_WORKER") == "true" {
		lambda.Start(batchWorkerHandler)
		return
	}
	lambda.Start(handler)
}
