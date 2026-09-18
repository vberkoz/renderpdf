package main

import (
	"bytes"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// minimalValidPDF is a valid PDF-1.4 document with 1 blank page.
const minimalValidPDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <<>> >>
endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer
<< /Size 4 /Root 1 0 R >>
startxref
206
%%EOF
`

func TestApplyPDFSecurityNoPassword(t *testing.T) {
	orig := []byte(minimalValidPDF)
	out, err := applyPDFSecurity(orig, documentRenderOptions{})
	if err != nil {
		t.Fatalf("applyPDFSecurity error = %v", err)
	}
	if !bytes.Equal(orig, out) {
		t.Fatalf("expected untouched bytes when password is empty")
	}
}

func TestApplyPDFSecurityWithPassword(t *testing.T) {
	orig := []byte(minimalValidPDF)
	password := "SecretPass123"
	opts := documentRenderOptions{
		Password:      password,
		OwnerPassword: "OwnerPass456",
		Permissions:   "print",
	}

	encrypted, err := applyPDFSecurity(orig, opts)
	if err != nil {
		t.Fatalf("applyPDFSecurity error = %v", err)
	}

	if bytes.Equal(orig, encrypted) {
		t.Fatalf("expected encrypted bytes to differ from original")
	}

	// Validating without password should fail
	unauthConf := model.NewDefaultConfiguration()
	unauthConf.ValidationMode = model.ValidationRelaxed
	err = api.Validate(bytes.NewReader(encrypted), unauthConf)
	if err == nil {
		t.Fatalf("expected validation without password to fail on encrypted PDF")
	}

	// Validating with user password should succeed
	authConf := model.NewDefaultConfiguration()
	authConf.ValidationMode = model.ValidationRelaxed
	authConf.UserPW = password
	if err := api.Validate(bytes.NewReader(encrypted), authConf); err != nil {
		t.Fatalf("expected validation with user password to succeed, got: %v", err)
	}

	// Validating with owner password should succeed
	ownerConf := model.NewDefaultConfiguration()
	ownerConf.ValidationMode = model.ValidationRelaxed
	ownerConf.OwnerPW = "OwnerPass456"
	if err := api.Validate(bytes.NewReader(encrypted), ownerConf); err != nil {
		t.Fatalf("expected validation with owner password to succeed, got: %v", err)
	}
}
