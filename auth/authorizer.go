//go:build authorizer

package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/apigateway"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

var (
	tableName          = os.Getenv("API_KEYS_TABLE")
	usageTableName     = os.Getenv("TABLE_NAME")
	freeUsagePlanID    = os.Getenv("FREE_USAGE_PLAN_ID")
	starterUsagePlanID = os.Getenv("STARTER_USAGE_PLAN_ID")
	proUsagePlanID     = os.Getenv("PRO_USAGE_PLAN_ID")
	sess               = session.Must(session.NewSession())
	ddb                = dynamodb.New(sess)
	apigw              = apigateway.New(sess)
)

func handler(ctx context.Context, event events.APIGatewayCustomAuthorizerRequestTypeRequest) (events.APIGatewayCustomAuthorizerResponse, error) {
	apiKey := bearerToken(event.Headers)
	if apiKey == "" {
		return generatePolicy("", "Deny", event.MethodArn), nil
	}

	hashedKey := hashKey(apiKey)
	result, err := ddb.Query(&dynamodb.QueryInput{
		TableName:              aws.String(tableName),
		IndexName:              aws.String("GSI1"),
		KeyConditionExpression: aws.String("GSI1PK = :pk"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":pk": {S: aws.String(fmt.Sprintf("APIKEY#%s", hashedKey))},
		},
	})

	if err != nil || len(result.Items) == 0 {
		return generatePolicy("", "Deny", event.MethodArn), nil
	}

	item := result.Items[0]
	isActive := item["isActive"] != nil && *item["isActive"].BOOL
	if !isActive {
		return generatePolicy("", "Deny", event.MethodArn), nil
	}

	userId := ""
	if item["userId"] != nil {
		userId = *item["userId"].S
	}

	ddb.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"PK": item["PK"],
			"SK": item["SK"],
		},
		UpdateExpression: aws.String("SET lastUsed = :now"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":now": {N: aws.String(fmt.Sprintf("%d", time.Now().Unix()))},
		},
	})

	policy := generatePolicy(userId, "Allow", event.MethodArn)
	policy.UsageIdentifierKey = hashedKey
	if item["keyId"] != nil && item["keyId"].S != nil {
		policy.Context["apiKeyId"] = *item["keyId"].S
	}
	if item["email"] != nil && item["email"].S != nil && *item["email"].S != "" {
		policy.Context["email"] = *item["email"].S
	}

	keyId := ""
	if item["keyId"] != nil && item["keyId"].S != nil {
		keyId = *item["keyId"].S
	}
	ensureApiKeyInUsagePlan(hashedKey, keyId, userId, item)

	return policy, nil
}

func headerValue(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

func bearerToken(headers map[string]string) string {
	value := strings.TrimSpace(headerValue(headers, "Authorization"))
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

func generatePolicy(principalID, effect, resource string) events.APIGatewayCustomAuthorizerResponse {
	if principalID == "" {
		principalID = "user"
	}
	// API Gateway caches this authorizer by Authorization header for five
	// minutes. A policy restricted to the triggering method ARN would therefore
	// deny a valid key when it next calls another endpoint (for example,
	// /uploads followed by /render-upload). Keep the policy within this API
	// stage, while allowing its authenticated routes to share the cache entry.
	resource = stageResource(resource)
	return events.APIGatewayCustomAuthorizerResponse{
		PrincipalID: principalID,
		PolicyDocument: events.APIGatewayCustomAuthorizerPolicy{
			Version: "2012-10-17",
			Statement: []events.IAMPolicyStatement{
				{
					Action:   []string{"execute-api:Invoke"},
					Effect:   effect,
					Resource: []string{resource},
				},
			},
		},
		Context: map[string]interface{}{
			"userId": principalID,
		},
	}
}

func stageResource(methodARN string) string {
	parts := strings.SplitN(methodARN, "/", 3)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return methodARN
	}
	return parts[0] + "/" + parts[1] + "/*"
}

func getUserBillingTier(userId string) string {
	if usageTableName == "" || userId == "" {
		return "free"
	}
	result, err := ddb.GetItem(&dynamodb.GetItemInput{
		TableName: aws.String(usageTableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String("BILLING#" + userId)},
			"timestamp": {N: aws.String("0")},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil || result.Item == nil {
		return "free"
	}
	if result.Item["status"] != nil && result.Item["status"].S != nil {
		status := *result.Item["status"].S
		if status == "active" || status == "trialing" || status == "past_due" {
			if result.Item["tier"] != nil && result.Item["tier"].S != nil {
				return *result.Item["tier"].S
			}
			return "pro"
		}
	}
	return "free"
}

func ensureApiKeyInUsagePlan(hashedKey, keyId, userId string, item map[string]*dynamodb.AttributeValue) string {
	if freeUsagePlanID == "" && starterUsagePlanID == "" && proUsagePlanID == "" {
		return ""
	}
	if item != nil && item["apiGatewayKeyId"] != nil && item["apiGatewayKeyId"].S != nil && *item["apiGatewayKeyId"].S != "" {
		return *item["apiGatewayKeyId"].S
	}

	tier := getUserBillingTier(userId)
	planID := resolveUsagePlanID(tier, freeUsagePlanID, starterUsagePlanID, proUsagePlanID)
	if planID == "" {
		return ""
	}

	keyName := fmt.Sprintf("%s-%s", userId, keyId)
	if keyId == "" {
		keyName = hashedKey[:16]
	}

	var apigwKeyID string
	createOutput, err := apigw.CreateApiKey(&apigateway.CreateApiKeyInput{
		Name:    aws.String(keyName),
		Value:   aws.String(hashedKey),
		Enabled: aws.Bool(true),
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == apigateway.ErrCodeConflictException {
			getOutput, getErr := apigw.GetApiKeys(&apigateway.GetApiKeysInput{
				NameQuery: aws.String(keyName),
			})
			if getErr == nil && getOutput != nil && len(getOutput.Items) > 0 {
				apigwKeyID = *getOutput.Items[0].Id
			}
		} else {
			fmt.Printf("CreateApiKey error: %v\n", err)
			return ""
		}
	} else if createOutput != nil && createOutput.Id != nil {
		apigwKeyID = *createOutput.Id
	}

	if apigwKeyID != "" {
		_, err = apigw.CreateUsagePlanKey(&apigateway.CreateUsagePlanKeyInput{
			UsagePlanId: aws.String(planID),
			KeyId:       aws.String(apigwKeyID),
			KeyType:     aws.String("API_KEY"),
		})
		if err != nil {
			if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == apigateway.ErrCodeConflictException {
				// Already associated with usage plan
			} else {
				fmt.Printf("CreateUsagePlanKey error: %v\n", err)
			}
		}

		if item != nil && item["PK"] != nil && item["SK"] != nil {
			_, _ = ddb.UpdateItem(&dynamodb.UpdateItemInput{
				TableName: aws.String(tableName),
				Key: map[string]*dynamodb.AttributeValue{
					"PK": item["PK"],
					"SK": item["SK"],
				},
				UpdateExpression: aws.String("SET apiGatewayKeyId = :agwId"),
				ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
					":agwId": {S: aws.String(apigwKeyID)},
				},
			})
		}
	}

	return apigwKeyID
}

func main() {
	lambda.Start(handler)
}
