package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

func generateAPIKey() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("generate API key: " + err.Error())
	}
	return "sk_live_" + base64.RawURLEncoding.EncodeToString(b)
}

func hashKey(key string) string {
	hash := sha256.Sum256([]byte(key))
	return hex.EncodeToString(hash[:])
}

const apiKeyPropagationGraceSeconds int64 = 120

func resolveUsagePlanID(tier, freeID, starterID, proID string) string {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "pro":
		if proID != "" {
			return proID
		}
	case "starter":
		if starterID != "" {
			return starterID
		}
	default:
		if freeID != "" {
			return freeID
		}
	}
	if freeID != "" {
		return freeID
	}
	if starterID != "" {
		return starterID
	}
	return proID
}

// resolveUsageIdentifierKey returns a pre-propagated tier bootstrap key value while a newly created
// or lazily registered API key may still be propagating across API Gateway edge nodes.
func resolveUsageIdentifierKey(hashedKey string, createdAtUnix, nowUnix int64, hadApiGatewayKey bool, tier, freeKeyVal, starterKeyVal, proKeyVal string) string {
	if !hadApiGatewayKey || createdAtUnix <= 0 || nowUnix-createdAtUnix < apiKeyPropagationGraceSeconds {
		fallback := resolveUsagePlanID(tier, freeKeyVal, starterKeyVal, proKeyVal)
		if fallback != "" {
			return fallback
		}
	}
	return hashedKey
}
