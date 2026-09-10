package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/s3"
)

// batchWorkerHandler claims each queued item conditionally. A redelivered SQS
// message sees a non-queued item and becomes a no-op, preventing duplicate PDFs.
func batchWorkerHandler(ctx context.Context, event events.SQSEvent) error {
	for _, record := range event.Records {
		var message batchQueueMessage
		if err := json.Unmarshal([]byte(record.Body), &message); err != nil {
			continue
		}
		if err := processBatchItem(ctx, message); err != nil {
			return err
		}
	}
	return nil
}

// DynamoDB INSERT records form a durable batch outbox. Stream retries cover
// SQS outages even when the original caller never polls the job again.
func batchOutboxDispatcherHandler(ctx context.Context, event events.DynamoDBEvent) error {
	db := dynamodb.New(sess)
	for _, record := range event.Records {
		entity, hasEntity := record.Change.NewImage["entityType"]
		ownerValue, hasOwner := record.Change.NewImage["ownerID"]
		jobValue, hasJob := record.Change.NewImage["PK"]
		ordinalValue, hasOrdinal := record.Change.NewImage["ordinal"]
		if record.EventName != "INSERT" || !hasEntity || entity.String() != "BATCH_ITEM" || !hasOwner || !hasJob || !hasOrdinal {
			continue
		}

		owner := ownerValue.String()
		jobID := strings.TrimPrefix(jobValue.String(), "JOB#")
		ordinal, err := strconv.Atoi(ordinalValue.Number())
		if owner == "" || jobID == "" || err != nil {
			continue
		}
		item, err := db.GetItemWithContext(ctx, &dynamodb.GetItemInput{
			TableName:      aws.String(batchTable()),
			Key:            batchItemKey(jobID, ordinal),
			ConsistentRead: aws.Bool(true),
		})
		if err != nil {
			return err
		}
		if item.Item == nil || !claimBatchEnqueue(ctx, db, item.Item) {
			continue
		}
		if err := enqueueBatchItem(owner, jobID, ordinal); err != nil {
			resetBatchEnqueue(ctx, db, item.Item)
			return err
		}
		// If this acknowledgement fails after SendMessage succeeds, the stream
		// retries and can produce one duplicate message; the worker's
		// conditional claim makes that at-least-once delivery safe.
		if err := markBatchEnqueued(ctx, db, item.Item); err != nil {
			return err
		}
	}
	return nil
}

// batchRetryExhaustedHandler consumes the batch DLQ. A transient rendering or
// storage error leaves an item running while SQS retries it; after the queue's
// redrive limit, this handler makes that state terminal instead of stranding
// the job indefinitely.
func batchRetryExhaustedHandler(ctx context.Context, event events.SQSEvent) error {
	for _, record := range event.Records {
		var message batchQueueMessage
		if err := json.Unmarshal([]byte(record.Body), &message); err != nil {
			// A malformed queue message has no item we can reconcile.
			continue
		}
		if err := failRetryExhaustedBatchItem(ctx, message); err != nil {
			return err
		}
	}
	return nil
}

func failRetryExhaustedBatchItem(ctx context.Context, message batchQueueMessage) error {
	db := dynamodb.New(sess)
	key := batchItemKey(message.JobID, message.Ordinal)
	item, err := db.GetItemWithContext(ctx, &dynamodb.GetItemInput{TableName: aws.String(batchTable()), Key: key, ConsistentRead: aws.Bool(true)})
	if err != nil {
		return err
	}
	if item.Item == nil {
		return nil
	}
	status := aws.StringValue(item.Item["status"].S)
	if status != "queued" && status != "running" {
		return nil
	}
	activeCounter := "queuedCount"
	if status == "running" {
		activeCounter = "runningCount"
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = db.TransactWriteItemsWithContext(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: []*dynamodb.TransactWriteItem{
		{Update: &dynamodb.Update{TableName: aws.String(batchTable()), Key: key, UpdateExpression: aws.String("SET #status = :failed, errorCode = :code"), ConditionExpression: aws.String("#status = :active"), ExpressionAttributeNames: map[string]*string{"#status": aws.String("status")}, ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":failed": {S: aws.String("failed")}, ":code": {S: aws.String("batch_retry_exhausted")}, ":active": {S: aws.String(status)}}}},
		{Update: &dynamodb.Update{TableName: aws.String(batchTable()), Key: batchJobKey(message.OwnerID, message.JobID), UpdateExpression: aws.String("ADD " + activeCounter + " :minus, failedCount :plus SET updatedAt = :now"), ConditionExpression: aws.String(activeCounter + " >= :one"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":minus": {N: aws.String("-1")}, ":plus": {N: aws.String("1")}, ":one": {N: aws.String("1")}, ":now": {S: aws.String(now)}}}},
	}})
	if err != nil {
		if isBatchTransitionConflict(err) {
			return nil
		}
		return err
	}
	logBatchAudit(batchAuditEvent{Event: "batch_item_retry_exhausted", JobID: message.JobID, Status: "failed", ErrorCode: "batch_retry_exhausted"})
	enqueueBatchTerminalWebhook(ctx, db, message.OwnerID, message.JobID)
	return nil
}

func processBatchItem(ctx context.Context, message batchQueueMessage) error {
	startedAt := time.Now()
	db := dynamodb.New(sess)
	key := batchItemKey(message.JobID, message.Ordinal)
	_, err := db.TransactWriteItemsWithContext(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: []*dynamodb.TransactWriteItem{
		{Update: &dynamodb.Update{TableName: aws.String(batchTable()), Key: key, UpdateExpression: aws.String("SET #status = :running"), ConditionExpression: aws.String("#status = :queued"), ExpressionAttributeNames: map[string]*string{"#status": aws.String("status")}, ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":queued": {S: aws.String("queued")}, ":running": {S: aws.String("running")}}}},
		{Update: &dynamodb.Update{TableName: aws.String(batchTable()), Key: batchJobKey(message.OwnerID, message.JobID), UpdateExpression: aws.String("ADD queuedCount :minus, runningCount :plus SET updatedAt = :now"), ConditionExpression: aws.String("attribute_not_exists(cancelRequested) AND #status = :queued AND queuedCount >= :one"), ExpressionAttributeNames: map[string]*string{"#status": aws.String("status")}, ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":minus": {N: aws.String("-1")}, ":plus": {N: aws.String("1")}, ":one": {N: aws.String("1")}, ":queued": {S: aws.String("queued")}, ":now": {S: aws.String(time.Now().UTC().Format(time.RFC3339Nano))}}}},
	}})
	if err != nil {
		if isBatchTransitionConflict(err) {
			return nil
		}
		return err
	}
	logBatchAudit(batchAuditEvent{Event: "batch_item_claimed", JobID: message.JobID, Status: "running"})
	item, err := db.GetItem(&dynamodb.GetItemInput{TableName: aws.String(batchTable()), Key: key, ConsistentRead: aws.Bool(true)})
	if err != nil || item.Item == nil {
		return err
	}
	job, err := db.GetItem(&dynamodb.GetItemInput{TableName: aws.String(batchTable()), Key: batchJobKey(message.OwnerID, message.JobID), ConsistentRead: aws.Bool(true)})
	if err != nil || job.Item == nil {
		return err
	}
	var request batchRenderRequest
	if err := json.Unmarshal([]byte(aws.StringValue(job.Item["request"].S)), &request); err != nil {
		return completeBatchItem(db, message.OwnerID, message.JobID, key, "failed", "batch_request_invalid", "")
	}
	var input batchRenderItem
	if err := json.Unmarshal([]byte(aws.StringValue(item.Item["input"].S)), &input); err != nil {
		return completeBatchItem(db, message.OwnerID, message.JobID, key, "failed", "batch_item_invalid", "")
	}
	var render canonicalRenderRequest
	if request.Source != nil {
		render = canonicalRenderRequest{Version: "1", Source: canonicalRenderSource{Type: "stored", ID: request.Source.ID}, Data: input.Data}
	} else {
		render = *input.Definition
	}
	body, _ := json.Marshal(render)
	normalized, err := normalizeCanonicalRenderRequestWithOwner(ctx, string(body), message.OwnerID)
	if err != nil {
		return completeBatchItem(db, message.OwnerID, message.JobID, key, "failed", "batch_item_validation_failed", "")
	}
	pdf, err := renderBatchNormalizedSource(ctx, message.OwnerID, normalized)
	if err != nil {
		if renderErr, ok := err.(*renderError); ok && renderErr.Status >= 400 && renderErr.Status < 500 {
			return completeBatchItem(db, message.OwnerID, message.JobID, key, "failed", "batch_item_validation_failed", "")
		}
		return err
	}
	fileID := "file_batch_" + message.JobID + fmt.Sprintf("_%06d", message.Ordinal)
	objectKey := renderedPDFObjectKey(message.OwnerID, fileID)
	if err := ensurePrivateFileStorage(ctx, message.OwnerID, int64(len(pdf))); err != nil {
		return completeBatchItem(db, message.OwnerID, message.JobID, key, "failed", "file_storage_limit_reached", "")
	}
	if _, err = s3Client.PutObject(&s3.PutObjectInput{Bucket: aws.String(bucketName), Key: aws.String(objectKey), Body: bytes.NewReader(pdf)}); err != nil {
		return err
	}
	createdAt := time.Now().UTC()
	expires := createdAt.Add(maxPDFRetentionDays * 24 * time.Hour)
	if err := fileStoreFactory().Create(ctx, storedFile{ID: fileID, Kind: "rendered_pdf", ContentType: "application/pdf", SizeBytes: int64(len(pdf)), DisplayName: normalized.Label, OwnerID: message.OwnerID, Bucket: bucketName, ObjectKey: objectKey, RetentionExpiresAt: &expires, Origin: map[string]string{"jobId": message.JobID}, CreatedAt: createdAt}); err != nil {
		// A retry can reach this point after S3 and the file record succeeded but
		// before the item/job transaction committed. The deterministic file ID
		// lets us treat that exact persisted record as an idempotent success.
		existing, getErr := fileStoreFactory().Get(ctx, message.OwnerID, fileID)
		if getErr != nil || existing.ObjectKey != objectKey {
			return err
		}
	}
	logBatchAudit(batchAuditEvent{Event: "batch_item_rendered", JobID: message.JobID, FileID: fileID, Status: "succeeded", PDFBytes: int64(len(pdf)), DurationMs: time.Since(startedAt).Milliseconds()})
	return completeBatchItem(db, message.OwnerID, message.JobID, key, "succeeded", "", fileID)
}

// renderBatchNormalizedSource deliberately mirrors the source-specific portion
// of the synchronous pipeline. Normalization has already enforced the same
// canonical contract, and the worker now supports every resulting kind.
func renderBatchNormalizedSource(ctx context.Context, owner string, normalized normalizedRenderRequest) ([]byte, error) {
	switch normalized.Kind {
	case renderKindDocument:
		html, _, err := resolveDocumentRenderHTML(normalized.Body)
		if err != nil {
			return nil, err
		}
		return generateDocumentPDF(ctx, html)
	case renderKindTemplate:
		html, _, err := resolveTemplateRenderHTML(ctx, templateStoreFactory(), owner, normalized.Body)
		if err != nil {
			if errors.Is(err, errTemplateNotFound) {
				return nil, &renderError{Code: "batch_template_not_found", Message: "Template not found", Status: 422}
			}
			return nil, err
		}
		return generatePDF(ctx, rewriteTfoot(ensureColgroup(injectPrintCSS(html))))
	case renderKindURL:
		var request URLRequest
		if err := json.Unmarshal([]byte(normalized.Body), &request); err != nil {
			return nil, &renderError{Code: "batch_url_request_invalid", Message: "Invalid URL render request", Status: 422}
		}
		url, err := validateRenderURL(request.URL)
		if err != nil {
			return nil, &renderError{Code: "batch_url_invalid", Message: err.Error(), Status: 422}
		}
		return generatePDFURL(ctx, url)
	case renderKindUpload:
		var request packageRenderRequest
		if err := json.Unmarshal([]byte(normalized.Body), &request); err != nil {
			return nil, &renderError{Code: "batch_upload_request_invalid", Message: "Invalid upload render request", Status: 422}
		}
		url, _, cleanup, err := preparePackage(ctx, owner, request.UploadID, request.Entrypoint)
		if err != nil {
			return nil, &renderError{Code: "batch_upload_invalid", Message: err.Error(), Status: 422}
		}
		defer cleanup()
		return generatePDFURL(ctx, url)
	default:
		return nil, &renderError{Code: "batch_source_unsupported", Message: "Unsupported batch render source", Status: 422}
	}
}

func completeBatchItem(db *dynamodb.DynamoDB, owner, jobID string, key map[string]*dynamodb.AttributeValue, status, code, fileID string) error {
	values := map[string]*dynamodb.AttributeValue{":status": {S: aws.String(status)}}
	expression := "SET #status = :status"
	if code != "" {
		values[":code"] = &dynamodb.AttributeValue{S: aws.String(code)}
		expression += ", errorCode = :code"
	}
	if fileID != "" {
		values[":file"] = &dynamodb.AttributeValue{S: aws.String(fileID)}
		expression += ", outputFileId = :file"
	}
	values[":running"] = &dynamodb.AttributeValue{S: aws.String("running")}
	counter := "succeededCount"
	if status == "failed" {
		counter = "failedCount"
	}
	jobValues := map[string]*dynamodb.AttributeValue{
		":minus": {N: aws.String("-1")},
		":plus":  {N: aws.String("1")},
		":now":   {S: aws.String(time.Now().UTC().Format(time.RFC3339Nano))},
	}
	_, err := db.TransactWriteItems(&dynamodb.TransactWriteItemsInput{TransactItems: []*dynamodb.TransactWriteItem{
		{Update: &dynamodb.Update{TableName: aws.String(batchTable()), Key: key, UpdateExpression: aws.String(expression), ConditionExpression: aws.String("#status = :running"), ExpressionAttributeNames: map[string]*string{"#status": aws.String("status")}, ExpressionAttributeValues: values}},
		{Update: &dynamodb.Update{TableName: aws.String(batchTable()), Key: batchJobKey(owner, jobID), UpdateExpression: aws.String("ADD runningCount :minus, " + counter + " :plus SET updatedAt = :now"), ConditionExpression: aws.String("runningCount >= :plus"), ExpressionAttributeValues: jobValues}},
	}})
	if err == nil {
		logBatchAudit(batchAuditEvent{Event: "batch_item_transition", JobID: jobID, Status: status, ErrorCode: code, FileID: fileID})
		enqueueBatchTerminalWebhook(context.Background(), db, owner, jobID)
	}
	return err
}
