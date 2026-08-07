package main

import (
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

var errAccountQuotaExceeded = errors.New("monthly account quota exceeded")

type accountQuota struct {
	Key string
}

func accountMonthlyQuota(customerID string) (int, error) {
	result, err := ddbClient.GetItem(&dynamodb.GetItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String("BILLING#" + customerID)},
			"timestamp": {N: aws.String("0")},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return 0, err
	}
	if result.Item != nil && result.Item["status"] != nil && result.Item["status"].S != nil {
		switch *result.Item["status"].S {
		case "active", "trialing", "past_due":
			tier := "pro"
			if result.Item["tier"] != nil && result.Item["tier"].S != nil {
				tier = *result.Item["tier"].S
			}
			switch tier {
			case "starter":
				return positiveEnvInt("STARTER_MONTHLY_QUOTA", 5000), nil
			case "business":
				return positiveEnvInt("BUSINESS_MONTHLY_QUOTA", 100000), nil
			default:
				return positiveEnvInt("PRO_MONTHLY_QUOTA", 20000), nil
			}
		}
	}
	return positiveEnvInt("FREE_MONTHLY_QUOTA", 25), nil
}

func reserveAccountQuota(customerID string, now time.Time) (*accountQuota, error) {
	if customerID == "" {
		return nil, nil
	}
	limit, err := accountMonthlyQuota(customerID)
	if err != nil {
		return nil, fmt.Errorf("load account plan: %w", err)
	}
	key := fmt.Sprintf("USER_QUOTA#%s#%s", customerID, now.UTC().Format("2006-01"))
	_, err = ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(key)},
			"timestamp": {N: aws.String("0")},
		},
		UpdateExpression:    aws.String("SET #used = if_not_exists(#used, :zero) + :one, entityType = :entity, expiresAt = :expires"),
		ConditionExpression: aws.String("attribute_not_exists(#used) OR #used < :limit"),
		ExpressionAttributeNames: map[string]*string{
			"#used": aws.String("used"),
		},
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":zero":    {N: aws.String("0")},
			":one":     {N: aws.String("1")},
			":limit":   {N: aws.String(fmt.Sprintf("%d", limit))},
			":entity":  {S: aws.String("USER_QUOTA")},
			":expires": {N: aws.String(fmt.Sprintf("%d", now.UTC().AddDate(0, 2, 0).Unix()))},
		},
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeConditionalCheckFailedException {
			return nil, errAccountQuotaExceeded
		}
		return nil, err
	}
	return &accountQuota{Key: key}, nil
}

func refundAccountQuota(quota *accountQuota) {
	if quota == nil {
		return
	}
	_, err := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(quota.Key)},
			"timestamp": {N: aws.String("0")},
		},
		UpdateExpression:    aws.String("ADD #used :minusOne"),
		ConditionExpression: aws.String("#used > :zero"),
		ExpressionAttributeNames: map[string]*string{
			"#used": aws.String("used"),
		},
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":minusOne": {N: aws.String("-1")},
			":zero":     {N: aws.String("0")},
		},
	})
	if err != nil {
		fmt.Printf("Failed to refund account quota: %v\n", err)
	}
}
