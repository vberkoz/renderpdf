//go:build apikeys

package main

import (
	"encoding/json"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func TestAPIKeyErrorResponseIsSafeAndStructured(t *testing.T) {
	response := apiErrorResponse(503, "api_keys_unavailable", "API key management is temporarily unavailable", map[string]string{"X-Request-Id": "request-789"})
	if response.StatusCode != 503 {
		t.Fatalf("status = %d, want 503", response.StatusCode)
	}
	var body APIErrorResponse
	if err := json.Unmarshal([]byte(response.Body), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Code != "api_keys_unavailable" || body.RequestID != "request-789" {
		t.Fatalf("body = %#v, want code and request id", body)
	}
}

func TestCognitoSubjectRejectsMissingOrMalformedClaims(t *testing.T) {
	if got := cognitoSubject(events.APIGatewayProxyRequest{}); got != "" {
		t.Fatalf("subject = %q, want empty", got)
	}
	request := events.APIGatewayProxyRequest{}
	request.RequestContext.Authorizer = map[string]interface{}{"claims": map[string]interface{}{"sub": " user-1 "}}
	if got := cognitoSubject(request); got != "user-1" {
		t.Fatalf("subject = %q, want user-1", got)
	}
}
