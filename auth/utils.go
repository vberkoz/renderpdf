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

