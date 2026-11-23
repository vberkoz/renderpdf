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

func TestResolveUsageIdentifierKey(t *testing.T) {
	hashed := strings.Repeat("a", 64)
	freeKey := "rpdf-plan-free-123-bootstrap"
	starterKey := "rpdf-plan-starter-123-bootstrap"
	proKey := "rpdf-plan-pro-123-bootstrap"
	now := int64(1795360500)

	tests := []struct {
		name             string
		createdAt        int64
		hadApiGatewayKey bool
		tier             string
		freeVal          string
		starterVal       string
		proVal           string
		want             string
	}{
		{
			name:             "new key within grace window on free tier",
			createdAt:        now - 34,
			hadApiGatewayKey: true,
			tier:             "free",
			freeVal:          freeKey,
			starterVal:       starterKey,
			proVal:           proKey,
			want:             freeKey,
		},
		{
			name:             "new key within grace window on starter tier",
			createdAt:        now - 34,
			hadApiGatewayKey: true,
			tier:             "starter",
			freeVal:          freeKey,
			starterVal:       starterKey,
			proVal:           proKey,
			want:             starterKey,
		},
		{
			name:             "new key within grace window on pro tier",
			createdAt:        now - 10,
			hadApiGatewayKey: true,
			tier:             "pro",
			freeVal:          freeKey,
			starterVal:       starterKey,
			proVal:           proKey,
			want:             proKey,
		},
		{
			name:             "lazily healed old key without apiGatewayKeyId",
			createdAt:        now - 3600,
			hadApiGatewayKey: false,
			tier:             "starter",
			freeVal:          freeKey,
			starterVal:       starterKey,
			proVal:           proKey,
			want:             starterKey,
		},
		{
			name:             "mature key past grace window uses hashed key",
			createdAt:        now - apiKeyPropagationGraceSeconds,
			hadApiGatewayKey: true,
			tier:             "starter",
			freeVal:          freeKey,
			starterVal:       starterKey,
			proVal:           proKey,
			want:             hashed,
		},
		{
			name:             "empty bootstrap keys fall back to hashed key",
			createdAt:        now - 5,
			hadApiGatewayKey: false,
			tier:             "starter",
			freeVal:          "",
			starterVal:       "",
			proVal:           "",
			want:             hashed,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveUsageIdentifierKey(hashed, tt.createdAt, now, tt.hadApiGatewayKey, tt.tier, tt.freeVal, tt.starterVal, tt.proVal)
			if got != tt.want {
				t.Fatalf("resolveUsageIdentifierKey() = %q, want %q", got, tt.want)
			}
		})
	}
}
