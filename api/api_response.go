package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

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

// marshalJSONWithoutEscape serializes data to JSON without escaping HTML
// characters ('&', '<', '>'), preventing presigned S3 URLs from having '&' converted
// into '\u0026' when returned in JSON API responses.
func marshalJSONWithoutEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// jsonResponse returns an APIGatewayProxyResponse with unescaped JSON body.
func jsonResponse(status int, value any, headers map[string]string) events.APIGatewayProxyResponse {
	body, _ := marshalJSONWithoutEscape(value)
	return events.APIGatewayProxyResponse{
		StatusCode: status,
		Body:       string(body),
		Headers:    headers,
	}
}

func errorResponse(status int, message string, headers map[string]string) events.APIGatewayProxyResponse {
	return errorResponseWithCode(status, defaultErrorCode(status), message, headers)
}

func errorResponseWithCode(status int, code, message string, headers map[string]string) events.APIGatewayProxyResponse {
	return jsonResponse(status, APIErrorResponse{Error: message, Code: code, RequestID: responseRequestID(headers)}, headers)
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
