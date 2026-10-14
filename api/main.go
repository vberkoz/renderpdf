package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/aws/aws-sdk-go/service/sqs"
	"github.com/google/uuid"
	"github.com/pdfcpu/pdfcpu/pkg/api"
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

// APIErrorResponse is the response contract used by every JSON API error.
// Codes are stable for programmatic handling; messages are safe for display.
type APIErrorResponse struct {
	Error     string `json:"error"`
	Code      string `json:"code"`
	RequestID string `json:"requestId,omitempty"`
}

// renderError is intentionally safe to return to API clients. The underlying
// Chrome error remains in Lambda logs, where it is useful for diagnosis but
// does not expose URLs, HTML, or browser internals to callers.
type renderError struct {
	Code    string
	Message string
	Status  int
}

func (e *renderError) Error() string { return e.Message }

type requestAnalytics struct {
	RequestID     string
	Plan          string
	Status        string
	ErrorType     string
	HTMLBytes     int64
	PDFBytes      int64
	DurationMs    int64
	RenderMs      int64
	Country       string
	CustomerID    string
	APIKeyID      string
	SourceType    string
	SourceMode    string
	SourceVersion string
	SourceBytes   int64
}

type dynamoDBAPI interface {
	GetItem(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error)
	PutItem(*dynamodb.PutItemInput) (*dynamodb.PutItemOutput, error)
	UpdateItem(*dynamodb.UpdateItemInput) (*dynamodb.UpdateItemOutput, error)
}

type sqsAPI interface {
	SendMessageWithContext(aws.Context, *sqs.SendMessageInput, ...request.Option) (*sqs.SendMessageOutput, error)
}

var (
	bucketName                    = os.Getenv("BUCKET_NAME")
	packageBucketName             = os.Getenv("PACKAGE_BUCKET_NAME")
	tableName                     = os.Getenv("TABLE_NAME")
	sess                          = session.Must(session.NewSession())
	s3Client                      = s3.New(sess)
	sqsClient         sqsAPI      = sqs.New(sess)
	ddbClient         dynamoDBAPI = dynamodb.New(sess)
)

func init() {
	api.DisableConfigDir()
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
	if isTrialQuotaRequest(request) {
		quota, err := currentTrialQuota(trialViewerIP(request), time.Now().UTC())
		if err != nil {
			fmt.Printf("Trial quota lookup failed: %v\n", err)
			return errorResponse(503, "Trial quota is temporarily unavailable", corsHeaders), nil
		}
		corsHeaders["X-Trial-Limit"] = fmt.Sprintf("%d", quota.Limit)
		corsHeaders["X-Trial-Remaining"] = fmt.Sprintf("%d", quota.Remaining)
		body, _ := json.Marshal(map[string]int{"limit": quota.Limit, "remaining": quota.Remaining})
		return events.APIGatewayProxyResponse{StatusCode: 200, Body: string(body), Headers: corsHeaders}, nil
	}
	if isPackageUploadRequest(request) {
		if request.HTTPMethod != "POST" || trialModeOnly() {
			return errorResponse(404, "Not found", corsHeaders), nil
		}
		response, err := createPackageUpload(authorizerValue(request, "userId"))
		if err != nil {
			fmt.Printf("Package upload initialization failed: %v\n", err)
			return errorResponse(503, "Package uploads are temporarily unavailable", corsHeaders), nil
		}
		body, _ := json.Marshal(response)
		return events.APIGatewayProxyResponse{StatusCode: 200, Body: string(body), Headers: corsHeaders}, nil
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
		html = ensureColgroup(html)
		html = rewriteTfoot(html)
		pdfBytes, err = generatePDFWithOptions(ctx, html, documentOptions)
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

	key := renderedPDFObjectKey(analytics.CustomerID, requestID)
	if err := ensurePrivateFileStorage(ctx, analytics.CustomerID, int64(len(pdfBytes))); err != nil {
		refundTrialQuota(quota)
		refundAccountQuota(reservedAccountQuota)
		restoreTrialRemainingHeader(quota, corsHeaders)
		return renderErrorResponse(err, corsHeaders), nil
	}
	_, err = s3Client.PutObject(&s3.PutObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(key),
		Body:   bytes.NewReader(pdfBytes),
	})
	if err != nil {
		analytics.ErrorType = "storage"
		fmt.Printf("PDF storage failed for %s: %v\n", requestID, err)
		refundTrialQuota(quota)
		refundAccountQuota(reservedAccountQuota)
		restoreTrialRemainingHeader(quota, corsHeaders)
		return errorResponseWithCode(500, "storage_failed", "PDF storage is temporarily unavailable", corsHeaders), nil
	}

	url, err := presignPDFDownload(bucketName, key)
	if err != nil {
		analytics.ErrorType = "storage"
		fmt.Printf("PDF download URL signing failed for %s: %v\n", requestID, err)
		return errorResponseWithCode(503, "download_url_unavailable", "PDF download URL is temporarily unavailable", corsHeaders), nil
	}
	checksum := sha256.Sum256(pdfBytes)
	expiresAt := time.Now().UTC().Add(maxPDFRetentionDays * 24 * time.Hour)
	if displayName == "" {
		displayName = normalized.Label
	}
	if err := fileStoreFactory().Create(ctx, storedFile{ID: "file_" + requestID, Kind: "rendered_pdf", ContentType: "application/pdf", SizeBytes: int64(len(pdfBytes)), Checksum: "sha256:" + hex.EncodeToString(checksum[:]), DisplayName: displayName, RetentionExpiresAt: &expiresAt, Origin: map[string]string{"requestId": requestID}, OwnerID: analytics.CustomerID, Bucket: bucketName, ObjectKey: key, CreatedAt: time.Now().UTC()}); err != nil {
		fmt.Printf("PDF file metadata write skipped for %s: %v\n", requestID, err)
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
	body, _ := json.Marshal(resp)

	return events.APIGatewayProxyResponse{
		StatusCode: 200,
		Body:       string(body),
		Headers:    corsHeaders,
	}, nil
}

func errorResponse(status int, message string, headers map[string]string) events.APIGatewayProxyResponse {
	return errorResponseWithCode(status, defaultErrorCode(status), message, headers)
}

func errorResponseWithCode(status int, code, message string, headers map[string]string) events.APIGatewayProxyResponse {
	body, _ := json.Marshal(APIErrorResponse{Error: message, Code: code, RequestID: responseRequestID(headers)})
	return events.APIGatewayProxyResponse{StatusCode: status, Body: string(body), Headers: headers}
}

func defaultErrorCode(status int) string {
	switch status {
	case 400:
		return "invalid_request"
	case 401:
		return "authentication_required"
	case 404:
		return "not_found"
	case 405:
		return "method_not_allowed"
	case 409:
		return "conflict"
	case 413:
		return "payload_too_large"
	case 422:
		return "validation_error"
	case 429:
		return "rate_limited"
	case 503:
		return "service_unavailable"
	default:
		return "internal_error"
	}
}

func responseRequestID(headers map[string]string) string {
	for name, value := range headers {
		if strings.EqualFold(name, "X-Request-Id") {
			return value
		}
	}
	return ""
}

func renderErrorResponse(err error, headers map[string]string) events.APIGatewayProxyResponse {
	if renderErr, ok := err.(*renderError); ok {
		status := renderErr.Status
		if status == 0 {
			status = 422
		}
		return errorResponseWithCode(status, renderErr.Code, renderErr.Message, headers)
	}
	// Do not return a raw Chrome failure: it can include document URLs and
	// browser implementation details. The specific failures above are returned
	// as renderError values.
	return errorResponseWithCode(500, "rendering_failed", "PDF rendering failed", headers)
}

func restoreTrialRemainingHeader(quota *trialQuota, headers map[string]string) {
	if quota != nil {
		headers["X-Trial-Remaining"] = fmt.Sprintf("%d", min(quota.Limit, quota.Remaining+1))
	}
}

func trialViewerIP(request events.APIGatewayProxyRequest) string {
	for name, value := range request.Headers {
		if strings.EqualFold(name, "X-RenderPDF-Viewer-IP") {
			if ip := net.ParseIP(strings.TrimSpace(value)); ip != nil {
				return ip.String()
			}
		}
	}

	return request.RequestContext.Identity.SourceIP
}

func requestCountry(request events.APIGatewayProxyRequest) string {
	for name, value := range request.Headers {
		if strings.EqualFold(name, "CloudFront-Viewer-Country") {
			country := strings.ToUpper(strings.TrimSpace(value))
			if len(country) == 2 && country[0] >= 'A' && country[0] <= 'Z' && country[1] >= 'A' && country[1] <= 'Z' {
				return country
			}
		}
	}
	return ""
}

func authorizerValue(request events.APIGatewayProxyRequest, name string) string {
	value, ok := request.RequestContext.Authorizer[name]
	if ok {
		if text, ok := value.(string); ok {
			return text
		}
		return fmt.Sprint(value)
	}
	// API-key requests provide userId directly. Cognito-authorized dashboard
	// requests provide the account subject under claims.sub. Treat both as the
	// same template owner so the browser never has to handle an API key.
	if name == "userId" {
		if claims, ok := request.RequestContext.Authorizer["claims"].(map[string]interface{}); ok {
			if sub, ok := claims["sub"].(string); ok {
				return sub
			}
		}
		if claims, ok := request.RequestContext.Authorizer["claims"].(map[string]string); ok {
			return claims["sub"]
		}
	}
	return ""
}

func trackUsage(parentCtx context.Context, analytics requestAnalytics) {
	now := time.Now().UTC()
	input := &dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item: map[string]*dynamodb.AttributeValue{
			"requestId":        {S: aws.String(analytics.RequestID)},
			"timestamp":        {N: aws.String(fmt.Sprintf("%d", now.Unix()))},
			"status":           {S: aws.String(analytics.Status)},
			"entityType":       {S: aws.String("PDF_REQUEST")},
			"plan":             {S: aws.String(analytics.Plan)},
			"GSI1PK":           {S: aws.String("USAGE#" + now.Format("2006-01-02"))},
			"GSI1SK":           {S: aws.String(fmt.Sprintf("%020d#%s", now.UnixNano(), analytics.RequestID))},
			"durationMs":       {N: aws.String(strconv.FormatInt(analytics.DurationMs, 10))},
			"renderDurationMs": {N: aws.String(strconv.FormatInt(analytics.RenderMs, 10))},
			"htmlBytes":        {N: aws.String(strconv.FormatInt(analytics.HTMLBytes, 10))},
		},
	}
	if analytics.PDFBytes > 0 {
		input.Item["size"] = &dynamodb.AttributeValue{N: aws.String(strconv.FormatInt(analytics.PDFBytes, 10))}
	}
	if analytics.ErrorType != "" {
		input.Item["errorType"] = &dynamodb.AttributeValue{S: aws.String(analytics.ErrorType)}
	}
	if analytics.Country != "" {
		input.Item["country"] = &dynamodb.AttributeValue{S: aws.String(analytics.Country)}
	}
	if analytics.CustomerID != "" {
		input.Item["customerId"] = &dynamodb.AttributeValue{S: aws.String(analytics.CustomerID)}
	}
	if analytics.APIKeyID != "" {
		input.Item["apiKeyId"] = &dynamodb.AttributeValue{S: aws.String(analytics.APIKeyID)}
	}
	if analytics.SourceType != "" {
		input.Item["sourceType"] = &dynamodb.AttributeValue{S: aws.String(analytics.SourceType)}
		input.Item["sourceMode"] = &dynamodb.AttributeValue{S: aws.String(analytics.SourceMode)}
		input.Item["sourceVersion"] = &dynamodb.AttributeValue{S: aws.String(analytics.SourceVersion)}
		input.Item["sourceBytes"] = &dynamodb.AttributeValue{N: aws.String(strconv.FormatInt(analytics.SourceBytes, 10))}
	}

	// Usage analytics must never consume the remaining request time after a PDF
	// has already been generated. The indexed write is best-effort.
	ctx, cancel := context.WithTimeout(parentCtx, 2*time.Second)
	defer cancel()
	if client, ok := ddbClient.(interface {
		PutItemWithContext(context.Context, *dynamodb.PutItemInput, ...request.Option) (*dynamodb.PutItemOutput, error)
	}); ok {
		if _, err := client.PutItemWithContext(ctx, input); err != nil {
			fmt.Printf("Usage analytics write skipped: %v\n", err)
		}
		return
	}
	if _, err := ddbClient.PutItem(input); err != nil {
		fmt.Printf("Usage analytics write skipped: %v\n", err)
	}
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
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
