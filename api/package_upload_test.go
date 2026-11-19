package main

import (
	"context"
	"net/http"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/credentials"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/s3"
)

func TestCleanPackagePath(t *testing.T) {
	tests := []struct {
		input string
		want  string
		valid bool
	}{
		{"index.html", "index.html", true},
		{"assets/../style.css", "style.css", true},
		{"assets\\site.css", "assets/site.css", true},
		{"../secret.html", "", false},
		{"/etc/passwd", "", false},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			got, err := cleanPackagePath(test.input)
			if (err == nil) != test.valid || got != test.want {
				t.Fatalf("cleanPackagePath(%q) = %q, %v; want %q, valid=%v", test.input, got, err, test.want, test.valid)
			}
		})
	}
}

func TestPackageObjectKeyDoesNotExposeOwner(t *testing.T) {
	key := packageObjectKey("customer@example.com", "123e4567-e89b-12d3-a456-426614174000")
	if key == "" || key == "uploads/customer@example.com/123e4567-e89b-12d3-a456-426614174000.zip" {
		t.Fatalf("package key exposed owner: %q", key)
	}
}

func TestPackageUploadEndpointEmitsDeprecationHeaders(t *testing.T) {
	prevPackageBucket := packageBucketName
	prevS3Client := s3Client
	prevFileStoreFactory := fileStoreFactory
	t.Cleanup(func() {
		packageBucketName = prevPackageBucket
		s3Client = prevS3Client
		fileStoreFactory = prevFileStoreFactory
	})

	packageBucketName = "test-packages"
	s3Client = s3.New(session.Must(session.NewSession(&aws.Config{
		Region:      aws.String("us-east-1"),
		Credentials: credentials.NewStaticCredentials("test", "test", ""),
	})))
	fileStoreFactory = func() fileStore { return noopTestFileStore{} }

	legacyResp, err := handler(context.Background(), events.APIGatewayProxyRequest{
		HTTPMethod: http.MethodPost,
		Resource:   packageUploadResource,
		Path:       packageUploadResource,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-upload-1"},
		},
	})
	if err != nil {
		t.Fatalf("legacy upload handler error = %v", err)
	}
	if legacyResp.StatusCode != http.StatusOK {
		t.Fatalf("legacy upload status = %d, want 200; body=%s", legacyResp.StatusCode, legacyResp.Body)
	}
	if legacyResp.Headers["Deprecation"] != "true" {
		t.Fatalf("Deprecation header = %q, want true", legacyResp.Headers["Deprecation"])
	}
	if legacyResp.Headers["Sunset"] != "Wed, 30 Dec 2026 23:59:59 GMT" {
		t.Fatalf("Sunset header = %q, want Wed, 30 Dec 2026 23:59:59 GMT", legacyResp.Headers["Sunset"])
	}
	if legacyResp.Headers["Link"] != `</api/v1/files/upload>; rel="successor-version"` {
		t.Fatalf("Link header = %q, want </api/v1/files/upload>; rel=\"successor-version\"", legacyResp.Headers["Link"])
	}

	canonicalResp, err := handler(context.Background(), events.APIGatewayProxyRequest{
		HTTPMethod: http.MethodPost,
		Resource:   fileUploadResource,
		Path:       fileUploadResource,
		RequestContext: events.APIGatewayProxyRequestContext{
			Authorizer: map[string]interface{}{"userId": "customer-upload-1"},
		},
	})
	if err != nil {
		t.Fatalf("canonical upload handler error = %v", err)
	}
	if canonicalResp.StatusCode != http.StatusCreated {
		t.Fatalf("canonical upload status = %d, want 201; body=%s", canonicalResp.StatusCode, canonicalResp.Body)
	}
	if _, ok := canonicalResp.Headers["Deprecation"]; ok {
		t.Fatalf("canonical %s must not emit Deprecation header: %#v", fileUploadResource, canonicalResp.Headers)
	}
}
