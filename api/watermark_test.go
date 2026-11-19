package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

func TestWatermarkOptionsValidation(t *testing.T) {
	diag := true
	op := 0.25
	rot := 45
	validOpts := documentRenderOptions{
		Watermark: &watermarkOptions{
			Text:     "CONFIDENTIAL",
			Diagonal: &diag,
			Opacity:  &op,
			Rotation: &rot,
			Color:    "#dc2626",
			FontSize: 60,
			Font:     "Helvetica",
			Position: "center",
		},
	}
	if err := validateDocumentOptions(&validOpts); err != nil {
		t.Fatalf("expected valid options, got: %v", err)
	}

	// Empty text
	emptyText := documentRenderOptions{
		Watermark: &watermarkOptions{Text: "   "},
	}
	err := validateDocumentOptions(&emptyText)
	if err == nil || !strings.Contains(err.Error(), "options.watermark.text is required") {
		t.Fatalf("expected text required error, got: %v", err)
	}

	// Text too long
	longText := documentRenderOptions{
		Watermark: &watermarkOptions{Text: strings.Repeat("A", 300)},
	}
	err = validateDocumentOptions(&longText)
	if err == nil || !strings.Contains(err.Error(), "must not exceed 256 characters") {
		t.Fatalf("expected text too large error, got: %v", err)
	}

	// Invalid opacity (< 0)
	negOp := -0.1
	invalidOp := documentRenderOptions{
		Watermark: &watermarkOptions{Text: "DRAFT", Opacity: &negOp},
	}
	err = validateDocumentOptions(&invalidOp)
	if err == nil || !strings.Contains(err.Error(), "opacity must be between 0.0 and 1.0") {
		t.Fatalf("expected opacity invalid error, got: %v", err)
	}

	// Invalid opacity (> 1)
	bigOp := 1.5
	invalidOp2 := documentRenderOptions{
		Watermark: &watermarkOptions{Text: "DRAFT", Opacity: &bigOp},
	}
	err = validateDocumentOptions(&invalidOp2)
	if err == nil || !strings.Contains(err.Error(), "opacity must be between 0.0 and 1.0") {
		t.Fatalf("expected opacity invalid error, got: %v", err)
	}

	// Invalid font size
	invalidSize := documentRenderOptions{
		Watermark: &watermarkOptions{Text: "DRAFT", FontSize: 200},
	}
	err = validateDocumentOptions(&invalidSize)
	if err == nil || !strings.Contains(err.Error(), "fontSize must be between 1 and 144") {
		t.Fatalf("expected fontSize invalid error, got: %v", err)
	}

	// Invalid rotation
	badRot := 400
	invalidRot := documentRenderOptions{
		Watermark: &watermarkOptions{Text: "DRAFT", Rotation: &badRot},
	}
	err = validateDocumentOptions(&invalidRot)
	if err == nil || !strings.Contains(err.Error(), "rotation must be between -360 and 360") {
		t.Fatalf("expected rotation invalid error, got: %v", err)
	}

	// Invalid color
	badColor := documentRenderOptions{
		Watermark: &watermarkOptions{Text: "DRAFT", Color: "not-a-color"},
	}
	err = validateDocumentOptions(&badColor)
	if err == nil || !strings.Contains(err.Error(), "color must be 3 RGB floats") {
		t.Fatalf("expected color invalid error, got: %v", err)
	}

	// Invalid position
	badPos := documentRenderOptions{
		Watermark: &watermarkOptions{Text: "DRAFT", Position: "middle-of-nowhere"},
	}
	err = validateDocumentOptions(&badPos)
	if err == nil || !strings.Contains(err.Error(), "position must be one of") {
		t.Fatalf("expected position invalid error, got: %v", err)
	}

	// Invalid font
	badFont := documentRenderOptions{
		Watermark: &watermarkOptions{Text: "DRAFT", Font: "Comic-Sans"},
	}
	err = validateDocumentOptions(&badFont)
	if err == nil || !strings.Contains(err.Error(), "font must be one of") {
		t.Fatalf("expected font invalid error, got: %v", err)
	}
}

func TestParseColorDesc(t *testing.T) {
	// Default
	col, err := parseColorDesc("")
	if err != nil || col != "c:0.5 0.5 0.5" {
		t.Fatalf("expected default color, got %q (err: %v)", col, err)
	}

	// 6-digit hex
	col, err = parseColorDesc("#ff0000")
	if err != nil || col != "c:1.000 0.000 0.000" {
		t.Fatalf("expected red, got %q (err: %v)", col, err)
	}

	// 3-digit shorthand hex (#0f0 -> #00ff00)
	col, err = parseColorDesc("#0f0")
	if err != nil || col != "c:0.000 1.000 0.000" {
		t.Fatalf("expected green, got %q (err: %v)", col, err)
	}

	// Normalized RGB floats
	col, err = parseColorDesc("0.8 0.2 0.2")
	if err != nil || col != "c:0.8 0.2 0.2" {
		t.Fatalf("expected c:0.8 0.2 0.2, got %q (err: %v)", col, err)
	}

	// Invalid hex
	if _, err := parseColorDesc("#12345"); err == nil {
		t.Fatal("expected error for 5-digit hex")
	}

	// Invalid floats
	if _, err := parseColorDesc("0.5 1.5 0.5"); err == nil {
		t.Fatal("expected error for float > 1.0")
	}
}

func TestApplyPDFWatermark(t *testing.T) {
	orig := []byte(minimalValidPDF)

	// 1. Nil watermark options returns unmodified bytes
	out, err := applyPDFWatermark(orig, documentRenderOptions{})
	if err != nil {
		t.Fatalf("unexpected error with nil watermark: %v", err)
	}
	if !bytes.Equal(orig, out) {
		t.Fatal("expected unmodified bytes when watermark is nil")
	}

	// 2. Empty text returns unmodified bytes
	out, err = applyPDFWatermark(orig, documentRenderOptions{
		Watermark: &watermarkOptions{Text: ""},
	})
	if err != nil {
		t.Fatalf("unexpected error with empty watermark text: %v", err)
	}
	if !bytes.Equal(orig, out) {
		t.Fatal("expected unmodified bytes when watermark text is empty")
	}

	// 3. Diagonal default watermark ("DRAFT")
	stamped, err := applyPDFWatermark(orig, documentRenderOptions{
		Watermark: &watermarkOptions{
			Text: "DRAFT",
		},
	})
	if err != nil {
		t.Fatalf("applyPDFWatermark failed: %v", err)
	}
	if bytes.Equal(orig, stamped) {
		t.Fatal("expected stamped bytes to differ from original")
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	if err := api.Validate(bytes.NewReader(stamped), conf); err != nil {
		t.Fatalf("validation failed for stamped PDF: %v", err)
	}

	// 4. Horizontal watermark with custom color and opacity
	diagFalse := false
	op := 0.25
	stampedHoriz, err := applyPDFWatermark(orig, documentRenderOptions{
		Watermark: &watermarkOptions{
			Text:     "CONFIDENTIAL",
			Diagonal: &diagFalse,
			Opacity:  &op,
			Color:    "#dc2626",
			FontSize: 42,
			Font:     "Times-Roman",
			Position: "center",
		},
	})
	if err != nil {
		t.Fatalf("applyPDFWatermark horizontal failed: %v", err)
	}
	if err := api.Validate(bytes.NewReader(stampedHoriz), conf); err != nil {
		t.Fatalf("validation failed for horizontal stamped PDF: %v", err)
	}

	// 5. Custom angle rotation (-45 degrees) with background placement
	rot := -45
	onTopFalse := false
	stampedRot, err := applyPDFWatermark(orig, documentRenderOptions{
		Watermark: &watermarkOptions{
			Text:     "COPY",
			Rotation: &rot,
			OnTop:    &onTopFalse,
			Color:    "0.3 0.3 0.3",
			FontSize: 60,
			Font:     "Courier",
		},
	})
	if err != nil {
		t.Fatalf("applyPDFWatermark rotated failed: %v", err)
	}
	if err := api.Validate(bytes.NewReader(stampedRot), conf); err != nil {
		t.Fatalf("validation failed for rotated stamped PDF: %v", err)
	}
}

func TestMergePDFStreamsWithWatermark(t *testing.T) {
	pdf1 := []byte(minimalValidPDF)
	pdf2 := []byte(minimalValidPDF)

	opts := documentRenderOptions{
		Watermark: &watermarkOptions{
			Text:  "CONFIDENTIAL",
			Color: "#dc2626",
		},
		PageNumbers: &pageNumberOptions{
			Format: "Page {page} of {total}",
		},
	}

	merged, pageCount, err := mergePDFStreams([][]byte{pdf1, pdf2}, opts)
	if err != nil {
		t.Fatalf("mergePDFStreams with watermark failed: %v", err)
	}
	if pageCount != 2 {
		t.Fatalf("expected pageCount 2, got %d", pageCount)
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	if err := api.Validate(bytes.NewReader(merged), conf); err != nil {
		t.Fatalf("validation failed for merged watermarked PDF: %v", err)
	}
}
