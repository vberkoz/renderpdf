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

func TestGeneratePolicyWithUsageIdentifierKey(t *testing.T) {
	methodARN := "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/POST/api/v1/render"
	policy := generatePolicy("user-1", "Allow", methodARN)
	hashed := hashKey("sk_live_samplekey")
	policy.UsageIdentifierKey = hashed

	if policy.UsageIdentifierKey != hashed {
		t.Fatalf("policy.UsageIdentifierKey = %q, want %q", policy.UsageIdentifierKey, hashed)
	}
	if len(policy.UsageIdentifierKey) != 64 {
		t.Fatalf("expected 64 char hex UsageIdentifierKey, got length %d", len(policy.UsageIdentifierKey))
	}
}

func TestGetUserBillingTierDefault(t *testing.T) {
	tier := getUserBillingTier("")
	if tier != "free" {
		t.Fatalf("getUserBillingTier(\"\") = %q, want \"free\"", tier)
	}
}

func TestResolveBootstrapKeyValueCachesLookup(t *testing.T) {
	prevFreeID, prevStarterID, prevProID := freeUsagePlanKeyID, starterUsagePlanKeyID, proUsagePlanKeyID
	prevFreeVal, prevStarterVal, prevProVal := freeUsagePlanKeyValue, starterUsagePlanKeyValue, proUsagePlanKeyValue
	prevFetch := fetchAPIGatewayKeyValue
	t.Cleanup(func() {
		freeUsagePlanKeyID, starterUsagePlanKeyID, proUsagePlanKeyID = prevFreeID, prevStarterID, prevProID
		freeUsagePlanKeyValue, starterUsagePlanKeyValue, proUsagePlanKeyValue = prevFreeVal, prevStarterVal, prevProVal
		fetchAPIGatewayKeyValue = prevFetch
		bootstrapKeyCacheMu.Lock()
		bootstrapKeyCache = map[string]string{}
		bootstrapKeyCacheMu.Unlock()
	})

	freeUsagePlanKeyValue, starterUsagePlanKeyValue, proUsagePlanKeyValue = "", "", ""
	freeUsagePlanKeyID = "apigw-key-free"
	starterUsagePlanKeyID = "apigw-key-starter"
	proUsagePlanKeyID = "apigw-key-pro"
	bootstrapKeyCacheMu.Lock()
	bootstrapKeyCache = map[string]string{}
	bootstrapKeyCacheMu.Unlock()

	calls := 0
	fetchAPIGatewayKeyValue = func(keyID string) (string, error) {
		calls++
		return "secret-val-" + keyID, nil
	}

	got1 := resolveBootstrapKeyValue("starter")
	got2 := resolveBootstrapKeyValue("starter")
	if got1 != "secret-val-apigw-key-starter" || got2 != got1 {
		t.Fatalf("resolveBootstrapKeyValue(starter) = %q / %q", got1, got2)
	}
	if calls != 1 {
		t.Fatalf("expected 1 GetApiKey call due to caching, got %d", calls)
	}

	// Explicit value override takes precedence without calling GetApiKey
	freeUsagePlanKeyValue = "explicit-free-override"
	if gotFree := resolveBootstrapKeyValue("free"); gotFree != "explicit-free-override" || calls != 1 {
		t.Fatalf("expected explicit override without extra GetApiKey call, got %q calls=%d", gotFree, calls)
	}
}
