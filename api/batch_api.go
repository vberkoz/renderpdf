package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/aws/aws-sdk-go/service/sqs"
	"github.com/google/uuid"
)

const batchResource = "/api/v1/batches"
const dashboardBatchResource = "/api/v1/dashboard/batches"

// A batch is one job record plus its item records, created in one DynamoDB
// transaction. DynamoDB permits 100 transaction records, hence the 99-item
// public limit.
type batchJobReply struct {
	JobID               string    `json:"jobId"`
	Status              string    `json:"status"`
	ItemCount           int       `json:"itemCount"`
	QueuedCount         int       `json:"queuedCount"`
	RunningCount        int       `json:"runningCount"`
	SucceededCount      int       `json:"succeededCount"`
	FailedCount         int       `json:"failedCount"`
	CancelledCount      int       `json:"cancelledCount"`
	EnqueuePendingCount int       `json:"enqueuePendingCount,omitempty"`
	CreatedAt           time.Time `json:"createdAt"`
	UpdatedAt           time.Time `json:"updatedAt"`
	CancelRequested     bool      `json:"-"`
}
type batchItemReply struct {
	ItemID       string `json:"itemId"`
	Ordinal      int    `json:"ordinal"`
	Status       string `json:"status"`
	OutputFileID string `json:"outputFileId,omitempty"`
	ErrorCode    string `json:"errorCode,omitempty"`
}

func batchTable() string { return os.Getenv("DOCUMENT_STORE_TABLE_NAME") }
func isBatchRequest(r events.APIGatewayProxyRequest) bool {
	p := r.Path
	if p == "" {
		p = r.Resource
	}
	return p == batchResource || strings.HasPrefix(p, batchResource+"/") || p == dashboardBatchResource || strings.HasPrefix(p, dashboardBatchResource+"/")
}
func batchParts(r events.APIGatewayProxyRequest) []string {
	p := r.Path
	if p == "" {
		p = r.Resource
	}
	if strings.HasPrefix(p, dashboardBatchResource) {
		p = strings.TrimPrefix(p, dashboardBatchResource)
	}
	s := strings.Trim(strings.TrimPrefix(p, batchResource), "/")
	if s == "" {
		return nil
	}
	return strings.Split(s, "/")
}
func batchJobKey(owner, id string) map[string]*dynamodb.AttributeValue {
	return map[string]*dynamodb.AttributeValue{"PK": {S: aws.String(sourceOwnerKey(owner))}, "SK": {S: aws.String("BATCH#" + id)}}
}
func batchItemKey(jobID string, ordinal int) map[string]*dynamodb.AttributeValue {
	return map[string]*dynamodb.AttributeValue{"PK": {S: aws.String("JOB#" + jobID)}, "SK": {S: aws.String(fmt.Sprintf("ITEM#%06d", ordinal))}}
}

func handleBatchRequest(ctx context.Context, r events.APIGatewayProxyRequest, h map[string]string) events.APIGatewayProxyResponse {
	owner := authorizerValue(r, "userId")
	if owner == "" {
		return errorResponse(401, "Authentication is required", h)
	}
	db := dynamodb.New(sess)
	parts := batchParts(r)
	if r.HTTPMethod == http.MethodPost && len(parts) == 0 {
		return createBatch(ctx, r, owner, h, db)
	}
	if len(parts) == 0 {
		return errorResponse(405, "Method not allowed", h)
	}
	// The item table is a transactional outbox. A later read retries entries
	// whose SQS send failed or whose sender crashed before acknowledgement.
	_ = recoverBatchEnqueues(ctx, db, owner, parts[0])
	job, err := readBatch(owner, parts[0], db)
	if err != nil {
		return errorResponse(404, "Batch not found", h)
	}
	enqueueBatchTerminalWebhook(ctx, db, owner, parts[0])
	if r.HTTPMethod == http.MethodGet && len(parts) == 1 {
		return sourceJSON(200, job, h)
	}
	if len(parts) == 2 && parts[1] == "items" && r.HTTPMethod == http.MethodGet {
		return listBatchItems(parts[0], h, db)
	}
	if len(parts) == 2 && parts[1] == "cancel" && r.HTTPMethod == http.MethodPost {
		return cancelBatch(owner, job, h, db)
	}
	if len(parts) == 2 && parts[1] == "download" && r.HTTPMethod == http.MethodGet {
		return downloadBatchZIP(ctx, owner, job, h, db)
	}
	return errorResponse(404, "Not found", h)
}

const maxBatchZIPBytes = 100 * 1024 * 1024

// downloadBatchZIP materializes completed PDFs into one private ZIP artifact.
// The conservative cap keeps this synchronous API path within Lambda memory.
func downloadBatchZIP(ctx context.Context, owner string, job batchJobReply, h map[string]string, db *dynamodb.DynamoDB) events.APIGatewayProxyResponse {
	if job.SucceededCount == 0 {
		return errorResponseWithCode(409, "batch_outputs_unavailable", "No completed PDFs are available", h)
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

func createBatch(ctx context.Context, r events.APIGatewayProxyRequest, owner string, h map[string]string, db *dynamodb.DynamoDB) events.APIGatewayProxyResponse {
	req, err := parseBatchRenderRequest(r.Body)
	if err != nil {
		return renderErrorResponse(err, h)
	}
	if req.Source != nil {
		if _, err := sourceStoreFactory().Get(ctx, owner, req.Source.ID); err != nil {
			return errorResponse(404, "Stored source not found", h)
		}
	}
	active, quotaErr := activeBatchJobCount(owner, db)
	if quotaErr != nil {
		return errorResponse(503, "Batch storage is temporarily unavailable", h)
	}
	if active >= maxConcurrentBatchJobs {
		return errorResponseWithCode(409, "batch_concurrency_limit_reached", "Concurrent batch job limit reached", h)
	}
	if req.Options.WebhookURL != "" {
		validated, validationErr := validateWebhookURL(req.Options.WebhookURL)
		if validationErr != nil {
			return renderErrorResponse(&renderError{Code: "batch_webhook_invalid", Message: validationErr.Error(), Status: 422}, h)
		}
		req.Options.WebhookURL = validated
	}
	now := time.Now().UTC()
	id := "job_" + uuid.NewString()
	job := batchJobReply{JobID: id, Status: "queued", ItemCount: len(req.Items), QueuedCount: len(req.Items), EnqueuePendingCount: len(req.Items), CreatedAt: now, UpdatedAt: now}
	writes := make([]*dynamodb.TransactWriteItem, 0, len(req.Items)+1)
	storedRequest, _ := json.Marshal(req)
	writes = append(writes, &dynamodb.TransactWriteItem{Put: &dynamodb.Put{TableName: aws.String(batchTable()), Item: batchJobItem(owner, job, string(storedRequest)), ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)")}})
	for i, input := range req.Items {
		body, _ := json.Marshal(input)
		item := map[string]*dynamodb.AttributeValue{"PK": {S: aws.String("JOB#" + id)}, "SK": {S: aws.String(fmt.Sprintf("ITEM#%06d", i+1))}, "entityType": {S: aws.String("BATCH_ITEM")}, "itemId": {S: aws.String("item_" + uuid.NewString())}, "ordinal": {N: aws.String(fmt.Sprint(i + 1))}, "status": {S: aws.String("queued")}, "enqueueState": {S: aws.String("pending")}, "enqueueLeaseUntil": {N: aws.String("0")}, "input": {S: aws.String(string(body))}, "ownerKey": {S: aws.String(sourceOwnerKey(owner))}, "ownerID": {S: aws.String(owner)}}
		writes = append(writes, &dynamodb.TransactWriteItem{Put: &dynamodb.Put{TableName: aws.String(batchTable()), Item: item, ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)")}})
	}
	if _, err = db.TransactWriteItemsWithContext(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: writes}); err != nil {
		return errorResponse(503, "Batch storage is temporarily unavailable", h)
	}
	// The DynamoDB stream dispatcher owns delivery to SQS. Do not couple a
	// successful batch submission to queue availability; the durable items are
	// retried autonomously. The read-triggered recovery path remains only for
	// batches created before the dispatcher was enabled.
	return sourceJSON(http.StatusCreated, job, h)
}

func activeBatchJobCount(owner string, db *dynamodb.DynamoDB) (int, error) {
	out, err := db.Query(&dynamodb.QueryInput{TableName: aws.String(batchTable()), KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :prefix)"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":pk": {S: aws.String(sourceOwnerKey(owner))}, ":prefix": {S: aws.String("BATCH#")}}})
	if err != nil {
		return 0, err
	}
	active := 0
	for _, item := range out.Items {
		var job batchJobReply
		if json.Unmarshal([]byte(aws.StringValue(item["job"].S)), &job) != nil {
			continue
		}
		job.ItemCount = batchNumber(item, "itemCount", job.ItemCount)
		job.QueuedCount = batchNumber(item, "queuedCount", job.QueuedCount)
		job.RunningCount = batchNumber(item, "runningCount", job.RunningCount)
		job.SucceededCount = batchNumber(item, "succeededCount", job.SucceededCount)
		job.FailedCount = batchNumber(item, "failedCount", job.FailedCount)
		job.CancelledCount = batchNumber(item, "cancelledCount", job.CancelledCount)
		job.CancelRequested = item["cancelRequested"] != nil && aws.BoolValue(item["cancelRequested"].BOOL)
		if status := derivedBatchStatus(job); status == "queued" || status == "running" || status == "cancelling" {
			active++
		}
	}
	return active, nil
}

func batchJobItem(owner string, job batchJobReply, request string) map[string]*dynamodb.AttributeValue {
	item := batchJobKey(owner, job.JobID)
	item["entityType"] = &dynamodb.AttributeValue{S: aws.String("BATCH_JOB")}
	item["job"] = &dynamodb.AttributeValue{S: aws.String(mustBatchJSON(job))}
	item["ownerKey"] = &dynamodb.AttributeValue{S: aws.String(sourceOwnerKey(owner))}
	item["request"] = &dynamodb.AttributeValue{S: aws.String(request)}
	var requestValue batchRenderRequest
	if json.Unmarshal([]byte(request), &requestValue) == nil {
		item["webhookURL"] = &dynamodb.AttributeValue{S: aws.String(requestValue.Options.WebhookURL)}
		item["webhookSecret"] = &dynamodb.AttributeValue{S: aws.String(requestValue.Options.WebhookSecret)}
	}
	item["status"] = &dynamodb.AttributeValue{S: aws.String("queued")}
	for name, value := range map[string]int{"itemCount": job.ItemCount, "queuedCount": job.QueuedCount, "runningCount": 0, "succeededCount": 0, "failedCount": 0, "cancelledCount": 0} {
		item[name] = &dynamodb.AttributeValue{N: aws.String(fmt.Sprint(value))}
	}
	item["createdAt"] = &dynamodb.AttributeValue{S: aws.String(job.CreatedAt.Format(time.RFC3339Nano))}
	item["updatedAt"] = &dynamodb.AttributeValue{S: aws.String(job.UpdatedAt.Format(time.RFC3339Nano))}
	return item
}

type batchQueueMessage struct {
	OwnerID string `json:"ownerId"`
	JobID   string `json:"jobId"`
	Ordinal int    `json:"ordinal"`
}

// This is a transactional-outbox dispatcher: durable pending entries exist
// before SQS is touched. A crash after SendMessage can duplicate a message, but
// never a render because the worker conditionally claims the item.
func recoverBatchEnqueues(ctx context.Context, db *dynamodb.DynamoDB, owner, jobID string) error {
	items, err := db.QueryWithContext(ctx, &dynamodb.QueryInput{TableName: aws.String(batchTable()), KeyConditionExpression: aws.String("PK = :pk"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":pk": {S: aws.String("JOB#" + jobID)}}})
	if err != nil {
		return err
	}
	for _, item := range items.Items {
		if aws.StringValue(item["status"].S) != "queued" {
			continue
		}
		ordinal, _ := strconv.Atoi(aws.StringValue(item["ordinal"].N))
		if ordinal == 0 || !claimBatchEnqueue(ctx, db, item) {
			continue
		}
		if err := enqueueBatchItem(owner, jobID, ordinal); err != nil {
			resetBatchEnqueue(ctx, db, item)
			return err
		}
		if err := markBatchEnqueued(ctx, db, item); err != nil {
			return err
		}
	}
	return nil
}
func claimBatchEnqueue(ctx context.Context, db *dynamodb.DynamoDB, item map[string]*dynamodb.AttributeValue) bool {
	now := time.Now().UTC()
	_, err := db.UpdateItemWithContext(ctx, &dynamodb.UpdateItemInput{TableName: aws.String(batchTable()), Key: map[string]*dynamodb.AttributeValue{"PK": item["PK"], "SK": item["SK"]}, UpdateExpression: aws.String("SET enqueueState = :sending, enqueueLeaseUntil = :lease ADD enqueueAttempts :one"), ConditionExpression: aws.String("#status = :queued AND (enqueueState = :pending OR (enqueueState = :sending AND enqueueLeaseUntil < :now))"), ExpressionAttributeNames: map[string]*string{"#status": aws.String("status")}, ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":queued": {S: aws.String("queued")}, ":pending": {S: aws.String("pending")}, ":sending": {S: aws.String("sending")}, ":now": {N: aws.String(fmt.Sprint(now.Unix()))}, ":lease": {N: aws.String(fmt.Sprint(now.Add(30 * time.Second).Unix()))}, ":one": {N: aws.String("1")}}})
	return err == nil
}
func resetBatchEnqueue(ctx context.Context, db *dynamodb.DynamoDB, item map[string]*dynamodb.AttributeValue) {
	_, _ = db.UpdateItemWithContext(ctx, &dynamodb.UpdateItemInput{TableName: aws.String(batchTable()), Key: map[string]*dynamodb.AttributeValue{"PK": item["PK"], "SK": item["SK"]}, UpdateExpression: aws.String("SET enqueueState = :pending, enqueueLeaseUntil = :zero"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":pending": {S: aws.String("pending")}, ":zero": {N: aws.String("0")}}})
}
func markBatchEnqueued(ctx context.Context, db *dynamodb.DynamoDB, item map[string]*dynamodb.AttributeValue) error {
	_, err := db.UpdateItemWithContext(ctx, &dynamodb.UpdateItemInput{TableName: aws.String(batchTable()), Key: map[string]*dynamodb.AttributeValue{"PK": item["PK"], "SK": item["SK"]}, UpdateExpression: aws.String("SET enqueueState = :sent REMOVE enqueueLeaseUntil"), ConditionExpression: aws.String("enqueueState = :sending"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":sent": {S: aws.String("sent")}, ":sending": {S: aws.String("sending")}}})
	return err
}
func enqueueBatchItem(owner, jobID string, ordinal int) error {
	url := os.Getenv("BATCH_QUEUE_URL")
	if url == "" {
		return fmt.Errorf("batch queue unavailable")
	}
	body, _ := json.Marshal(batchQueueMessage{owner, jobID, ordinal})
	_, err := sqsClient.SendMessageWithContext(context.Background(), &sqs.SendMessageInput{QueueUrl: aws.String(url), MessageBody: aws.String(string(body))})
	return err
}
func mustBatchJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func readBatch(owner, id string, db *dynamodb.DynamoDB) (batchJobReply, error) {
	o, e := db.GetItem(&dynamodb.GetItemInput{TableName: aws.String(batchTable()), Key: batchJobKey(owner, id), ConsistentRead: aws.Bool(true)})
	if e != nil || o.Item == nil {
		return batchJobReply{}, fmt.Errorf("not found")
	}
	var v batchJobReply
	if e = json.Unmarshal([]byte(aws.StringValue(o.Item["job"].S)), &v); e != nil {
		return v, e
	}
	v.ItemCount = batchNumber(o.Item, "itemCount", v.ItemCount)
	v.QueuedCount = batchNumber(o.Item, "queuedCount", v.QueuedCount)
	v.RunningCount = batchNumber(o.Item, "runningCount", v.RunningCount)
	v.SucceededCount = batchNumber(o.Item, "succeededCount", v.SucceededCount)
	v.FailedCount = batchNumber(o.Item, "failedCount", v.FailedCount)
	v.CancelledCount = batchNumber(o.Item, "cancelledCount", v.CancelledCount)
	v.CancelRequested = o.Item["cancelRequested"] != nil && aws.BoolValue(o.Item["cancelRequested"].BOOL)
	if raw := aws.StringValue(o.Item["updatedAt"].S); raw != "" {
		_ = v.UpdatedAt.UnmarshalText([]byte(raw))
	}
	v.EnqueuePendingCount = countBatchPendingEnqueues(db, id)
	v.Status = derivedBatchStatus(v)
	return v, nil
}
func batchNumber(item map[string]*dynamodb.AttributeValue, name string, fallback int) int {
	if v := item[name]; v != nil && v.N != nil {
		if n, e := strconv.Atoi(*v.N); e == nil {
			return n
		}
	}
	return fallback
}
func derivedBatchStatus(job batchJobReply) string {
	if job.CancelRequested {
		if job.QueuedCount == 0 && job.RunningCount == 0 {
			return "cancelled"
		}
		return "cancelling"
	}
	if job.SucceededCount+job.FailedCount+job.CancelledCount == job.ItemCount {
		return "completed"
	}
	if job.RunningCount > 0 {
		return "running"
	}
	return "queued"
}
func countBatchPendingEnqueues(db *dynamodb.DynamoDB, id string) int {
	o, e := db.Query(&dynamodb.QueryInput{TableName: aws.String(batchTable()), KeyConditionExpression: aws.String("PK = :pk"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":pk": {S: aws.String("JOB#" + id)}}})
	if e != nil {
		return 0
	}
	n := 0
	for _, item := range o.Items {
		if aws.StringValue(item["status"].S) == "queued" && aws.StringValue(item["enqueueState"].S) != "sent" {
			n++
		}
	}
	return n
}

func listBatchItems(id string, h map[string]string, db *dynamodb.DynamoDB) events.APIGatewayProxyResponse {
	o, e := db.Query(&dynamodb.QueryInput{TableName: aws.String(batchTable()), KeyConditionExpression: aws.String("PK = :pk"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":pk": {S: aws.String("JOB#" + id)}}})
	if e != nil {
		return errorResponse(503, "Batch storage is temporarily unavailable", h)
	}
	items := make([]batchItemReply, 0, len(o.Items))
	for _, x := range o.Items {
		items = append(items, batchItemReply{ItemID: aws.StringValue(x["itemId"].S), Ordinal: batchNumber(x, "ordinal", 0), Status: aws.StringValue(x["status"].S), OutputFileID: aws.StringValue(x["outputFileId"].S), ErrorCode: aws.StringValue(x["errorCode"].S)})
	}
	return sourceJSON(200, map[string]any{"items": items}, h)
}

func cancelBatch(owner string, job batchJobReply, h map[string]string, db *dynamodb.DynamoDB) events.APIGatewayProxyResponse {
	if job.CancelRequested || job.Status == "completed" || job.Status == "cancelled" {
		return sourceJSON(200, job, h)
	}
	_, e := db.UpdateItem(&dynamodb.UpdateItemInput{TableName: aws.String(batchTable()), Key: batchJobKey(owner, job.JobID), UpdateExpression: aws.String("SET cancelRequested = :true, updatedAt = :now"), ConditionExpression: aws.String("attribute_not_exists(cancelRequested)"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":true": {BOOL: aws.Bool(true)}, ":now": {S: aws.String(time.Now().UTC().Format(time.RFC3339Nano))}}})
	if e != nil && !isBatchTransitionConflict(e) {
		return errorResponse(503, "Batch storage is temporarily unavailable", h)
	}
	items, e := db.Query(&dynamodb.QueryInput{TableName: aws.String(batchTable()), KeyConditionExpression: aws.String("PK = :pk"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":pk": {S: aws.String("JOB#" + job.JobID)}}})
	if e != nil {
		return errorResponse(503, "Batch storage is temporarily unavailable", h)
	}
	for _, item := range items.Items {
		if aws.StringValue(item["status"].S) != "queued" {
			continue
		}
		if e = transitionCancelledItem(db, owner, job.JobID, item); e != nil && !isBatchTransitionConflict(e) {
			return errorResponse(503, "Batch storage is temporarily unavailable", h)
		}
	}
	updated, e := readBatch(owner, job.JobID, db)
	if e != nil {
		return errorResponse(503, "Batch storage is temporarily unavailable", h)
	}
	enqueueBatchTerminalWebhook(context.Background(), db, owner, job.JobID)
	return sourceJSON(200, updated, h)
}
func transitionCancelledItem(db *dynamodb.DynamoDB, owner, jobID string, item map[string]*dynamodb.AttributeValue) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := db.TransactWriteItems(&dynamodb.TransactWriteItemsInput{TransactItems: []*dynamodb.TransactWriteItem{{Update: &dynamodb.Update{TableName: aws.String(batchTable()), Key: map[string]*dynamodb.AttributeValue{"PK": item["PK"], "SK": item["SK"]}, UpdateExpression: aws.String("SET #status = :cancelled"), ConditionExpression: aws.String("#status = :queued"), ExpressionAttributeNames: map[string]*string{"#status": aws.String("status")}, ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":queued": {S: aws.String("queued")}, ":cancelled": {S: aws.String("cancelled")}}}}, {Update: &dynamodb.Update{TableName: aws.String(batchTable()), Key: batchJobKey(owner, jobID), UpdateExpression: aws.String("ADD queuedCount :minus, cancelledCount :plus SET updatedAt = :now"), ConditionExpression: aws.String("cancelRequested = :true AND queuedCount >= :one"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":minus": {N: aws.String("-1")}, ":plus": {N: aws.String("1")}, ":one": {N: aws.String("1")}, ":true": {BOOL: aws.Bool(true)}, ":now": {S: aws.String(now)}}}}}})
	return err
}
func isBatchTransitionConflict(err error) bool {
	if e, ok := err.(awserr.Error); ok {
		return e.Code() == dynamodb.ErrCodeConditionalCheckFailedException || e.Code() == dynamodb.ErrCodeTransactionCanceledException
	}
	return false
}
