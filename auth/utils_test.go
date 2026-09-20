package main

import (
	"strings"
	"testing"
)

func TestHashKey(t *testing.T) {
	key := "test-api-key"
	hash := hashKey(key)
	
	if len(hash) != 64 {
		t.Errorf("Expected hash length 64, got %d", len(hash))
	}
	
	if hashKey(key) != hash {
		t.Error("Hash should be deterministic")
	}
}

func TestGenerateAPIKey(t *testing.T) {
	key1 := generateAPIKey()
	key2 := generateAPIKey()
	
	if len(key1) == 0 {
		t.Error("Generated key should not be empty")
	}
	if !strings.HasPrefix(key1, "sk_live_") {
		t.Errorf("Generated key %q is missing sk_live_ prefix", key1)
	}
	if strings.Contains(key1, "=") {
		t.Errorf("Generated key %q must not contain base64 padding", key1)
	}
	
	if key1 == key2 {
		t.Error("Generated keys should be unique")
	}
}

func TestResolveUsagePlanID(t *testing.T) {
	freeID := "plan-free-123"
	starterID := "plan-starter-456"
	proID := "plan-pro-789"

	tests := []struct {
		name string
		tier string
		want string
	}{
		{name: "empty tier defaults to free", tier: "", want: freeID},
		{name: "free tier", tier: "free", want: freeID},
		{name: "starter tier", tier: "starter", want: starterID},
		{name: "starter uppercase", tier: "STARTER", want: starterID},
		{name: "pro tier", tier: "pro", want: proID},
		{name: "pro uppercase", tier: "PRO", want: proID},
		{name: "unknown tier defaults to free", tier: "enterprise", want: freeID},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveUsagePlanID(tt.tier, freeID, starterID, proID)
			if got != tt.want {
				t.Fatalf("resolveUsagePlanID(%q) = %q, want %q", tt.tier, got, tt.want)
			}
		})
	}
}

