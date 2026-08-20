package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/google/uuid"
)

const (
	packageUploadResource = "/api/v1/uploads"
	packageUploadTTL      = 15 * time.Minute
	maxPackageBytes       = 25 * 1024 * 1024
	maxExtractedBytes     = 50 * 1024 * 1024
	maxPackageFiles       = 500
)

type packageUploadResponse struct {
	UploadID  string `json:"uploadId"`
	UploadURL string `json:"uploadUrl"`
	ExpiresAt string `json:"expiresAt"`
	MaxBytes  int64  `json:"maxBytes"`
}

type packageRenderRequest struct {
	UploadID      string `json:"uploadId"`
	Entrypoint    string `json:"entrypoint,omitempty"`
	WebhookURL    string `json:"webhookUrl,omitempty"`
	WebhookSecret string `json:"webhookSecret,omitempty"`
}

func isPackageUploadRequest(request events.APIGatewayProxyRequest) bool {
	return request.Resource == packageUploadResource || request.Path == packageUploadResource
}

func createPackageUpload(owner string) (packageUploadResponse, error) {
	if packageBucketName == "" || owner == "" {
		return packageUploadResponse{}, errors.New("package uploads are unavailable")
	}
	uploadID := uuid.New().String()
	key := packageObjectKey(owner, uploadID)
	request, _ := s3Client.PutObjectRequest(&s3.PutObjectInput{
		Bucket: aws.String(packageBucketName),
		Key:    aws.String(key),
	})
	expiresAt := time.Now().UTC().Add(packageUploadTTL)
	uploadURL, err := request.Presign(packageUploadTTL)
	if err != nil {
		return packageUploadResponse{}, fmt.Errorf("presign package upload: %w", err)
	}
	retention := time.Now().UTC().Add(24 * time.Hour)
	if err := fileStoreFactory().Create(context.Background(), storedFile{ID: "file_" + uploadID, Kind: "uploaded_package", ContentType: "application/zip", SizeBytes: 0, RetentionExpiresAt: &retention, Origin: map[string]string{"uploadId": uploadID}, OwnerID: owner, Bucket: packageBucketName, ObjectKey: key, CreatedAt: time.Now().UTC()}); err != nil {
		return packageUploadResponse{}, fmt.Errorf("save upload metadata: %w", err)
	}
	return packageUploadResponse{
		UploadID: uploadID, UploadURL: uploadURL, ExpiresAt: expiresAt.Format(time.RFC3339), MaxBytes: maxPackageBytes,
	}, nil
}

// packageObjectKey makes packages private to the API-key owner without storing
// customer identifiers in object keys.
func packageObjectKey(owner, uploadID string) string {
	return fmt.Sprintf("uploads/%s/%s.zip", privateAccountObjectPrefix(owner), uploadID)
}

// preparePackage downloads a customer ZIP, expands only normal relative files,
// and returns a file:// URL for the package HTML entrypoint. The caller owns the
// cleanup function and must invoke it once Chrome has finished reading assets.
func preparePackage(ctx context.Context, owner, uploadID, entrypoint string) (string, int64, func(), error) {
	if packageBucketName == "" {
		return "", 0, nil, errors.New("package uploads are unavailable")
	}
	if _, err := uuid.Parse(uploadID); err != nil {
		return "", 0, nil, errors.New("uploadId must be a UUID")
	}
	entrypoint, err := cleanPackagePath(entrypoint)
	if err != nil {
		return "", 0, nil, err
	}
	if entrypoint == "" {
		entrypoint = "index.html"
	}
	if !strings.HasSuffix(strings.ToLower(entrypoint), ".html") {
		return "", 0, nil, errors.New("entrypoint must be an HTML file")
	}

	object, err := s3Client.GetObjectWithContext(ctx, &s3.GetObjectInput{
		Bucket: aws.String(packageBucketName), Key: aws.String(packageObjectKey(owner, uploadID)),
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && (awsErr.Code() == s3.ErrCodeNoSuchKey || awsErr.Code() == "NotFound") {
			return "", 0, nil, errors.New("upload was not found")
		}
		return "", 0, nil, errors.New("upload is unavailable")
	}
	defer object.Body.Close()
	if object.ContentLength == nil || *object.ContentLength <= 0 {
		return "", 0, nil, errors.New("uploaded package is empty")
	}
	if *object.ContentLength > maxPackageBytes {
		return "", 0, nil, fmt.Errorf("uploaded package exceeds the %d MB limit", maxPackageBytes/(1024*1024))
	}
	contents, err := io.ReadAll(io.LimitReader(object.Body, maxPackageBytes+1))
	if err != nil || int64(len(contents)) > maxPackageBytes {
		return "", 0, nil, errors.New("could not read uploaded package")
	}

	archive, err := zip.NewReader(bytes.NewReader(contents), int64(len(contents)))
	if err != nil {
		return "", 0, nil, errors.New("uploaded file must be a valid ZIP archive")
	}
	if len(archive.File) == 0 || len(archive.File) > maxPackageFiles {
		return "", 0, nil, fmt.Errorf("package must contain between 1 and %d files", maxPackageFiles)
	}

	root := filepath.Join("/tmp", "renderpdf-package-"+uuid.New().String())
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", 0, nil, errors.New("could not prepare uploaded package")
	}
	cleanup := func() { _ = os.RemoveAll(root) }
	var extracted int64
	for _, file := range archive.File {
		name, err := cleanPackagePath(file.Name)
		if err != nil {
			cleanup()
			return "", 0, nil, err
		}
		if name == "" {
			continue
		}
		if strings.HasSuffix(file.Name, "/") {
			continue
		}
		if file.FileInfo().Mode()&os.ModeSymlink != 0 || !file.FileInfo().Mode().IsRegular() {
			cleanup()
			return "", 0, nil, fmt.Errorf("package file %q is not a regular file", file.Name)
		}
		extracted += int64(file.UncompressedSize64)
		if extracted > maxExtractedBytes {
			cleanup()
			return "", 0, nil, fmt.Errorf("extracted package exceeds the %d MB limit", maxExtractedBytes/(1024*1024))
		}
		destination := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			cleanup()
			return "", 0, nil, errors.New("could not extract uploaded package")
		}
		input, err := file.Open()
		if err != nil {
			cleanup()
			return "", 0, nil, errors.New("could not read uploaded package")
		}
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if err == nil {
			_, err = io.Copy(output, input)
			closeErr := output.Close()
			if err == nil {
				err = closeErr
			}
		}
		_ = input.Close()
		if err != nil {
			cleanup()
			return "", 0, nil, errors.New("could not extract uploaded package")
		}
	}
	entryPath := filepath.Join(root, filepath.FromSlash(entrypoint))
	info, err := os.Stat(entryPath)
	if err != nil || !info.Mode().IsRegular() {
		cleanup()
		return "", 0, nil, fmt.Errorf("package does not contain entrypoint %q", entrypoint)
	}
	if err := injectPackageCSP(entryPath); err != nil {
		cleanup()
		return "", 0, nil, errors.New("could not prepare package entrypoint")
	}
	return (&url.URL{Scheme: "file", Path: entryPath}).String(), int64(len(contents)), cleanup, nil
}

// Uploaded packages are allowed to use their own local scripts and styles, but
// may not fetch network resources from the Lambda environment.
func injectPackageCSP(entryPath string) error {
	contents, err := os.ReadFile(entryPath)
	if err != nil {
		return err
	}
	const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; base-uri 'none'; connect-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'">`
	text := rewriteTfoot(ensureColgroup(injectPrintCSS(string(contents))))
	if index := strings.Index(strings.ToLower(text), "</head>"); index >= 0 {
		text = text[:index] + policy + text[index:]
	} else {
		text = policy + text
	}
	return os.WriteFile(entryPath, []byte(text), 0600)
}

func cleanPackagePath(value string) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if value == "" {
		return "", nil
	}
	if strings.HasPrefix(value, "/") || strings.HasPrefix(value, "../") || value == ".." {
		return "", errors.New("package paths must be relative")
	}
	cleaned := filepath.ToSlash(filepath.Clean(value))
	if cleaned == "." {
		return "", nil
	}
	if strings.HasPrefix(cleaned, "../") || cleaned == ".." {
		return "", errors.New("package paths must be relative")
	}
	return cleaned, nil
}
