package main

import (
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
	
	if key1 == key2 {
		t.Error("Generated keys should be unique")
	}
}
