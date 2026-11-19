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
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/google/uuid"
)

const (
	mergeResource          = "/api/v1/merge"
	pdfMergeResource       = "/api/v1/pdf/merge"
	dashboardMergeResource = "/api/v1/dashboard/merge"

	minMergeFiles       = 2
	maxMergeFiles       = 100
	maxMergeInputBytes  = 50 * 1024 * 1024 // 50 MB
	defaultMergeTimeout = 15 * time.Second
)

var (
	errMergeRedirectBlocked = errors.New("HTTP redirects are not allowed for merge URLs")
	errMergePrivateAddress  = errors.New("target address resolves to a blocked or non-public IP")
	mergeURLValidator       = validateRenderURL
	mergeHTTPClientFactory  = newMergeHTTPClient
)

func mergeCheckRedirect(_ *http.Request, _ []*http.Request) error {
	return errMergeRedirectBlocked
}

func newSafeMergeDialContext(resolver dnsResolverFunc) func(ctx context.Context, network, addr string) (net.Conn, error) {
	if resolver == nil {
		resolver = defaultDNSResolver
	}
	dialer := &net.Dialer{Timeout: defaultMergeTimeout, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		trimmedHost := strings.TrimSpace(host)
		lowerHost := strings.ToLower(trimmedHost)
		if trimmedHost == "" || lowerHost == "localhost" || strings.HasSuffix(lowerHost, ".localhost") || strings.HasSuffix(lowerHost, ".local") {
			return nil, errMergePrivateAddress
		}

		var ips []net.IP
		if ip := net.ParseIP(trimmedHost); ip != nil {
			ips = []net.IP{ip}
		} else if altIP := parseAlternativeIP(trimmedHost); altIP != nil {
			ips = []net.IP{altIP}
		} else {
			ips, err = resolver(ctx, lowerHost)
			if err != nil || len(ips) == 0 {
				return nil, fmt.Errorf("%w: could not resolve host %q", errMergePrivateAddress, trimmedHost)
			}
		}

		for _, ip := range ips {
			if isBlockedIP(ip) {
				return nil, errMergePrivateAddress
			}
		}

		var lastErr error
		for _, ip := range ips {
			conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
		}
		return nil, lastErr
	}
}

func newMergeHTTPClient() *http.Client {
	return &http.Client{
		Timeout: defaultMergeTimeout,
		Transport: &http.Transport{
			DialContext:           newSafeMergeDialContext(nil),
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          10,
			IdleConnTimeout:       30 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
		CheckRedirect: mergeCheckRedirect,
	}
}

type mergeRequest struct {
	Version       string                `json:"version,omitempty"`
	Files         []string              `json:"files,omitempty"`
	Items         []mergeItem           `json:"items,omitempty"`
	Options       documentRenderOptions `json:"options,omitempty"`
	Label         string                `json:"label,omitempty"`
	WebhookURL    string                `json:"webhookUrl,omitempty"`
	WebhookSecret string                `json:"webhookSecret,omitempty"`
}

type mergeItem struct {
	FileID string `json:"fileId,omitempty"`
	URL    string `json:"url,omitempty"`
	Data   string `json:"data,omitempty"`
}

type mergeResponse struct {
	RequestID string `json:"requestId"`
	FileID    string `json:"fileId"`
	URL       string `json:"url"`
	Size      int64  `json:"size"`
	PageCount int    `json:"pageCount"`
}

func isMergeRequest(r events.APIGatewayProxyRequest) bool {
	p := strings.TrimSuffix(r.Path, "/")
	if p == "" {
		p = strings.TrimSuffix(r.Resource, "/")
	}
	return p == mergeResource || p == pdfMergeResource || p == dashboardMergeResource
}

func isDeprecatedPDFMergeRequest(r events.APIGatewayProxyRequest) bool {
	p := strings.TrimSuffix(r.Path, "/")
	if p == "" {
		p = strings.TrimSuffix(r.Resource, "/")
	}
	return p == pdfMergeResource
}

func parseMergeRequest(body string) (mergeRequest, error) {
	var req mergeRequest
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return req, &renderError{Code: "merge_request_invalid", Message: "Invalid merge request body", Status: 400}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return req, &renderError{Code: "merge_request_invalid", Message: "Invalid merge request body", Status: 400}
	}

	if req.Version == "" {
		req.Version = documentRequestVersion
	}
	if req.Version != documentRequestVersion {
		return req, &renderError{Code: "merge_version_unsupported", Message: "version must be \"1\"", Status: 422}
	}

	// Normalize shorthand Files list into Items
	for _, f := range req.Files {
		trimmed := strings.TrimSpace(f)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") {
			req.Items = append(req.Items, mergeItem{URL: trimmed})
		} else {
			req.Items = append(req.Items, mergeItem{FileID: trimmed})
		}
	}

	if len(req.Items) < minMergeFiles {
		return req, &renderError{Code: "merge_item_limit_invalid", Message: "At least 2 files or items are required to merge", Status: 422}
	}
	if len(req.Items) > maxMergeFiles {
		return req, &renderError{Code: "merge_item_limit_invalid", Message: fmt.Sprintf("items cannot exceed %d entries", maxMergeFiles), Status: 422}
	}

	for i, item := range req.Items {
		hasFile := strings.TrimSpace(item.FileID) != ""
		hasURL := strings.TrimSpace(item.URL) != ""
		hasData := strings.TrimSpace(item.Data) != ""
		if !hasFile && !hasURL && !hasData {
			return req, &renderError{Code: "merge_item_invalid", Message: fmt.Sprintf("item %d must provide fileId, url, or data", i+1), Status: 422}
		}
	}

	if err := validateDocumentOptions(&req.Options); err != nil {
		return req, err
	}

	if req.WebhookURL != "" {
		validated, err := validateWebhookURL(req.WebhookURL)
		if err != nil {
			return req, &renderError{Code: "merge_webhook_invalid", Message: err.Error(), Status: 400}
		}
		req.WebhookURL = validated
	}

	return req, nil
}

func handleMergeRequest(ctx context.Context, r events.APIGatewayProxyRequest, h map[string]string) events.APIGatewayProxyResponse {
	if h == nil {
		h = map[string]string{}
	}
	if isDeprecatedPDFMergeRequest(r) {
		addDeprecationHeaders(h, mergeResource)
	}
	owner := authorizerValue(r, "userId")
	if owner == "" {
		return errorResponse(http.StatusUnauthorized, "Authentication is required", h)
	}

	if r.HTTPMethod != http.MethodPost {
		return errorResponse(http.StatusMethodNotAllowed, "Method not allowed", h)
	}

	req, err := parseMergeRequest(r.Body)
	if err != nil {
		return renderErrorResponse(err, h)
	}

	customerEmail := authorizerValue(r, "email")
	reservedQuota, quotaErr := reserveAccountQuota(owner, customerEmail, time.Now().UTC())
	if quotaErr != nil {
		if quotaErr == errAccountQuotaExceeded {
			return errorResponse(http.StatusTooManyRequests, "Monthly PDF quota reached", h)
		}
		fmt.Printf("Account quota error during merge: %v\n", quotaErr)
		return errorResponse(http.StatusServiceUnavailable, "Account quota is temporarily unavailable", h)
	}

	httpClient := mergeHTTPClientFactory()
	pdfSlices := make([][]byte, 0, len(req.Items))
	var totalInputBytes int64

	for i, item := range req.Items {
		var content []byte
		var fetchErr error

		if item.FileID != "" {
			file, err := fileStoreFactory().Get(ctx, owner, item.FileID)
			if err != nil {
				refundAccountQuota(reservedQuota)
				return errorResponseWithCode(http.StatusNotFound, "file_not_found", fmt.Sprintf("File %q not found", item.FileID), h)
			}
			obj, err := s3Client.GetObjectWithContext(ctx, &s3.GetObjectInput{
				Bucket: aws.String(file.Bucket),
				Key:    aws.String(file.ObjectKey),
			})
			if err != nil {
				refundAccountQuota(reservedQuota)
				return errorResponse(http.StatusServiceUnavailable, fmt.Sprintf("Could not load file %q: %v", item.FileID, err), h)
			}
			content, fetchErr = io.ReadAll(obj.Body)
			obj.Body.Close()
		} else if item.URL != "" {
			validatedURL, valErr := mergeURLValidator(item.URL)
			if valErr != nil {
				refundAccountQuota(reservedQuota)
				return errorResponseWithCode(http.StatusUnprocessableEntity, "url_invalid", fmt.Sprintf("Item %d: %v", i+1, valErr), h)
			}
			httpReq, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, validatedURL, nil)
			if reqErr != nil {
				refundAccountQuota(reservedQuota)
				return errorResponseWithCode(http.StatusUnprocessableEntity, "url_invalid", fmt.Sprintf("Item %d: %v", i+1, reqErr), h)
			}
			resp, httpErr := httpClient.Do(httpReq)
			if httpErr != nil {
				if resp != nil && resp.Body != nil {
					resp.Body.Close()
				}
				refundAccountQuota(reservedQuota)
				if errors.Is(httpErr, errMergeRedirectBlocked) {
					return errorResponseWithCode(http.StatusUnprocessableEntity, "url_redirect_blocked", fmt.Sprintf("Item %d redirects are not allowed", i+1), h)
				}
				return errorResponseWithCode(http.StatusUnprocessableEntity, "url_fetch_failed", fmt.Sprintf("Item %d download failed: %v", i+1, httpErr), h)
			}
			if resp.StatusCode != http.StatusOK {
				resp.Body.Close()
				refundAccountQuota(reservedQuota)
				if resp.StatusCode >= 300 && resp.StatusCode < 400 {
					return errorResponseWithCode(http.StatusUnprocessableEntity, "url_redirect_blocked", fmt.Sprintf("Item %d returned redirect HTTP %d", i+1, resp.StatusCode), h)
				}
				return errorResponseWithCode(http.StatusUnprocessableEntity, "url_fetch_failed", fmt.Sprintf("Item %d returned HTTP %d", i+1, resp.StatusCode), h)
			}
			content, fetchErr = io.ReadAll(io.LimitReader(resp.Body, maxMergeInputBytes))
			resp.Body.Close()
		} else if item.Data != "" {
			decoded, decErr := base64.StdEncoding.DecodeString(item.Data)
			if decErr != nil {
				// Also try URL-safe base64
				decoded, decErr = base64.URLEncoding.DecodeString(item.Data)
			}
			if decErr != nil {
				refundAccountQuota(reservedQuota)
				return errorResponseWithCode(http.StatusUnprocessableEntity, "data_invalid", fmt.Sprintf("Item %d base64 decoding failed", i+1), h)
			}
			content = decoded
		}

		if fetchErr != nil {
			refundAccountQuota(reservedQuota)
			return errorResponse(http.StatusServiceUnavailable, fmt.Sprintf("Failed reading item %d: %v", i+1, fetchErr), h)
		}

		if len(content) < 5 || !bytes.HasPrefix(content, []byte("%PDF-")) {
			refundAccountQuota(reservedQuota)
			return errorResponseWithCode(http.StatusUnprocessableEntity, "invalid_pdf_format", fmt.Sprintf("Item %d is not a valid PDF", i+1), h)
		}

		totalInputBytes += int64(len(content))
		if totalInputBytes > maxMergeInputBytes {
			refundAccountQuota(reservedQuota)
			return errorResponseWithCode(http.StatusRequestEntityTooLarge, "merge_inputs_too_large", fmt.Sprintf("Total inputs exceed %d MB limit", maxMergeInputBytes/(1024*1024)), h)
		}

		pdfSlices = append(pdfSlices, content)
	}

	mergedBytes, pageCount, err := mergePDFStreams(pdfSlices, req.Options)
	if err != nil {
		refundAccountQuota(reservedQuota)
		return errorResponseWithCode(http.StatusUnprocessableEntity, "merge_failed", fmt.Sprintf("PDF merge failed: %v", err), h)
	}

	if err := ensurePrivateFileStorage(ctx, owner, int64(len(mergedBytes))); err != nil {
		refundAccountQuota(reservedQuota)
		return renderErrorResponse(err, h)
	}

	requestID := uuid.NewString()
	key := renderedPDFObjectKey(owner, requestID)
	if _, err := s3Client.PutObjectWithContext(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(bucketName),
		Key:         aws.String(key),
		Body:        bytes.NewReader(mergedBytes),
		ContentType: aws.String("application/pdf"),
	}); err != nil {
		refundAccountQuota(reservedQuota)
		return errorResponseWithCode(http.StatusInternalServerError, "storage_failed", "PDF storage is temporarily unavailable", h)
	}

	url, err := presignPDFDownload(bucketName, key)
	if err != nil {
		return errorResponseWithCode(http.StatusServiceUnavailable, "download_url_unavailable", "PDF download URL is temporarily unavailable", h)
	}

	checksum := sha256.Sum256(mergedBytes)
	expiresAt := time.Now().UTC().Add(maxPDFRetentionDays * 24 * time.Hour)
	displayName := req.Label
	if displayName == "" {
		displayName = "merged.pdf"
	}
	fileID := "file_" + requestID
	if err := fileStoreFactory().Create(ctx, storedFile{
		ID:                 fileID,
		Kind:               "merged_pdf",
		ContentType:        "application/pdf",
		SizeBytes:          int64(len(mergedBytes)),
		Checksum:           "sha256:" + hex.EncodeToString(checksum[:]),
		DisplayName:        displayName,
		RetentionExpiresAt: &expiresAt,
		Origin:             map[string]string{"requestId": requestID, "action": "merge"},
		OwnerID:            owner,
		Bucket:             bucketName,
		ObjectKey:          key,
		CreatedAt:          time.Now().UTC(),
	}); err != nil {
		fmt.Printf("PDF file metadata write skipped for merge %s: %v\n", requestID, err)
	}

	if req.WebhookURL != "" {
		if err := enqueueWebhook(ctx, webhookEvent{
			ID:        requestID,
			URL:       req.WebhookURL,
			Secret:    req.WebhookSecret,
			PDFURL:    url,
			PDFSize:   int64(len(mergedBytes)),
			CreatedAt: time.Now().UTC(),
		}); err != nil {
			fmt.Printf("Webhook enqueue failed for merge %s: %v\n", requestID, err)
		}
	}

	resp := mergeResponse{
		RequestID: requestID,
		FileID:    fileID,
		URL:       url,
		Size:      int64(len(mergedBytes)),
		PageCount: pageCount,
	}

	return sourceJSON(http.StatusOK, resp, h)
}
