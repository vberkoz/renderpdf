package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
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

type memoryFileStore struct {
	files map[string]storedFile
}

func (m *memoryFileStore) Create(_ context.Context, v storedFile) error {
	m.files[v.OwnerID+"/"+v.ID] = v
	return nil
}

func (m *memoryFileStore) Get(_ context.Context, owner, id string) (storedFile, error) {
	v, ok := m.files[owner+"/"+id]
	if !ok {
		return storedFile{}, errFileNotFound
	}
	return v, nil
}

func (m *memoryFileStore) List(_ context.Context, owner string) ([]storedFile, error) {
	var out []storedFile
	for _, v := range m.files {
		if v.OwnerID == owner {
			out = append(out, v)
		}
	}
	return out, nil
}

func (m *memoryFileStore) Delete(_ context.Context, owner, id string) error {
	delete(m.files, owner+"/"+id)
	return nil
}

func TestHandleFileRequestGetByIDAndNotFound(t *testing.T) {
	created := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	store := &memoryFileStore{
		files: map[string]storedFile{
			"owner-1/file_abc": {
				ID:          "file_abc",
				Kind:        "rendered_pdf",
				ContentType: "application/pdf",
				SizeBytes:   4200,
				Checksum:    "sha256:deadbeef",
				DisplayName: "Invoice.pdf",
				OwnerID:     "owner-1",
				CreatedAt:   created,
			},
		},
	}

	req := events.APIGatewayProxyRequest{
		HTTPMethod: http.MethodGet,
		Path:       "/api/v1/files/file_abc",
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "owner-1"},
		},
	}
	resp := handleFileRequest(context.Background(), req, map[string]string{"Content-Type": "application/json"}, store)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /files/file_abc status = %d, want 200; body=%s", resp.StatusCode, resp.Body)
	}
	var got storedFile
	if err := json.Unmarshal([]byte(resp.Body), &got); err != nil {
		t.Fatalf("decode file response: %v", err)
	}
	if got.ID != "file_abc" || got.Kind != "rendered_pdf" || got.SizeBytes != 4200 || got.DisplayName != "Invoice.pdf" {
		t.Fatalf("unexpected file record: %#v", got)
	}

	missingReq := req
	missingReq.Path = "/api/v1/files/file_missing"
	missingResp := handleFileRequest(context.Background(), missingReq, map[string]string{"Content-Type": "application/json"}, store)
	if missingResp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET missing file status = %d, want 404; body=%s", missingResp.StatusCode, missingResp.Body)
	}
}
