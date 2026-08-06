package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

const (
	trialResource          = "/api/v1/trial/render"
	trialQuotaResource     = "/api/v1/trial/quota"
	defaultTrialDailyLimit = 3
	defaultTrialMaxBytes   = 1024 * 1024
	trialSecretKey         = "SYSTEM#TRIAL_HASH_SECRET"
	trialConcurrencyKey    = "SYSTEM#TRIAL_CONCURRENCY"
	trialConcurrencySlots  = 2
	trialLeaseDuration     = 70 * time.Second
)

var (
	errTrialLimitExceeded   = errors.New("trial limit exceeded")
	errTrialCapacityReached = errors.New("trial capacity reached")
	trialSecretMu           sync.Mutex
	trialSecret             []byte
)

type trialQuota struct {
	Key       string
	Limit     int
	Remaining int
}

type trialSlot struct {
	Number int
	Owner  string
}

func isTrialRequest(request events.APIGatewayProxyRequest) bool {
	return request.Resource == trialResource || request.Path == trialResource
}

func isTrialQuotaRequest(request events.APIGatewayProxyRequest) bool {
	return request.Resource == trialQuotaResource || request.Path == trialQuotaResource
}

func trialModeOnly() bool {
	value, _ := strconv.ParseBool(os.Getenv("TRIAL_MODE_ONLY"))
	return value
}

func trialDailyLimit() int {
	return positiveEnvInt("TRIAL_DAILY_LIMIT", defaultTrialDailyLimit)
}

func trialMaxHTMLBytes() int {
	return positiveEnvInt("TRIAL_MAX_HTML_BYTES", defaultTrialMaxBytes)
}

func positiveEnvInt(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func acquireTrialSlot(owner string, now time.Time) (*trialSlot, error) {
	for number := 1; number <= trialConcurrencySlots; number++ {
		ownerName := fmt.Sprintf("slot%dOwner", number)
		untilName := fmt.Sprintf("slot%dUntil", number)
		_, err := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
			TableName: aws.String(tableName),
			Key: map[string]*dynamodb.AttributeValue{
				"requestId": {S: aws.String(trialConcurrencyKey)},
				"timestamp": {N: aws.String("0")},
			},
			UpdateExpression:    aws.String("SET #owner = :owner, #until = :until, entityType = :entity"),
			ConditionExpression: aws.String("attribute_not_exists(#until) OR #until < :now"),
			ExpressionAttributeNames: map[string]*string{
				"#owner": aws.String(ownerName),
				"#until": aws.String(untilName),
			},
			ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
				":owner":  {S: aws.String(owner)},
				":until":  {N: aws.String(strconv.FormatInt(now.Add(trialLeaseDuration).Unix(), 10))},
				":now":    {N: aws.String(strconv.FormatInt(now.Unix(), 10))},
				":entity": {S: aws.String("SYSTEM_STATE")},
			},
		})
		if err == nil {
			return &trialSlot{Number: number, Owner: owner}, nil
		}
		if awsErr, ok := err.(awserr.Error); !ok || awsErr.Code() != dynamodb.ErrCodeConditionalCheckFailedException {
			return nil, err
		}
	}
	return nil, errTrialCapacityReached
}

func releaseTrialSlot(slot *trialSlot) {
	if slot == nil {
		return
	}

	ownerName := fmt.Sprintf("slot%dOwner", slot.Number)
	untilName := fmt.Sprintf("slot%dUntil", slot.Number)
	_, err := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(trialConcurrencyKey)},
			"timestamp": {N: aws.String("0")},
		},
		UpdateExpression:    aws.String("REMOVE #owner, #until"),
		ConditionExpression: aws.String("#owner = :owner"),
		ExpressionAttributeNames: map[string]*string{
			"#owner": aws.String(ownerName),
			"#until": aws.String(untilName),
		},
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":owner": {S: aws.String(slot.Owner)},
		},
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeConditionalCheckFailedException {
			return
		}
		fmt.Printf("Failed to release trial slot: %v\n", err)
	}
}

func consumeTrialQuota(sourceIP string, now time.Time) (*trialQuota, error) {
	if sourceIP == "" {
		return nil, errors.New("source IP is unavailable")
	}

	secret, err := loadTrialSecret()
	if err != nil {
		return nil, fmt.Errorf("load trial secret: %w", err)
	}

	limit := trialDailyLimit()
	key := trialQuotaKey(secret, sourceIP, now)
	expiresAt := now.UTC().Truncate(24 * time.Hour).Add(48 * time.Hour).Unix()
	result, err := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(key)},
			"timestamp": {N: aws.String("0")},
		},
		UpdateExpression:    aws.String("SET #count = if_not_exists(#count, :zero) + :one, expiresAt = :expires, entityType = :entity"),
		ConditionExpression: aws.String("attribute_not_exists(#count) OR #count < :limit"),
		ExpressionAttributeNames: map[string]*string{
			"#count": aws.String("requestCount"),
		},
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":zero":    {N: aws.String("0")},
			":one":     {N: aws.String("1")},
			":limit":   {N: aws.String(strconv.Itoa(limit))},
			":expires": {N: aws.String(strconv.FormatInt(expiresAt, 10))},
			":entity":  {S: aws.String("TRIAL_QUOTA")},
		},
		ReturnValues: aws.String(dynamodb.ReturnValueUpdatedNew),
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeConditionalCheckFailedException {
			return nil, errTrialLimitExceeded
		}
		return nil, err
	}

	count, err := strconv.Atoi(aws.StringValue(result.Attributes["requestCount"].N))
	if err != nil {
		return nil, fmt.Errorf("parse trial request count: %w", err)
	}
	return &trialQuota{Key: key, Limit: limit, Remaining: max(0, limit-count)}, nil
}

func currentTrialQuota(sourceIP string, now time.Time) (*trialQuota, error) {
	if sourceIP == "" {
		return nil, errors.New("source IP is unavailable")
	}

	secret, err := loadTrialSecret()
	if err != nil {
		return nil, fmt.Errorf("load trial secret: %w", err)
	}

	limit := trialDailyLimit()
	key := trialQuotaKey(secret, sourceIP, now)
	result, err := ddbClient.GetItem(&dynamodb.GetItemInput{
		TableName:      aws.String(tableName),
		ConsistentRead: aws.Bool(true),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(key)},
			"timestamp": {N: aws.String("0")},
		},
	})
	if err != nil {
		return nil, err
	}

	count := 0
	if result.Item != nil && result.Item["requestCount"] != nil && result.Item["requestCount"].N != nil {
		count, err = strconv.Atoi(*result.Item["requestCount"].N)
		if err != nil {
			return nil, fmt.Errorf("parse trial request count: %w", err)
		}
	}
	return &trialQuota{Key: key, Limit: limit, Remaining: max(0, limit-count)}, nil
}

func refundTrialQuota(quota *trialQuota) {
	if quota == nil {
		return
	}

	_, err := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(quota.Key)},
			"timestamp": {N: aws.String("0")},
		},
		UpdateExpression:    aws.String("ADD #count :minusOne"),
		ConditionExpression: aws.String("#count > :zero"),
		ExpressionAttributeNames: map[string]*string{
			"#count": aws.String("requestCount"),
		},
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":minusOne": {N: aws.String("-1")},
			":zero":     {N: aws.String("0")},
		},
	})
	if err != nil {
		fmt.Printf("Failed to refund trial quota: %v\n", err)
	}
}

func trialQuotaKey(secret []byte, sourceIP string, now time.Time) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(sourceIP))
	digest := hex.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf("TRIAL#%s#%s", digest, now.UTC().Format("2006-01-02"))
}

func loadTrialSecret() ([]byte, error) {
	trialSecretMu.Lock()
	defer trialSecretMu.Unlock()
	if len(trialSecret) > 0 {
		return trialSecret, nil
	}

	result, err := ddbClient.GetItem(&dynamodb.GetItemInput{
		TableName:      aws.String(tableName),
		ConsistentRead: aws.Bool(true),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(trialSecretKey)},
			"timestamp": {N: aws.String("0")},
		},
	})
	if err != nil {
		return nil, err
	}
	if value := result.Item["secret"]; value != nil && len(value.B) >= 32 {
		trialSecret = value.B
		return trialSecret, nil
	}

	generated := make([]byte, 32)
	if _, err := rand.Read(generated); err != nil {
		return nil, err
	}
	_, err = ddbClient.PutItem(&dynamodb.PutItemInput{
		TableName:           aws.String(tableName),
		ConditionExpression: aws.String("attribute_not_exists(requestId)"),
		Item: map[string]*dynamodb.AttributeValue{
			"requestId":  {S: aws.String(trialSecretKey)},
			"timestamp":  {N: aws.String("0")},
			"entityType": {S: aws.String("SYSTEM_CONFIG")},
			"secret":     {B: generated},
		},
	})
	if err == nil {
		trialSecret = generated
		return trialSecret, nil
	}
	if awsErr, ok := err.(awserr.Error); !ok || awsErr.Code() != dynamodb.ErrCodeConditionalCheckFailedException {
		return nil, err
	}

	result, err = ddbClient.GetItem(&dynamodb.GetItemInput{
		TableName:      aws.String(tableName),
		ConsistentRead: aws.Bool(true),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(trialSecretKey)},
			"timestamp": {N: aws.String("0")},
		},
	})
	if err != nil || result.Item["secret"] == nil {
		return nil, fmt.Errorf("read concurrently created trial secret: %w", err)
	}
	trialSecret = result.Item["secret"].B
	return trialSecret, nil
}
