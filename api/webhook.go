package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/sqs"
)

// webhookEvent contains no customer HTML or API credentials. The optional
// secret is encrypted at rest by SQS and is used only to sign the delivery.
type webhookEvent struct {
	Type      string    `json:"type,omitempty"`
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	Secret    string    `json:"secret,omitempty"`
	PDFURL    string    `json:"pdfUrl"`
	PDFSize   int64     `json:"pdfSize"`
	CreatedAt time.Time `json:"createdAt"`
	Data      any       `json:"data,omitempty"`
}

type batchWebhookData struct {
	JobID          string `json:"jobId"`
	Status         string `json:"status"`
	ItemCount      int    `json:"itemCount"`
	SucceededCount int    `json:"succeededCount"`
	FailedCount    int    `json:"failedCount"`
	CancelledCount int    `json:"cancelledCount"`
}

// enqueueBatchTerminalWebhook uses the job record as a durable outbox. The
// conditional claim guarantees a single logical event ID; a reclaimed lease
// may duplicate delivery after a crash, so receivers can deduplicate the
// stable event ID as documented by X-RenderPDF-Event-ID.
func enqueueBatchTerminalWebhook(ctx context.Context, db *dynamodb.DynamoDB, owner, jobID string) {
	job, err := readBatch(owner, jobID, db)
	if err != nil || (job.Status != "completed" && job.Status != "cancelled") {
		return
	}
	raw, err := db.GetItemWithContext(ctx, &dynamodb.GetItemInput{TableName: aws.String(batchTable()), Key: batchJobKey(owner, jobID), ConsistentRead: aws.Bool(true)})
	if err != nil || raw.Item == nil {
		return
	}
	url := aws.StringValue(raw.Item["webhookURL"].S)
	if url == "" {
		return
	}
	now := time.Now().UTC()
	eventID := "batch_" + jobID + "_terminal"
	_, err = db.UpdateItemWithContext(ctx, &dynamodb.UpdateItemInput{TableName: aws.String(batchTable()), Key: batchJobKey(owner, jobID), UpdateExpression: aws.String("SET terminalWebhookState = :sending, terminalWebhookLeaseUntil = :lease, terminalWebhookID = :id"), ConditionExpression: aws.String("attribute_not_exists(terminalWebhookState) OR (terminalWebhookState = :sending AND terminalWebhookLeaseUntil < :now)"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":sending": {S: aws.String("sending")}, ":lease": {N: aws.String(fmt.Sprint(now.Add(30 * time.Second).Unix()))}, ":now": {N: aws.String(fmt.Sprint(now.Unix()))}, ":id": {S: aws.String(eventID)}}})
	if err != nil {
		return
	}
	typeName := "batch.completed"
	if job.FailedCount > 0 || job.CancelledCount > 0 {
		typeName = "batch.failed"
	}
	event := webhookEvent{Type: typeName, ID: eventID, URL: url, Secret: aws.StringValue(raw.Item["webhookSecret"].S), CreatedAt: now, Data: batchWebhookData{JobID: jobID, Status: job.Status, ItemCount: job.ItemCount, SucceededCount: job.SucceededCount, FailedCount: job.FailedCount, CancelledCount: job.CancelledCount}}
	if err = enqueueWebhook(ctx, event); err != nil {
		return
	}
	_, _ = db.UpdateItemWithContext(ctx, &dynamodb.UpdateItemInput{TableName: aws.String(batchTable()), Key: batchJobKey(owner, jobID), UpdateExpression: aws.String("SET terminalWebhookState = :sent REMOVE terminalWebhookLeaseUntil"), ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":sent": {S: aws.String("sent")}}})
}

// validateWebhookURL intentionally accepts only HTTPS public endpoints. This
// keeps a render request from being used to reach private AWS or local hosts.
func validateWebhookURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil || parsed.Host == "" || parsed.Scheme != "https" {
		return "", fmt.Errorf("webhookUrl must be a valid absolute HTTPS URL")
	}
	if parsed.User != nil || (parsed.Port() != "" && parsed.Port() != "443") {
		return "", fmt.Errorf("webhookUrl must not contain credentials and must use port 443")
	}
	host := parsed.Hostname()
	if host == "" || strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return "", fmt.Errorf("webhookUrl must target a public host")
	}
	addresses := []net.IP{net.ParseIP(host)}
	if addresses[0] == nil {
		addresses, err = net.LookupIP(host)
		if err != nil || len(addresses) == 0 {
			return "", fmt.Errorf("webhookUrl host could not be resolved")
		}
	}
	for _, address := range addresses {
		if !isPublicIP(address) {
			return "", fmt.Errorf("webhookUrl must target a public host")
		}
	}
	return parsed.String(), nil
}

func enqueueWebhook(ctx context.Context, event webhookEvent) error {
	queueURL := os.Getenv("WEBHOOK_QUEUE_URL")
	if queueURL == "" {
		return fmt.Errorf("WEBHOOK_QUEUE_URL is not configured")
	}
	body, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = sqsClient.SendMessageWithContext(ctx, &sqs.SendMessageInput{
		QueueUrl:    aws.String(queueURL),
		MessageBody: aws.String(string(body)),
	})
	return err
}
