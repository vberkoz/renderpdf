package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/s3"
)

const pdfDownloadTTL = 15 * time.Minute

// privateAccountObjectPrefix scopes objects to an opaque account-derived
// prefix. Raw account IDs never appear in S3 paths, logs, or download URLs.
func privateAccountObjectPrefix(ownerID string) string {
	if ownerID == "" {
		return "trial"
	}
	digest := sha256.Sum256([]byte(ownerID))
	return hex.EncodeToString(digest[:])
}

func sourceDefinitionObjectKey(ownerID, sourceID string) string {
	return fmt.Sprintf("sources/%s/%s/definition.json", privateAccountObjectPrefix(ownerID), sourceID)
}

func renderedPDFObjectKey(ownerID, fileID string) string {
	return fmt.Sprintf("files/%s/%s.pdf", privateAccountObjectPrefix(ownerID), fileID)
}

func batchArtifactObjectKey(ownerID, jobID, artifactID string) string {
	return fmt.Sprintf("batches/%s/%s/%s", privateAccountObjectPrefix(ownerID), jobID, artifactID)
}

// storeSourceDefinition is the persistence seam used by the upcoming saved
// source API. Definitions stay in the private PDF bucket under the sources/
// prefix; callers persist the returned key and checksum in DocumentStoreTable.
func storeSourceDefinition(ownerID, sourceID string, definition []byte) (string, error) {
	key := sourceDefinitionObjectKey(ownerID, sourceID)
	_, err := s3Client.PutObject(&s3.PutObjectInput{
		Bucket:               aws.String(bucketName),
		Key:                  aws.String(key),
		Body:                 bytes.NewReader(definition),
		ContentType:          aws.String("application/json"),
		ServerSideEncryption: aws.String(s3.ServerSideEncryptionAes256),
	})
	if err != nil {
		return "", err
	}
	return key, nil
}

func deletePrivateObject(bucket, key string) error {
	_, err := s3Client.DeleteObject(&s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	return err
}

// presignPDFDownload returns a deliberately short-lived private download URL.
// The object remains private; possession of this URL is the only temporary
// authorization to download it.
func presignPDFDownload(bucket, key string) (string, error) {
	return presignPrivateDownload(bucket, key)
}

func presignPrivateDownload(bucket, key string) (string, error) {
	request, _ := s3Client.GetObjectRequest(&s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	return request.Presign(pdfDownloadTTL)
}
