package main

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func TestPDFSigningAndVerification(t *testing.T) {
	certPEM, keyPEM, err := generateSelfSignedTestCertificate("RenderPDF Signer Test")
	if err != nil {
		t.Fatalf("failed to generate test certificate: %v", err)
	}

	pdfBytes := createTestPDF()

	opts := documentRenderOptions{
		Signing: &signingOptions{
			Certificate: certPEM,
			PrivateKey:  keyPEM,
			Name:        "Test Signer",
			Reason:      "Integrity Verification",
			Location:    "San Francisco, CA",
			ContactInfo: "security@renderpdf.io",
		},
	}

	signedPDF, err := applyPDFSignature(pdfBytes, opts)
	if err != nil {
		t.Fatalf("applyPDFSignature failed: %v", err)
	}

	if len(signedPDF) <= len(pdfBytes) {
		t.Errorf("expected signed PDF to be larger than original (%d bytes vs %d bytes)", len(signedPDF), len(pdfBytes))
	}

	// Verify cryptographic signature
	resp, err := verifyPDFSignature(signedPDF)
	if err != nil {
		t.Fatalf("verifyPDFSignature failed: %v", err)
	}

	if resp == nil {
		t.Fatalf("verifyPDFSignature returned nil response")
	}

	if len(resp.Signers) != 1 {
		t.Fatalf("expected 1 signer, found %d", len(resp.Signers))
	}

	signer := resp.Signers[0]
	if !signer.ValidSignature {
		t.Errorf("expected ValidSignature to be true")
	}

	if len(signer.Certificates) == 0 || signer.Certificates[0].Certificate == nil {
		t.Fatalf("expected signature certificate to be non-nil")
	}

	if signer.Certificates[0].Certificate.Subject.CommonName != "RenderPDF Signer Test" {
		t.Errorf("expected cert subject CN %q, got %q", "RenderPDF Signer Test", signer.Certificates[0].Certificate.Subject.CommonName)
	}
}

func TestPDFSigningWithBase64Credentials(t *testing.T) {
	certPEM, keyPEM, err := generateSelfSignedTestCertificate("RenderPDF Base64 Signer")
	if err != nil {
		t.Fatalf("failed to generate test certificate: %v", err)
	}

	b64Cert := base64.StdEncoding.EncodeToString([]byte(certPEM))
	b64Key := base64.StdEncoding.EncodeToString([]byte(keyPEM))

	pdfBytes := createTestPDF()
	opts := documentRenderOptions{
		Signing: &signingOptions{
			Certificate: b64Cert,
			PrivateKey:  b64Key,
			Name:        "Base64 Signer",
			Reason:      "Audit Trail",
		},
	}

	signedPDF, err := applyPDFSignature(pdfBytes, opts)
	if err != nil {
		t.Fatalf("applyPDFSignature with base64 failed: %v", err)
	}

	resp, err := verifyPDFSignature(signedPDF)
	if err != nil {
		t.Fatalf("verifyPDFSignature failed: %v", err)
	}
	if len(resp.Signers) != 1 {
		t.Errorf("expected 1 signer, found %d", len(resp.Signers))
	}
}

func TestPDFSigningInMergePDFStreams(t *testing.T) {
	certPEM, keyPEM, err := generateSelfSignedTestCertificate("Merge Signer")
	if err != nil {
		t.Fatalf("failed to generate test certificate: %v", err)
	}

	pdf1 := []byte(minimalValidPDF)
	pdf2 := []byte(minimalValidPDF)

	opts := documentRenderOptions{
		Signing: &signingOptions{
			Certificate: certPEM,
			PrivateKey:  keyPEM,
			Name:        "Merge Signer",
			Reason:      "Merged Contract Signature",
		},
	}

	merged, pageCount, err := mergePDFStreams([][]byte{pdf1, pdf2}, opts)
	if err != nil {
		t.Fatalf("mergePDFStreams with signing failed: %v", err)
	}

	if pageCount != 2 {
		t.Errorf("expected pageCount 2, got %d", pageCount)
	}

	resp, err := verifyPDFSignature(merged)
	if err != nil {
		t.Fatalf("verifyPDFSignature on merged PDF failed: %v", err)
	}
	if len(resp.Signers) != 1 {
		t.Errorf("expected 1 signer on merged PDF, got %d", len(resp.Signers))
	}
}

func TestValidateDocumentSigningOptions(t *testing.T) {
	t.Run("missing certificate and kmsKeyId", func(t *testing.T) {
		opts := documentRenderOptions{
			Signing: &signingOptions{},
		}
		err := validateDocumentOptions(&opts)
		var rErr *renderError
		if !errors.As(err, &rErr) || rErr.Code != "document_signing_certificate_required" {
			t.Errorf("expected document_signing_certificate_required, got: %v", err)
		}
	})

	t.Run("certificate exceeds size limit", func(t *testing.T) {
		opts := documentRenderOptions{
			Signing: &signingOptions{
				Certificate: strings.Repeat("A", 70000),
			},
		}
		err := validateDocumentOptions(&opts)
		var rErr *renderError
		if !errors.As(err, &rErr) || rErr.Code != "document_signing_certificate_too_large" {
			t.Errorf("expected document_signing_certificate_too_large, got: %v", err)
		}
	})

	t.Run("conflict with password encryption", func(t *testing.T) {
		opts := documentRenderOptions{
			Password: "secretPassword",
			Signing: &signingOptions{
				Certificate: "dummy-cert",
			},
		}
		err := validateDocumentOptions(&opts)
		var rErr *renderError
		if !errors.As(err, &rErr) || rErr.Code != "document_signing_encrypted_unsupported" {
			t.Errorf("expected document_signing_encrypted_unsupported, got: %v", err)
		}
	})

	t.Run("invalid credentials parsing", func(t *testing.T) {
		opts := documentRenderOptions{
			Signing: &signingOptions{
				Certificate: "invalid-pem-data",
				PrivateKey:  "invalid-key-data",
			},
		}
		_, err := applyPDFSignature([]byte(minimalValidPDF), opts)
		if err == nil {
			t.Errorf("expected error parsing invalid credentials, got nil")
		}
	})
}

func createTestPDF() []byte {
	merged, _, err := mergePDFStreams([][]byte{[]byte(minimalValidPDF), []byte(minimalValidPDF)}, documentRenderOptions{})
	if err != nil {
		panic(err)
	}
	return merged
}
