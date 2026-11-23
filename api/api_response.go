package main

import (
	"bytes"
	"encoding/json"
	"errors"
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
	Field     string `json:"field,omitempty"`
	Retryable *bool  `json:"retryable,omitempty"`
	Details   any    `json:"details,omitempty"`
}

// renderError is intentionally safe to return to API clients. The underlying
// Chrome error remains in Lambda logs, where it is useful for diagnosis but
// does not expose URLs, HTML, or browser internals to callers.
type renderError struct {
	Code      string
	Message   string
	Status    int
	Field     string
	Retryable *bool
	Details   any
}

func (e *renderError) Error() string { return e.Message }

func boolPtr(v bool) *bool { return &v }

func defaultErrorRetryable(status int) *bool {
	switch status {
	case 429, 500, 502, 503, 504:
		return boolPtr(true)
	case 400, 401, 403, 404, 405, 409, 413, 422:
		return boolPtr(false)
	default:
		return nil
	}
}

func ensureRetryAfterHeader(status int, headers map[string]string) {
	if headers == nil {
		return
	}
	if status != 429 && status != 503 {
		return
	}
	if headerValue(headers, "Retry-After") == "" {
		headers["Retry-After"] = "10"
	}
}

func decodeStrictJSONError(code, defaultMsg string, err error) *renderError {
	if err != nil {
		const unknownPrefix = "json: unknown field "
		if idx := strings.Index(err.Error(), unknownPrefix); idx >= 0 {
			field := strings.Trim(strings.TrimSpace(err.Error()[idx+len(unknownPrefix):]), "\"")
			if field != "" {
				return &renderError{
					Code:    code,
					Message: fmt.Sprintf("%s: unknown field %q", defaultMsg, field),
					Status:  400,
					Field:   field,
				}
			}
		}
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			return &renderError{
				Code:    code,
				Message: fmt.Sprintf("%s: invalid type for field %q", defaultMsg, typeErr.Field),
				Status:  400,
				Field:   typeErr.Field,
			}
		}
	}
	return &renderError{Code: code, Message: defaultMsg, Status: 400}
}

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
	ensureRetryAfterHeader(status, headers)
	return jsonResponse(status, APIErrorResponse{
		Error:     message,
		Code:      code,
		RequestID: responseRequestID(headers),
		Retryable: defaultErrorRetryable(status),
	}, headers)
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
		ensureRetryAfterHeader(status, headers)
		retryable := renderErr.Retryable
		if retryable == nil {
			retryable = defaultErrorRetryable(status)
		}
		return jsonResponse(status, APIErrorResponse{
			Error:     renderErr.Message,
			Code:      renderErr.Code,
			RequestID: responseRequestID(headers),
			Field:     renderErr.Field,
			Retryable: retryable,
			Details:   renderErr.Details,
		}, headers)
	}
	// Do not return a raw Chrome failure: it can include document URLs and
	// browser implementation details. The specific failures above are returned
	// as renderError values.
	if err != nil {
		fmt.Printf("PDF rendering failed (code=rendering_failed, requestId=%s): %v\n", responseRequestID(headers), err)
	}
	return errorResponseWithCode(500, "rendering_failed", "PDF rendering failed", headers)
}

func restoreTrialRemainingHeader(quota *trialQuota, headers map[string]string) {
	if quota != nil {
		headers["X-Trial-Remaining"] = fmt.Sprintf("%d", min(quota.Limit, quota.Remaining+1))
	}
}
