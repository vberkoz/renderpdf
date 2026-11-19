package main

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/kms"
	"github.com/digitorus/pdf"
	"github.com/digitorus/pdfsign/sign"
	"github.com/digitorus/pdfsign/verify"
	"golang.org/x/crypto/pkcs12"
)

// kmsSigner implements crypto.Signer by delegating hash signing to AWS KMS.
type kmsSigner struct {
	client    *kms.KMS
	keyID     string
	publicKey crypto.PublicKey
}

func (k *kmsSigner) Public() crypto.PublicKey {
	return k.publicKey
}

func (k *kmsSigner) Sign(r io.Reader, digest []byte, opts crypto.SignerOpts) ([]byte, error) {
	algorithm := "RSASSA_PKCS1_V1_5_SHA_256"
	if _, ok := k.publicKey.(*ecdsa.PublicKey); ok {
		algorithm = "ECDSA_SHA_256"
	}
	output, err := k.client.Sign(&kms.SignInput{
		KeyId:            aws.String(k.keyID),
		Message:          digest,
		MessageType:      aws.String("DIGEST"),
		SigningAlgorithm: aws.String(algorithm),
	})
	if err != nil {
		return nil, fmt.Errorf("kms sign: %w", err)
	}
	return output.Signature, nil
}

// parseSigningCredentials extracts an x509 Certificate and crypto.Signer from PEM or PKCS#12 options.
func parseSigningCredentials(opts signingOptions) (*x509.Certificate, crypto.Signer, error) {
	// Case 1: AWS KMS Key ARN or ID
	if opts.KmsKeyID != "" {
		kmsClient := kms.New(sess)
		pubKeyOut, err := kmsClient.GetPublicKey(&kms.GetPublicKeyInput{KeyId: aws.String(opts.KmsKeyID)})
		if err != nil {
			return nil, nil, fmt.Errorf("load kms public key: %w", err)
		}
		pubKey, err := x509.ParsePKIXPublicKey(pubKeyOut.PublicKey)
		if err != nil {
			return nil, nil, fmt.Errorf("parse kms public key: %w", err)
		}

		var cert *x509.Certificate
		if opts.Certificate != "" {
			certBytes := []byte(opts.Certificate)
			if decoded, err := base64.StdEncoding.DecodeString(opts.Certificate); err == nil && len(decoded) > 0 {
				certBytes = decoded
			}
			block, _ := pem.Decode(certBytes)
			if block != nil {
				cert, err = x509.ParseCertificate(block.Bytes)
			} else {
				cert, err = x509.ParseCertificate(certBytes)
			}
			if err != nil {
				return nil, nil, fmt.Errorf("parse x509 certificate for kms signer: %w", err)
			}
		} else {
			// Generate self-signed certificate wrapper for the KMS public key
			cert = &x509.Certificate{
				SerialNumber: big.NewInt(1),
				Subject: pkix.Name{
					CommonName:   opts.Name,
					Organization: []string{"RenderPDF Certified"},
				},
				NotBefore: time.Now().Add(-1 * time.Hour),
				NotAfter:  time.Now().Add(365 * 24 * time.Hour),
				KeyUsage:  x509.KeyUsageDigitalSignature,
			}
		}

		signer := &kmsSigner{client: kmsClient, keyID: opts.KmsKeyID, publicKey: pubKey}
		return cert, signer, nil
	}

	rawCert := strings.TrimSpace(opts.Certificate)
	if rawCert == "" {
		return nil, nil, errors.New("signing.certificate or signing.kmsKeyId is required")
	}

	var certBytes []byte
	if decoded, err := base64.StdEncoding.DecodeString(rawCert); err == nil && len(decoded) > 0 {
		certBytes = decoded
	} else {
		certBytes = []byte(rawCert)
	}

	// Try PKCS#12 / PFX format first
	if priv, cert, err := pkcs12.Decode(certBytes, opts.Password); err == nil && cert != nil {
		signer, ok := priv.(crypto.Signer)
		if !ok {
			return nil, nil, fmt.Errorf("private key in pkcs12 does not implement crypto.Signer")
		}
		return cert, signer, nil
	}

	// Try PEM format
	var cert *x509.Certificate
	var signer crypto.Signer

	// Parse Certificate PEM
	rest := certBytes
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type == "CERTIFICATE" && cert == nil {
			c, err := x509.ParseCertificate(block.Bytes)
			if err == nil {
				cert = c
			}
		} else if strings.Contains(block.Type, "PRIVATE KEY") && signer == nil {
			s, err := parsePrivateKeyPEM(block.Bytes, block.Type)
			if err == nil {
				signer = s
			}
		}
	}

	// If private key is passed separately
	if signer == nil && strings.TrimSpace(opts.PrivateKey) != "" {
		rawPriv := strings.TrimSpace(opts.PrivateKey)
		var privBytes []byte
		if decoded, err := base64.StdEncoding.DecodeString(rawPriv); err == nil && len(decoded) > 0 {
			privBytes = decoded
		} else {
			privBytes = []byte(rawPriv)
		}
		block, _ := pem.Decode(privBytes)
		if block != nil {
			s, err := parsePrivateKeyPEM(block.Bytes, block.Type)
			if err != nil {
				return nil, nil, fmt.Errorf("parse private key: %w", err)
			}
			signer = s
		}
	}

	if cert == nil {
		return nil, nil, errors.New("could not find valid X.509 certificate in signing.certificate")
	}
	if signer == nil {
		return nil, nil, errors.New("could not find private key in signing.certificate or signing.privateKey")
	}

	return cert, signer, nil
}

func parsePrivateKeyPEM(der []byte, blockType string) (crypto.Signer, error) {
	if blockType == "RSA PRIVATE KEY" {
		return x509.ParsePKCS1PrivateKey(der)
	}
	if blockType == "EC PRIVATE KEY" {
		return x509.ParseECPrivateKey(der)
	}
	// PKCS#8
	key, err := x509.ParsePKCS8PrivateKey(der)
	if err == nil {
		if signer, ok := key.(crypto.Signer); ok {
			return signer, nil
		}
		return nil, errors.New("parsed PKCS#8 key does not implement crypto.Signer")
	}
	return nil, err
}

// applyPDFSignature cryptographically signs a PDF byte stream using an X.509 PKCS#7 detached signature.
func applyPDFSignature(pdfBytes []byte, options documentRenderOptions) ([]byte, error) {
	if options.Signing == nil {
		return pdfBytes, nil
	}

	cert, signer, err := parseSigningCredentials(*options.Signing)
	if err != nil {
		return nil, fmt.Errorf("pdf signing credentials: %w", err)
	}

	signName := options.Signing.Name
	if signName == "" && cert.Subject.CommonName != "" {
		signName = cert.Subject.CommonName
	}

	signData := sign.SignData{
		Signature: sign.SignDataSignature{
			Info: sign.SignDataSignatureInfo{
				Name:        signName,
				Reason:      options.Signing.Reason,
				Location:    options.Signing.Location,
				ContactInfo: options.Signing.ContactInfo,
				Date:        time.Now().UTC(),
			},
		},
		Signer:          signer,
		DigestAlgorithm: crypto.SHA256,
		Certificate:     cert,
	}

	r := bytes.NewReader(pdfBytes)
	size := int64(len(pdfBytes))
	pdfRdr, err := pdf.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("read pdf for signing: %w", err)
	}

	var out bytes.Buffer
	if err := sign.Sign(r, &out, pdfRdr, size, signData); err != nil {
		return nil, fmt.Errorf("sign pdf: %w", err)
	}

	return out.Bytes(), nil
}

// verifyPDFSignature checks cryptographic digital signatures present on a PDF byte stream.
func verifyPDFSignature(pdfBytes []byte) (*verify.Response, error) {
	r := bytes.NewReader(pdfBytes)
	size := int64(len(pdfBytes))
	return verify.Verify(r, size)
}

// generateSelfSignedTestCertificate creates an in-memory RSA key and self-signed X.509 certificate for testing.
func generateSelfSignedTestCertificate(cn string) (certPEM string, keyPEM string, err error) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", "", err
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject: pkix.Name{
			CommonName:   cn,
			Organization: []string{"RenderPDF Test Org"},
		},
		NotBefore: time.Now().Add(-1 * time.Hour),
		NotAfter:  time.Now().Add(24 * time.Hour),
		KeyUsage:  x509.KeyUsageDigitalSignature,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return "", "", err
	}

	var certBuf bytes.Buffer
	pem.Encode(&certBuf, &pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	var keyBuf bytes.Buffer
	pem.Encode(&keyBuf, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})

	return certBuf.String(), keyBuf.String(), nil
}
