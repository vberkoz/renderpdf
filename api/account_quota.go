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
	Key       string
	Limit     int
	Used      int
	Remaining int
	Period    string
}

func parseQuotaAttrInt(attrs map[string]*dynamodb.AttributeValue, name string) (int, bool) {
	if attrs == nil || attrs[name] == nil || attrs[name].N == nil {
		return 0, false
	}
	var v int
	if _, err := fmt.Sscanf(*attrs[name].N, "%d", &v); err != nil {
		return 0, false
	}
	return v, true
}

func secondsUntilUTCMidnight(now time.Time) int {
	u := now.UTC()
	next := time.Date(u.Year(), u.Month(), u.Day()+1, 0, 0, 0, 0, time.UTC)
	secs := int(next.Sub(u).Seconds())
	if secs < 1 {
		return 1
	}
	return secs
}

func secondsUntilNextUTCMonth(now time.Time) int {
	u := now.UTC()
	next := time.Date(u.Year(), u.Month()+1, 1, 0, 0, 0, 0, time.UTC)
	secs := int(next.Sub(u).Seconds())
	if secs < 1 {
		return 1
	}
	return secs
}

func setAccountQuotaHeaders(q *accountQuota, headers map[string]string) {
	if q == nil || headers == nil {
		return
	}
	headers["X-Quota-Limit"] = fmt.Sprintf("%d", q.Limit)
	headers["X-Quota-Remaining"] = fmt.Sprintf("%d", q.Remaining)
}

func restoreAccountQuotaRemainingHeader(q *accountQuota, headers map[string]string) {
	if q == nil || headers == nil {
		return
	}
	headers["X-Quota-Limit"] = fmt.Sprintf("%d", q.Limit)
	headers["X-Quota-Remaining"] = fmt.Sprintf("%d", min(q.Limit, q.Remaining+1))
}

func setAccountQuotaExceededHeaders(customerID string, headers map[string]string, now time.Time) {
	if headers == nil {
		return
	}
	headers["Retry-After"] = fmt.Sprintf("%d", secondsUntilNextUTCMonth(now))
	if customerID != "" {
		if limit, err := accountMonthlyQuota(customerID); err == nil && limit > 0 {
			headers["X-Quota-Limit"] = fmt.Sprintf("%d", limit)
		}
	}
	headers["X-Quota-Remaining"] = "0"
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
			default:
				return positiveEnvInt("PRO_MONTHLY_QUOTA", 20000), nil
			}
		}
	}
	return positiveEnvInt("FREE_MONTHLY_QUOTA", 25), nil
}

func currentAccountQuota(customerID string, now time.Time) (*accountQuota, error) {
	planLimit, err := accountMonthlyQuota(customerID)
	if err != nil {
		return nil, fmt.Errorf("load account plan: %w", err)
	}
	period := now.UTC().Format("2006-01")
	key := fmt.Sprintf("USER_QUOTA#%s#%s", customerID, period)
	result, err := ddbClient.GetItem(&dynamodb.GetItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(key)},
			"timestamp": {N: aws.String("0")},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	used := 0
	storedLimit := 0
	if result.Item != nil {
		used, _ = parseQuotaAttrInt(result.Item, "used")
		storedLimit, _ = parseQuotaAttrInt(result.Item, "limit")
	}
	effectiveLimit := planLimit
	if storedLimit > effectiveLimit {
		effectiveLimit = storedLimit
	}
	return &accountQuota{
		Key:       key,
		Limit:     effectiveLimit,
		Used:      used,
		Remaining: max(0, effectiveLimit-used),
		Period:    period,
	}, nil
}

func checkAccountQuotaAvailable(customerID string, now time.Time) error {
	if customerID == "" {
		return nil
	}
	q, err := currentAccountQuota(customerID, now)
	if err != nil {
		return err
	}
	if q.Used >= q.Limit {
		return errAccountQuotaExceeded
	}
	return nil
}

func checkQuotaAfterReservation(customerID, customerEmail, key string, attrs map[string]*dynamodb.AttributeValue, now time.Time) {
	if attrs == nil {
		return
	}
	used := 0
	limit := 0
	if attrs["used"] != nil && attrs["used"].N != nil {
		fmt.Sscanf(*attrs["used"].N, "%d", &used)
	}
	if attrs["limit"] != nil && attrs["limit"].N != nil {
		fmt.Sscanf(*attrs["limit"].N, "%d", &limit)
	}
	if limit > 0 {
		maybeSendQuotaAlert(customerID, customerEmail, key, used, limit, now)
	}
}

func reserveAccountQuota(customerID, customerEmail string, now time.Time) (*accountQuota, error) {
	if customerID == "" {
		return nil, nil
	}
	limit, err := accountMonthlyQuota(customerID)
	if err != nil {
		return nil, fmt.Errorf("load account plan: %w", err)
	}
	key := fmt.Sprintf("USER_QUOTA#%s#%s", customerID, now.UTC().Format("2006-01"))
	updateRes, err := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(key)},
			"timestamp": {N: aws.String("0")},
		},
		// The limit is initialized on the first render of the month. Overage
		// purchases increase this stored value, so it must not be overwritten on
		// each render.
		UpdateExpression:    aws.String("SET #used = if_not_exists(#used, :zero) + :one, #limit = if_not_exists(#limit, :limit), entityType = :entity, expiresAt = :expires"),
		ConditionExpression: aws.String("attribute_not_exists(#used) OR attribute_not_exists(#limit) OR #used < #limit"),
		ExpressionAttributeNames: map[string]*string{
			"#used":  aws.String("used"),
			"#limit": aws.String("limit"),
		},
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":zero":    {N: aws.String("0")},
			":one":     {N: aws.String("1")},
			":limit":   {N: aws.String(fmt.Sprintf("%d", limit))},
			":entity":  {S: aws.String("USER_QUOTA")},
			":expires": {N: aws.String(fmt.Sprintf("%d", now.UTC().AddDate(0, 2, 0).Unix()))},
		},
		ReturnValues: aws.String("ALL_NEW"),
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeConditionalCheckFailedException {
			// If quota was exceeded under the stored limit, check if the account's plan quota
			// is greater than the stored limit (e.g. user recently upgraded).
			// If #limit < :limit and #used < :limit, upgrade #limit and reserve one quota unit.
			upgradeRes, upgradeErr := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
				TableName: aws.String(tableName),
				Key: map[string]*dynamodb.AttributeValue{
					"requestId": {S: aws.String(key)},
					"timestamp": {N: aws.String("0")},
				},
				UpdateExpression:    aws.String("SET #used = #used + :one, #limit = :limit, entityType = :entity, expiresAt = :expires"),
				ConditionExpression: aws.String("#limit < :limit AND #used < :limit"),
				ExpressionAttributeNames: map[string]*string{
					"#used":  aws.String("used"),
					"#limit": aws.String("limit"),
				},
				ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
					":one":     {N: aws.String("1")},
					":limit":   {N: aws.String(fmt.Sprintf("%d", limit))},
					":entity":  {S: aws.String("USER_QUOTA")},
					":expires": {N: aws.String(fmt.Sprintf("%d", now.UTC().AddDate(0, 2, 0).Unix()))},
				},
				ReturnValues: aws.String("ALL_NEW"),
			})
			if upgradeErr == nil {
				checkQuotaAfterReservation(customerID, customerEmail, key, upgradeRes.Attributes, now)
				return reservedQuotaFromAttrs(key, limit, upgradeRes.Attributes, now), nil
			}
			if upAwsErr, ok := upgradeErr.(awserr.Error); ok && upAwsErr.Code() == dynamodb.ErrCodeConditionalCheckFailedException {
				// Monthly quota exceeded: trigger 100% alert check
				maybeSendQuotaAlert(customerID, customerEmail, key, limit, limit, now)
				return nil, errAccountQuotaExceeded
			}
			return nil, upgradeErr
		}
		return nil, err
	}
	checkQuotaAfterReservation(customerID, customerEmail, key, updateRes.Attributes, now)
	return reservedQuotaFromAttrs(key, limit, updateRes.Attributes, now), nil
}

func reservedQuotaFromAttrs(key string, defaultLimit int, attrs map[string]*dynamodb.AttributeValue, now time.Time) *accountQuota {
	used, hasUsed := parseQuotaAttrInt(attrs, "used")
	if !hasUsed {
		used = 1
	}
	actualLimit, hasLimit := parseQuotaAttrInt(attrs, "limit")
	if !hasLimit || actualLimit <= 0 {
		actualLimit = defaultLimit
	}
	return &accountQuota{
		Key:       key,
		Limit:     actualLimit,
		Used:      used,
		Remaining: max(0, actualLimit-used),
		Period:    now.UTC().Format("2006-01"),
	}
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
