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
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

var (
	tableName = os.Getenv("API_KEYS_TABLE")
	sess      = session.Must(session.NewSession())
	ddb       = dynamodb.New(sess)
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
	if item["keyId"] != nil && item["keyId"].S != nil {
		policy.Context["apiKeyId"] = *item["keyId"].S
	}
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

func main() {
	lambda.Start(handler)
}
