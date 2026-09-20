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

func TestCognitoEmailRejectsMissingOrMalformedClaims(t *testing.T) {
	if got := cognitoEmail(events.APIGatewayProxyRequest{}); got != "" {
		t.Fatalf("email = %q, want empty", got)
	}
	request := events.APIGatewayProxyRequest{}
	request.RequestContext.Authorizer = map[string]interface{}{"claims": map[string]interface{}{"email": " user@example.com "}}
	if got := cognitoEmail(request); got != "user@example.com" {
		t.Fatalf("email = %q, want user@example.com", got)
	}
}

func TestCreateKeyRequestUnmarshal(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		wantName string
	}{
		{name: "empty body", body: "", wantName: ""},
		{name: "empty json", body: "{}", wantName: ""},
		{name: "with default key name", body: `{"name":"Default Key"}`, wantName: "Default Key"},
		{name: "with custom name", body: `{"name":"Production Server"}`, wantName: "Production Server"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var req CreateKeyRequest
			if tc.body != "" {
				if err := json.Unmarshal([]byte(tc.body), &req); err != nil {
					t.Fatalf("unmarshal error: %v", err)
				}
			}
			if req.Name != tc.wantName {
				t.Fatalf("req.Name = %q, want %q", req.Name, tc.wantName)
			}
		})
	}
}

func TestCreateKeyResponseAndAPIKeyInfoNameJSON(t *testing.T) {
	resp := CreateKeyResponse{
		KeyID:  "key-123",
		APIKey: "sk_live_testkey",
		Name:   "Default Key",
	}
	bytes, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	var decoded CreateKeyResponse
	if err := json.Unmarshal(bytes, &decoded); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if decoded.Name != "Default Key" || decoded.KeyID != "key-123" || decoded.APIKey != "sk_live_testkey" {
		t.Fatalf("unexpected decoded response: %#v", decoded)
	}

	info := APIKeyInfo{
		KeyID:     "key-123",
		Name:      "Default Key",
		CreatedAt: 1700000000,
		IsActive:  true,
	}
	infoBytes, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info error: %v", err)
	}
	var decodedInfo APIKeyInfo
	if err := json.Unmarshal(infoBytes, &decodedInfo); err != nil {
		t.Fatalf("unmarshal info error: %v", err)
	}
	if decodedInfo.Name != "Default Key" || decodedInfo.KeyID != "key-123" || !decodedInfo.IsActive {
		t.Fatalf("unexpected decoded info: %#v", decodedInfo)
	}
}

func TestGetUserBillingTierFallback(t *testing.T) {
	tier := getUserBillingTier("")
	if tier != "free" {
		t.Fatalf("getUserBillingTier(\"\") = %q, want \"free\"", tier)
	}
}

