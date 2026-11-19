package main

import (
	"strconv"
	"testing"
	"time"
)

func TestFileItemWritesNumericExpiresAtAndRetentionExpiresAt(t *testing.T) {
	created := time.Date(2026, 11, 19, 10, 0, 0, 123456000, time.UTC)
	expires := created.Add(30 * 24 * time.Hour)

	item := fileItem(storedFile{
		ID:                 "file_123",
		Kind:               "rendered_pdf",
		ContentType:        "application/pdf",
		SizeBytes:          1024,
		Checksum:           "sha256:abc",
		OwnerID:            "user-1",
		Bucket:             "pdf-bucket",
		ObjectKey:          "files/user-1/file_123.pdf",
		RetentionExpiresAt: &expires,
		CreatedAt:          created,
	})

	if item["retentionExpiresAt"] == nil || item["retentionExpiresAt"].S == nil || *item["retentionExpiresAt"].S != expires.Format(time.RFC3339Nano) {
		t.Fatalf("retentionExpiresAt = %#v, want %q", item["retentionExpiresAt"], expires.Format(time.RFC3339Nano))
	}
	wantEpoch := strconv.FormatInt(expires.UTC().Unix(), 10)
	if item["expiresAt"] == nil || item["expiresAt"].N == nil || *item["expiresAt"].N != wantEpoch {
		t.Fatalf("expiresAt = %#v, want numeric %q", item["expiresAt"], wantEpoch)
	}
}

func TestFileItemOmitsExpiresAtWhenRetentionNil(t *testing.T) {
	created := time.Date(2026, 11, 19, 10, 0, 0, 0, time.UTC)

	item := fileItem(storedFile{
		ID:          "file_no_ttl",
		Kind:        "rendered_pdf",
		ContentType: "application/pdf",
		SizeBytes:   512,
		OwnerID:     "user-1",
		Bucket:      "pdf-bucket",
		ObjectKey:   "files/user-1/file_no_ttl.pdf",
		CreatedAt:   created,
	})

	if _, exists := item["retentionExpiresAt"]; exists {
		t.Fatalf("expected retentionExpiresAt to be omitted when nil, got %#v", item["retentionExpiresAt"])
	}
	if _, exists := item["expiresAt"]; exists {
		t.Fatalf("expected expiresAt to be omitted when RetentionExpiresAt is nil, got %#v", item["expiresAt"])
	}
}

func TestSourceItemNeverSetsExpiresAt(t *testing.T) {
	now := time.Date(2026, 11, 19, 10, 0, 0, 0, time.UTC)
	item := sourceItem(savedSource{
		ID:         "src_123",
		Name:       "Invoice",
		SourceType: "html",
		Version:    "1",
		SizeBytes:  100,
		Checksum:   "sha256:def",
		ObjectKey:  "sources/owner/src_123/definition.json",
		OwnerID:    "user-1",
		CreatedAt:  now,
		UpdatedAt:  now,
	})

	if _, exists := item["expiresAt"]; exists {
		t.Fatalf("saved SOURCE items must remain permanent without expiresAt, got %#v", item["expiresAt"])
	}
}
