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

func TestApplyPDFSecurityUserOnlyPassword(t *testing.T) {
	orig := []byte(minimalValidPDF)
	password := "UserSecret999"
	opts := documentRenderOptions{
		Password: password,
	}

	encrypted, err := applyPDFSecurity(orig, opts)
	if err != nil {
		t.Fatalf("applyPDFSecurity error = %v", err)
	}
	if bytes.Equal(orig, encrypted) {
		t.Fatalf("expected encrypted bytes to differ from original")
	}

	// Unauthenticated validation fails
	unauthConf := model.NewDefaultConfiguration()
	unauthConf.ValidationMode = model.ValidationRelaxed
	if err := api.Validate(bytes.NewReader(encrypted), unauthConf); err == nil {
		t.Fatalf("expected validation without password to fail")
	}

	// User password succeeds
	userConf := model.NewDefaultConfiguration()
	userConf.ValidationMode = model.ValidationRelaxed
	userConf.UserPW = password
	if err := api.Validate(bytes.NewReader(encrypted), userConf); err != nil {
		t.Fatalf("expected validation with user password to succeed, got: %v", err)
	}

	// When ownerPassword is omitted, ownerPW defaults to userPW, so owner validation also succeeds
	ownerConf := model.NewDefaultConfiguration()
	ownerConf.ValidationMode = model.ValidationRelaxed
	ownerConf.OwnerPW = password
	if err := api.Validate(bytes.NewReader(encrypted), ownerConf); err != nil {
		t.Fatalf("expected validation with default owner password to succeed, got: %v", err)
	}
}

func TestApplyPDFSecurityOwnerOnlyPassword(t *testing.T) {
	orig := []byte(minimalValidPDF)
	ownerPassword := "MasterKey888"
	opts := documentRenderOptions{
		OwnerPassword: ownerPassword,
		Permissions:   "print",
	}

	encrypted, err := applyPDFSecurity(orig, opts)
	if err != nil {
		t.Fatalf("applyPDFSecurity error = %v", err)
	}
	if bytes.Equal(orig, encrypted) {
		t.Fatalf("expected encrypted bytes to differ from original")
	}

	// Documents with empty user password can be opened without password
	openConf := model.NewDefaultConfiguration()
	openConf.ValidationMode = model.ValidationRelaxed
	if err := api.Validate(bytes.NewReader(encrypted), openConf); err != nil {
		t.Fatalf("expected open-without-password to succeed for owner-only protection, got: %v", err)
	}

	// Validating with owner password succeeds
	ownerConf := model.NewDefaultConfiguration()
	ownerConf.ValidationMode = model.ValidationRelaxed
	ownerConf.OwnerPW = ownerPassword
	if err := api.Validate(bytes.NewReader(encrypted), ownerConf); err != nil {
		t.Fatalf("expected validation with owner password to succeed, got: %v", err)
	}
}

func TestApplyPDFSecurityPermissionsNone(t *testing.T) {
	orig := []byte(minimalValidPDF)
	opts := documentRenderOptions{
		Password:    "Secure123",
		Permissions: "none",
	}

	encrypted, err := applyPDFSecurity(orig, opts)
	if err != nil {
		t.Fatalf("applyPDFSecurity error = %v", err)
	}
	if bytes.Equal(orig, encrypted) {
		t.Fatalf("expected encrypted bytes to differ from original")
	}

	authConf := model.NewDefaultConfiguration()
	authConf.ValidationMode = model.ValidationRelaxed
	authConf.UserPW = "Secure123"
	if err := api.Validate(bytes.NewReader(encrypted), authConf); err != nil {
		t.Fatalf("expected validation with user password to succeed, got: %v", err)
	}
}

