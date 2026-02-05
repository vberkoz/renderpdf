//go:build authorizer

package main

import (
	"context"
	"fmt"
	"os"
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
	apiKey := event.Headers["x-api-key"]
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

	return generatePolicy(userId, "Allow", event.MethodArn), nil
}

func generatePolicy(principalID, effect, resource string) events.APIGatewayCustomAuthorizerResponse {
	if principalID == "" {
		principalID = "user"
	}
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

func main() {
	lambda.Start(handler)
}
