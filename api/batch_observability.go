package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// batchAuditEvent is deliberately metadata-only. Never add source content,
// rendered HTML, data bindings, or presigned URLs to this event.
type batchAuditEvent struct {
	Event      string `json:"event"`
	JobID      string `json:"jobId,omitempty"`
	ItemID     string `json:"itemId,omitempty"`
	FileID     string `json:"fileId,omitempty"`
	RequestID  string `json:"requestId,omitempty"`
	Status     string `json:"status,omitempty"`
	ErrorCode  string `json:"errorCode,omitempty"`
	PDFBytes   int64  `json:"pdfBytes,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	Timestamp  string `json:"timestamp"`
}

func logBatchAudit(event batchAuditEvent) {
	event.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	encoded, _ := json.Marshal(event)
	fmt.Printf("BATCH_AUDIT %s\n", encoded)
}
