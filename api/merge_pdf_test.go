package main

import (
	"bytes"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

func TestMergePDFStreams(t *testing.T) {
	pdf1 := []byte(minimalValidPDF)
	pdf2 := []byte(minimalValidPDF)

	merged, pageCount, err := mergePDFStreams([][]byte{pdf1, pdf2}, documentRenderOptions{})
	if err != nil {
		t.Fatalf("mergePDFStreams failed: %v", err)
	}

	if len(merged) == 0 {
		t.Fatalf("expected non-empty merged PDF")
	}

	if pageCount != 2 {
		t.Errorf("expected pageCount 2, got %d", pageCount)
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	actualCount, err := api.PageCount(bytes.NewReader(merged), conf)
	if err != nil {
		t.Fatalf("failed to read merged PDF page count: %v", err)
	}
	if actualCount != 2 {
		t.Errorf("expected actual page count 2, got %d", actualCount)
	}
}

func TestMergePDFStreamsWithOptions(t *testing.T) {
	pdf1 := []byte(minimalValidPDF)
	pdf2 := []byte(minimalValidPDF)

	opts := documentRenderOptions{
		PageNumbers: &pageNumberOptions{
			Format:   "Page {page} of {total}",
			Position: "bottom-center",
		},
		Password: "mergePassword123",
	}

	merged, pageCount, err := mergePDFStreams([][]byte{pdf1, pdf2}, opts)
	if err != nil {
		t.Fatalf("mergePDFStreams with options failed: %v", err)
	}

	if pageCount != 2 {
		t.Errorf("expected pageCount 2, got %d", pageCount)
	}

	// Verify the merged document is encrypted with the password
	conf := model.NewAESConfiguration("mergePassword123", "mergePassword123", 256)
	count, err := api.PageCount(bytes.NewReader(merged), conf)
	if err != nil {
		t.Fatalf("failed to read page count of encrypted merged PDF: %v", err)
	}
	if count != 2 {
		t.Errorf("expected count 2, got %d", count)
	}
}

func TestMergePDFStreamsValidation(t *testing.T) {
	// Less than 2 PDFs
	_, _, err := mergePDFStreams([][]byte{[]byte(minimalValidPDF)}, documentRenderOptions{})
	if err == nil {
		t.Error("expected error when merging < 2 PDFs")
	}

	// Invalid PDF header
	_, _, err = mergePDFStreams([][]byte{[]byte("not a pdf"), []byte(minimalValidPDF)}, documentRenderOptions{})
	if err == nil {
		t.Error("expected error when item is not a valid PDF")
	}
}
