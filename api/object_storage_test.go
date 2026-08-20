package main

import (
	"strings"
	"testing"
)

func TestPrivateObjectKeysUseOpaqueAccountPrefixes(t *testing.T) {
	owner := "customer@example.test"
	keys := []string{
		sourceDefinitionObjectKey(owner, "src_123"),
		packageObjectKey(owner, "upload_123"),
		renderedPDFObjectKey(owner, "file_123"),
		batchArtifactObjectKey(owner, "job_123", "results.zip"),
	}
	for _, key := range keys {
		if strings.Contains(key, owner) {
			t.Fatalf("object key leaks owner ID: %q", key)
		}
		if !strings.Contains(key, privateAccountObjectPrefix(owner)) {
			t.Fatalf("object key is not account scoped: %q", key)
		}
	}
	if got := renderedPDFObjectKey("", "request_123"); got != "files/trial/request_123.pdf" {
		t.Fatalf("trial PDF key = %q", got)
	}
}

func TestPrivateObjectKeyPrefixes(t *testing.T) {
	owner := "customer-a"
	if got := sourceDefinitionObjectKey(owner, "src_1"); !strings.HasPrefix(got, "sources/") || !strings.HasSuffix(got, "/src_1/definition.json") {
		t.Fatalf("source key = %q", got)
	}
	if got := renderedPDFObjectKey(owner, "file_1"); !strings.HasPrefix(got, "files/") || !strings.HasSuffix(got, "/file_1.pdf") {
		t.Fatalf("PDF key = %q", got)
	}
	if got := batchArtifactObjectKey(owner, "job_1", "results.zip"); !strings.HasPrefix(got, "batches/") || !strings.HasSuffix(got, "/job_1/results.zip") {
		t.Fatalf("batch key = %q", got)
	}
}
