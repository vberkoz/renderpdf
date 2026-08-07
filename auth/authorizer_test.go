//go:build authorizer

package main

import "testing"

func TestHeaderValueIsCaseInsensitive(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{name: "lowercase", headers: map[string]string{"authorization": "lower"}, want: "lower"},
		{name: "canonical", headers: map[string]string{"Authorization": "canonical"}, want: "canonical"},
		{name: "uppercase", headers: map[string]string{"AUTHORIZATION": "upper"}, want: "upper"},
		{name: "missing", headers: map[string]string{"Content-Type": "application/json"}, want: ""},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := headerValue(test.headers, "Authorization"); got != test.want {
				t.Fatalf("headerValue() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestBearerToken(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{name: "valid", headers: map[string]string{"Authorization": "Bearer sk_live_example"}, want: "sk_live_example"},
		{name: "case insensitive", headers: map[string]string{"authorization": "bearer sk_live_example"}, want: "sk_live_example"},
		{name: "missing", headers: map[string]string{}, want: ""},
		{name: "wrong scheme", headers: map[string]string{"Authorization": "Basic credentials"}, want: ""},
		{name: "missing value", headers: map[string]string{"Authorization": "Bearer"}, want: ""},
		{name: "extra values", headers: map[string]string{"Authorization": "Bearer key extra"}, want: ""},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := bearerToken(test.headers); got != test.want {
				t.Fatalf("bearerToken() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestGeneratePolicyAllowsTheCurrentAPIStage(t *testing.T) {
	methodARN := "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/POST/api/v1/uploads"
	policy := generatePolicy("user-1", "Allow", methodARN)
	got := policy.PolicyDocument.Statement[0].Resource[0]
	want := "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/*"
	if got != want {
		t.Fatalf("policy resource = %q, want %q", got, want)
	}
}
