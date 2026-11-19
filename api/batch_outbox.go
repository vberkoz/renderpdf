package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/sqs"
)

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

func mustBatchJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
