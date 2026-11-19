package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/s3"
)

const maxBatchZIPBytes = 100 * 1024 * 1024

// downloadBatchOutput materializes completed PDFs into either a merged PDF or a ZIP archive.
// The conservative cap keeps this synchronous API path within Lambda memory.
func downloadBatchOutput(ctx context.Context, r events.APIGatewayProxyRequest, owner string, job batchJobReply, h map[string]string, db *dynamodb.DynamoDB) events.APIGatewayProxyResponse {
	if job.SucceededCount == 0 {
		return errorResponseWithCode(409, "batch_outputs_unavailable", "No completed PDFs are available", h)
	}

	format := strings.ToLower(strings.TrimSpace(r.QueryStringParameters["format"]))
	mergeRequested := false
	raw, err := db.GetItemWithContext(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(batchTable()),
		Key:            batchJobKey(owner, job.JobID),
		ConsistentRead: aws.Bool(true),
	})
	if err == nil && raw.Item != nil && raw.Item["request"] != nil {
		var req batchRenderRequest
		if json.Unmarshal([]byte(aws.StringValue(raw.Item["request"].S)), &req) == nil {
			mergeRequested = req.Options.MergeOutput
		}
	}

	shouldMerge := (format == "pdf" || format == "merge" || format == "merged") || (mergeRequested && format != "zip")

	if shouldMerge {
		artifactID, fileID := "merged.pdf", "file_batch_"+job.JobID+"_merged"
		if existing, err := fileStoreFactory().Get(ctx, owner, fileID); err == nil {
			url, signErr := presignPrivateDownload(existing.Bucket, existing.ObjectKey)
			if signErr != nil {
				return errorResponse(503, "Batch download is temporarily unavailable", h)
			}
			return sourceJSON(200, map[string]string{"fileId": fileID, "url": url, "format": "pdf"}, h)
		}

		items, err := db.QueryWithContext(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(batchTable()),
			KeyConditionExpression: aws.String("PK = :pk"),
			ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
				":pk": {S: aws.String("JOB#" + job.JobID)},
			},
		})
		if err != nil {
			return errorResponse(503, "Batch storage is temporarily unavailable", h)
		}

		sort.Slice(items.Items, func(i, j int) bool {
			return batchNumber(items.Items[i], "ordinal", 0) < batchNumber(items.Items[j], "ordinal", 0)
		})

		pdfSlices := make([][]byte, 0, len(items.Items))
		for _, item := range items.Items {
			outputFileID := aws.StringValue(item["outputFileId"].S)
			if outputFileID == "" || aws.StringValue(item["status"].S) != "succeeded" {
				continue
			}
			file, err := fileStoreFactory().Get(ctx, owner, outputFileID)
			if err != nil {
				return errorResponse(503, "Batch output is temporarily unavailable", h)
			}
			object, err := s3Client.GetObjectWithContext(ctx, &s3.GetObjectInput{
				Bucket: aws.String(file.Bucket),
				Key:    aws.String(file.ObjectKey),
			})
			if err != nil {
				return errorResponse(503, "Batch output is temporarily unavailable", h)
			}
			content, err := io.ReadAll(object.Body)
			object.Body.Close()
			if err != nil {
				return errorResponse(503, "Batch output could not be read", h)
			}
			pdfSlices = append(pdfSlices, content)
		}

		if len(pdfSlices) == 0 {
			return errorResponseWithCode(409, "batch_outputs_unavailable", "No completed PDFs are available to merge", h)
		}

		var merged []byte
		if len(pdfSlices) == 1 {
			merged = pdfSlices[0]
		} else {
			mergedBytes, _, err := mergePDFStreams(pdfSlices, documentRenderOptions{})
			if err != nil {
				return errorResponse(500, fmt.Sprintf("Batch merge failed: %v", err), h)
			}
			merged = mergedBytes
		}

		key := batchArtifactObjectKey(owner, job.JobID, artifactID)
		if _, err := s3Client.PutObjectWithContext(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(bucketName),
			Key:         aws.String(key),
			Body:        bytes.NewReader(merged),
			ContentType: aws.String("application/pdf"),
		}); err != nil {
			return errorResponse(503, "Batch merged PDF could not be stored", h)
		}

		expires := time.Now().UTC().Add(maxPDFRetentionDays * 24 * time.Hour)
		if err := fileStoreFactory().Create(ctx, storedFile{
			ID:                 fileID,
			Kind:               "batch_merged_pdf",
			ContentType:        "application/pdf",
			SizeBytes:          int64(len(merged)),
			RetentionExpiresAt: &expires,
			Origin:             map[string]string{"jobId": job.JobID, "format": "merged_pdf"},
			OwnerID:            owner,
			Bucket:             bucketName,
			ObjectKey:          key,
			CreatedAt:          time.Now().UTC(),
		}); err != nil {
			return errorResponse(503, "Batch merged PDF metadata could not be stored", h)
		}

		url, err := presignPrivateDownload(bucketName, key)
		if err != nil {
			return errorResponse(503, "Batch download is temporarily unavailable", h)
		}
		return sourceJSON(200, map[string]string{"fileId": fileID, "url": url, "format": "pdf"}, h)
	}

	artifactID, fileID := "results.zip", "file_batch_"+job.JobID+"_results"
	if existing, err := fileStoreFactory().Get(ctx, owner, fileID); err == nil {
		url, signErr := presignPrivateDownload(existing.Bucket, existing.ObjectKey)
		if signErr != nil {
			return errorResponse(503, "Batch download is temporarily unavailable", h)
		}
		return sourceJSON(200, map[string]string{"fileId": fileID, "url": url}, h)
	}
	items, err := db.QueryWithContext(ctx, &dynamodb.QueryInput{TableName: aws.String(batchTable()), KeyConditionExpression: aws.String("PK = :pk"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":pk": {S: aws.String("JOB#" + job.JobID)}}})
	if err != nil {
		return errorResponse(503, "Batch storage is temporarily unavailable", h)
	}
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, item := range items.Items {
		fileID := aws.StringValue(item["outputFileId"].S)
		if fileID == "" {
			continue
		}
		file, err := fileStoreFactory().Get(ctx, owner, fileID)
		if err != nil {
			return errorResponse(503, "Batch output is temporarily unavailable", h)
		}
		object, err := s3Client.GetObjectWithContext(ctx, &s3.GetObjectInput{Bucket: aws.String(file.Bucket), Key: aws.String(file.ObjectKey)})
		if err != nil {
			return errorResponse(503, "Batch output is temporarily unavailable", h)
		}
		entry, err := writer.Create(fmt.Sprintf("%03d-%s.pdf", batchNumber(item, "ordinal", 0), fileID))
		if err == nil {
			_, err = io.Copy(entry, object.Body)
		}
		object.Body.Close()
		if err != nil || output.Len() > maxBatchZIPBytes {
			return errorResponseWithCode(413, "batch_zip_too_large", "Batch ZIP exceeds the 100 MB export limit", h)
		}
	}
	if err := writer.Close(); err != nil {
		return errorResponse(503, "Batch ZIP could not be created", h)
	}
	key := batchArtifactObjectKey(owner, job.JobID, artifactID)
	if _, err := s3Client.PutObjectWithContext(ctx, &s3.PutObjectInput{Bucket: aws.String(bucketName), Key: aws.String(key), Body: bytes.NewReader(output.Bytes()), ContentType: aws.String("application/zip")}); err != nil {
		return errorResponse(503, "Batch ZIP could not be stored", h)
	}
	expires := time.Now().UTC().Add(maxPDFRetentionDays * 24 * time.Hour)
	if err := fileStoreFactory().Create(ctx, storedFile{ID: fileID, Kind: "batch_zip", ContentType: "application/zip", SizeBytes: int64(output.Len()), RetentionExpiresAt: &expires, Origin: map[string]string{"jobId": job.JobID}, OwnerID: owner, Bucket: bucketName, ObjectKey: key, CreatedAt: time.Now().UTC()}); err != nil {
		return errorResponse(503, "Batch ZIP metadata could not be stored", h)
	}
	url, err := presignPrivateDownload(bucketName, key)
	if err != nil {
		return errorResponse(503, "Batch download is temporarily unavailable", h)
	}
	return sourceJSON(200, map[string]string{"fileId": fileID, "url": url}, h)
}
