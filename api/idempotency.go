package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/s3"
)

const (
	idempotencyTTL               = 24 * time.Hour
	idempotencyLockTTL           = 2 * time.Minute
	maxIdempotencyInlineBodyBytes = 350 * 1024
)

var getRenderedPDFObject = func(bucket, key string) ([]byte, error) {
	obj, err := s3Client.GetObject(&s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, err
	}
	defer obj.Body.Close()
	return io.ReadAll(obj.Body)
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func extractIdempotencyKey(headers map[string]string) (string, *renderError) {
	raw := strings.TrimSpace(headerValue(headers, "Idempotency-Key"))
	if raw == "" {
		return "", nil
	}
	if len(raw) > 256 {
		return "", &renderError{
			Code:    "idempotency_key_invalid",
			Message: "Idempotency-Key must not exceed 256 characters",
			Status:  400,
			Field:   "Idempotency-Key",
		}
	}
	for _, r := range raw {
		if r < 32 || r > 126 {
			return "", &renderError{
				Code:    "idempotency_key_invalid",
				Message: "Idempotency-Key must contain printable ASCII characters",
				Status:  400,
				Field:   "Idempotency-Key",
			}
		}
	}
	return raw, nil
}

func idempotencyRecordKey(ownerID, scope, key string) map[string]*dynamodb.AttributeValue {
	recordID := fmt.Sprintf("IDEMPOTENCY#%s#%s#%s", ownerID, scope, sha256Hex(key))
	return map[string]*dynamodb.AttributeValue{
		"requestId": {S: aws.String(recordID)},
		"timestamp": {N: aws.String("0")},
	}
}

func ddbAttrString(item map[string]*dynamodb.AttributeValue, name string) string {
	if item == nil {
		return ""
	}
	if v := item[name]; v != nil && v.S != nil {
		return *v.S
	}
	return ""
}

func buildIdempotencyReplayResponse(item map[string]*dynamodb.AttributeValue, baseHeaders map[string]string) (events.APIGatewayProxyResponse, bool) {
	headers := make(map[string]string, len(baseHeaders)+5)
	for k, v := range baseHeaders {
		headers[k] = v
	}
	if ct := ddbAttrString(item, "contentType"); ct != "" {
		headers["Content-Type"] = ct
	}
	if cd := ddbAttrString(item, "contentDisposition"); cd != "" {
		headers["Content-Disposition"] = cd
	}
	if fid := ddbAttrString(item, "fileId"); fid != "" {
		headers["X-File-Id"] = fid
	}
	if rp := ddbAttrString(item, "retentionPolicy"); rp != "" {
		headers["X-Retention-Policy"] = rp
	}
	headers["X-Idempotent-Replay"] = "true"

	statusCode := 200
	if st, ok := parseQuotaAttrInt(item, "statusCode"); ok && st > 0 {
		statusCode = st
	}

	if objKey := ddbAttrString(item, "responseObjectKey"); objKey != "" {
		objBucket := ddbAttrString(item, "responseBucket")
		if objBucket == "" {
			objBucket = bucketName
		}
		pdfBytes, err := getRenderedPDFObject(objBucket, objKey)
		if err != nil {
			fmt.Printf("Idempotency S3 replay load failed: %v\n", err)
			return errorResponseWithCode(http.StatusServiceUnavailable, "idempotency_replay_unavailable", "Cached PDF for this Idempotency-Key could not be retrieved", baseHeaders), false
		}
		return events.APIGatewayProxyResponse{
			StatusCode:      statusCode,
			Body:            base64.StdEncoding.EncodeToString(pdfBytes),
			Headers:         headers,
			IsBase64Encoded: true,
		}, true
	}

	isBase64 := item["isBase64Encoded"] != nil && aws.BoolValue(item["isBase64Encoded"].BOOL)
	return events.APIGatewayProxyResponse{
		StatusCode:      statusCode,
		Body:            ddbAttrString(item, "responseBody"),
		Headers:         headers,
		IsBase64Encoded: isBase64,
	}, true
}

// claimIdempotencyKey atomically acquires an in-flight lock for key or replays/conflicts
// against an existing record. Returns (response, handled, lockAcquired).
func claimIdempotencyKey(ownerID, scope, key, requestPayload string, baseHeaders map[string]string, now time.Time) (*events.APIGatewayProxyResponse, bool, bool) {
	if key == "" || ownerID == "" || tableName == "" {
		return nil, false, false
	}

	reqHash := sha256Hex(requestPayload)
	nowUnix := now.UTC().Unix()
	lockExpUnix := now.UTC().Add(idempotencyLockTTL).Unix()
	keyMap := idempotencyRecordKey(ownerID, scope, key)

	_, err := ddbClient.PutItem(&dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item: map[string]*dynamodb.AttributeValue{
			"requestId":   keyMap["requestId"],
			"timestamp":   keyMap["timestamp"],
			"entityType":  {S: aws.String("IDEMPOTENCY")},
			"status":      {S: aws.String("in_progress")},
			"requestHash": {S: aws.String(reqHash)},
			"expiresAt":   {N: aws.String(strconv.FormatInt(lockExpUnix, 10))},
		},
		ConditionExpression: aws.String("attribute_not_exists(requestId) OR expiresAt <= :now"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":now": {N: aws.String(strconv.FormatInt(nowUnix, 10))},
		},
	})
	if err == nil {
		return nil, false, true
	}

	awsErr, isAWS := err.(awserr.Error)
	if !isAWS || awsErr.Code() != dynamodb.ErrCodeConditionalCheckFailedException {
		fmt.Printf("Idempotency claim failed: %v\n", err)
		return nil, false, false
	}

	out, getErr := ddbClient.GetItem(&dynamodb.GetItemInput{
		TableName:      aws.String(tableName),
		Key:            idempotencyRecordKey(ownerID, scope, key),
		ConsistentRead: aws.Bool(true),
	})
	if getErr != nil {
		fmt.Printf("Idempotency lookup failed: %v\n", getErr)
		return nil, false, false
	}
	if out == nil || out.Item == nil {
		return nil, false, false
	}
	if expAttr := out.Item["expiresAt"]; expAttr != nil && expAttr.N != nil {
		if expUnix, convErr := strconv.ParseInt(*expAttr.N, 10, 64); convErr == nil && expUnix <= nowUnix {
			return nil, false, false
		}
	}
	if ddbAttrString(out.Item, "requestHash") != reqHash {
		conflict := errorResponseWithCode(http.StatusConflict, "idempotency_key_conflict", "Idempotency-Key was already used with a different request payload", baseHeaders)
		return &conflict, true, false
	}
	if ddbAttrString(out.Item, "status") == "in_progress" {
		headers := make(map[string]string, len(baseHeaders)+1)
		for k, v := range baseHeaders {
			headers[k] = v
		}
		headers["Retry-After"] = "2"
		inFlight := renderErrorResponse(&renderError{
			Code:      "idempotency_in_progress",
			Message:   "A request with this Idempotency-Key is currently in progress",
			Status:    http.StatusConflict,
			Retryable: boolPtr(true),
		}, headers)
		return &inFlight, true, false
	}

	resp, _ := buildIdempotencyReplayResponse(out.Item, baseHeaders)
	return &resp, true, false
}

func releaseIdempotencyLock(ownerID, scope, key string) {
	if key == "" || ownerID == "" || tableName == "" {
		return
	}
	_, err := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
		TableName:           aws.String(tableName),
		Key:                 idempotencyRecordKey(ownerID, scope, key),
		UpdateExpression:    aws.String("SET #status = :failed, expiresAt = :zero"),
		ConditionExpression: aws.String("#status = :in_progress"),
		ExpressionAttributeNames: map[string]*string{
			"#status": aws.String("status"),
		},
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":failed":      {S: aws.String("failed")},
			":zero":        {N: aws.String("0")},
			":in_progress": {S: aws.String("in_progress")},
		},
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeConditionalCheckFailedException {
			return
		}
		fmt.Printf("Idempotency lock release failed: %v\n", err)
	}
}

func saveIdempotencyResponse(ownerID, scope, key, requestPayload string, resp events.APIGatewayProxyResponse, now time.Time) bool {
	return saveIdempotencyResponseWithObject(ownerID, scope, key, requestPayload, resp, "", "", now)
}

func saveIdempotencyResponseWithObject(ownerID, scope, key, requestPayload string, resp events.APIGatewayProxyResponse, s3Bucket, s3Key string, now time.Time) bool {
	if key == "" || ownerID == "" || tableName == "" || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false
	}
	keyMap := idempotencyRecordKey(ownerID, scope, key)
	item := map[string]*dynamodb.AttributeValue{
		"requestId":       keyMap["requestId"],
		"timestamp":       keyMap["timestamp"],
		"entityType":      {S: aws.String("IDEMPOTENCY")},
		"status":          {S: aws.String("completed")},
		"requestHash":     {S: aws.String(sha256Hex(requestPayload))},
		"statusCode":      {N: aws.String(strconv.Itoa(resp.StatusCode))},
		"isBase64Encoded": {BOOL: aws.Bool(resp.IsBase64Encoded)},
		"expiresAt":       {N: aws.String(strconv.FormatInt(now.UTC().Add(idempotencyTTL).Unix(), 10))},
	}

	if resp.IsBase64Encoded && s3Bucket != "" && s3Key != "" {
		item["responseBucket"] = &dynamodb.AttributeValue{S: aws.String(s3Bucket)}
		item["responseObjectKey"] = &dynamodb.AttributeValue{S: aws.String(s3Key)}
	} else {
		if len(resp.Body) > maxIdempotencyInlineBodyBytes {
			fmt.Printf("Idempotency save skipped: response body (%d bytes) exceeds inline DynamoDB limit\n", len(resp.Body))
			return false
		}
		item["responseBody"] = &dynamodb.AttributeValue{S: aws.String(resp.Body)}
	}

	if ct := headerValue(resp.Headers, "Content-Type"); ct != "" {
		item["contentType"] = &dynamodb.AttributeValue{S: aws.String(ct)}
	}
	if cd := headerValue(resp.Headers, "Content-Disposition"); cd != "" {
		item["contentDisposition"] = &dynamodb.AttributeValue{S: aws.String(cd)}
	}
	if fid := headerValue(resp.Headers, "X-File-Id"); fid != "" {
		item["fileId"] = &dynamodb.AttributeValue{S: aws.String(fid)}
	}
	if rp := headerValue(resp.Headers, "X-Retention-Policy"); rp != "" {
		item["retentionPolicy"] = &dynamodb.AttributeValue{S: aws.String(rp)}
	}
	if _, err := ddbClient.PutItem(&dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item:      item,
	}); err != nil {
		fmt.Printf("Idempotency save failed: %v\n", err)
		return false
	}
	return true
}
