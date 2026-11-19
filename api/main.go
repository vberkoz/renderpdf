package main

import (
	"bytes"
	"context"
	"crypto/sha256"
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
)

type Request struct {
	HTML          string                 `json:"html"`
	WebhookURL    string                 `json:"webhookUrl,omitempty"`
	WebhookSecret string                 `json:"webhookSecret,omitempty"`
	Options       *documentRenderOptions `json:"options,omitempty"`
}

type URLRequest struct {
	URL           string                 `json:"url"`
	WebhookURL    string                 `json:"webhookUrl,omitempty"`
	WebhookSecret string                 `json:"webhookSecret,omitempty"`
	Options       *documentRenderOptions `json:"options,omitempty"`
}

type Response struct {
	RequestID string `json:"requestId"`
	URL       string `json:"url"`
	Size      int64  `json:"size"`
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

func handler(ctx context.Context, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	requestID := uuid.NewString()
	corsHeaders := map[string]string{
		"Content-Type":                  "application/json",
		"Access-Control-Allow-Origin":   "*",
		"Access-Control-Allow-Headers":  "Content-Type,X-Amz-Date,Authorization,X-Amz-Security-Token",
		"Access-Control-Allow-Methods":  "GET,POST,OPTIONS",
		"Access-Control-Expose-Headers": "X-Request-Id,X-Trial-Limit,X-Trial-Remaining",
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
		if req.Options != nil {
			if err := validateDocumentOptions(req.Options); err != nil {
				analytics.ErrorType = "validation"
				return renderErrorResponse(err, corsHeaders), nil
			}
			documentOptions = *req.Options
		}
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
		customerEmail := authorizerValue(request, "email")
		reservedQuota, quotaErr := reserveAccountQuota(analytics.CustomerID, customerEmail, time.Now().UTC())
		if quotaErr != nil {
			if errors.Is(quotaErr, errAccountQuotaExceeded) {
				analytics.ErrorType = "rate_limit"
				return errorResponse(429, "Monthly PDF quota reached", corsHeaders), nil
			}
			analytics.ErrorType = "quota"
			fmt.Printf("Account quota error: %v\n", quotaErr)
			return errorResponse(503, "Account quota is temporarily unavailable", corsHeaders), nil
		}
		reservedAccountQuota = reservedQuota
	}

	renderStartedAt := time.Now()
	var pdfBytes []byte
	var err error
	if isDocumentRender {
		pdfBytes, err = generateDocumentPDFWithOptions(ctx, html, documentOptions)
	} else if isURLRender {
		pdfBytes, err = generatePDFURLWithDocumentOptions(ctx, renderURL, documentOptions)
	} else if isPackageRender {
		pdfBytes, err = generatePDFURLWithDocumentOptions(ctx, packageURL, documentOptions)
	} else {
		html = injectPrintCSS(html)
		html = rewriteTfoot(html)
		html = transformBarcodes(html)
		pdfBytes, err = renderHTMLPDF(ctx, html, documentOptions)
	}
	analytics.RenderMs = maxInt64(1, time.Since(renderStartedAt).Milliseconds())
	if err != nil {
		fmt.Printf("PDF generation failed: %v\n", err)
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
		return renderErrorResponse(err, corsHeaders), nil
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
		return errorResponseWithCode(500, "storage_failed", "PDF storage is temporarily unavailable", corsHeaders), nil
	}

	url, err := signRenderedPDFDownload(bucketName, key)
	if err != nil {
		analytics.ErrorType = "storage"
		fmt.Printf("PDF download URL signing failed for %s: %v\n", requestID, err)
		return errorResponseWithCode(503, "download_url_unavailable", "PDF download URL is temporarily unavailable", corsHeaders), nil
	}
	if !isTrial {
		checksum := sha256.Sum256(pdfBytes)
		expiresAt := time.Now().UTC().Add(maxPDFRetentionDays * 24 * time.Hour)
		if displayName == "" {
			displayName = normalized.Label
		}
		if err := fileStoreFactory().Create(ctx, storedFile{ID: "file_" + requestID, Kind: "rendered_pdf", ContentType: "application/pdf", SizeBytes: int64(len(pdfBytes)), Checksum: "sha256:" + hex.EncodeToString(checksum[:]), DisplayName: displayName, RetentionExpiresAt: &expiresAt, Origin: map[string]string{"requestId": requestID}, OwnerID: analytics.CustomerID, Bucket: bucketName, ObjectKey: key, CreatedAt: time.Now().UTC()}); err != nil {
			fmt.Printf("PDF file metadata write skipped for %s: %v\n", requestID, err)
		}
	}
	analytics.Status = "success"
	analytics.ErrorType = ""
	analytics.PDFBytes = int64(len(pdfBytes))

	resp := Response{RequestID: requestID, URL: url, Size: int64(len(pdfBytes))}
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

	return jsonResponse(200, resp, corsHeaders), nil
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
