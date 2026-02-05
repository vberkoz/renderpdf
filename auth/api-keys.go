//go:build apikeys

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/google/uuid"
)

var (
	tableName = os.Getenv("API_KEYS_TABLE")
	sess      = session.Must(session.NewSession())
	ddb       = dynamodb.New(sess)
)

type CreateKeyResponse struct {
	KeyID  string `json:"keyId"`
	APIKey string `json:"apiKey"`
}

type ListKeysResponse struct {
	Keys []APIKeyInfo `json:"keys"`
}

type APIKeyInfo struct {
	KeyID     string `json:"keyId"`
	CreatedAt int64  `json:"createdAt"`
	LastUsed  int64  `json:"lastUsed,omitempty"`
	IsActive  bool   `json:"isActive"`
}

func handler(ctx context.Context, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	userId := request.RequestContext.Authorizer["userId"].(string)

	switch request.HTTPMethod {
	case "POST":
		return createKey(userId)
	case "GET":
		return listKeys(userId)
	case "DELETE":
		keyId := request.PathParameters["id"]
		return deleteKey(userId, keyId)
	default:
		return events.APIGatewayProxyResponse{StatusCode: 405}, nil
	}
}

func createKey(userId string) (events.APIGatewayProxyResponse, error) {
	keyId := uuid.New().String()
	apiKey := generateAPIKey()
	hashedKey := hashKey(apiKey)

	_, err := ddb.PutItem(&dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item: map[string]*dynamodb.AttributeValue{
			"PK":        {S: aws.String(fmt.Sprintf("USER#%s", userId))},
			"SK":        {S: aws.String(fmt.Sprintf("APIKEY#%s", keyId))},
			"GSI1PK":    {S: aws.String(fmt.Sprintf("APIKEY#%s", hashedKey))},
			"keyId":     {S: aws.String(keyId)},
			"userId":    {S: aws.String(userId)},
			"createdAt": {N: aws.String(fmt.Sprintf("%d", time.Now().Unix()))},
			"isActive":  {BOOL: aws.Bool(true)},
		},
	})

	if err != nil {
		return events.APIGatewayProxyResponse{StatusCode: 500, Body: err.Error()}, nil
	}

	resp := CreateKeyResponse{KeyID: keyId, APIKey: apiKey}
	body, _ := json.Marshal(resp)

	return events.APIGatewayProxyResponse{
		StatusCode: 200,
		Body:       string(body),
		Headers:    map[string]string{"Content-Type": "application/json"},
	}, nil
}

func listKeys(userId string) (events.APIGatewayProxyResponse, error) {
	result, err := ddb.Query(&dynamodb.QueryInput{
		TableName:              aws.String(tableName),
		KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :sk)"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":pk": {S: aws.String(fmt.Sprintf("USER#%s", userId))},
			":sk": {S: aws.String("APIKEY#")},
		},
	})

	if err != nil {
		return events.APIGatewayProxyResponse{StatusCode: 500, Body: err.Error()}, nil
	}

	keys := []APIKeyInfo{}
	for _, item := range result.Items {
		key := APIKeyInfo{
			KeyID:    *item["keyId"].S,
			IsActive: *item["isActive"].BOOL,
		}
		if item["createdAt"] != nil {
			fmt.Sscanf(*item["createdAt"].N, "%d", &key.CreatedAt)
		}
		if item["lastUsed"] != nil {
			fmt.Sscanf(*item["lastUsed"].N, "%d", &key.LastUsed)
		}
		keys = append(keys, key)
	}

	resp := ListKeysResponse{Keys: keys}
	body, _ := json.Marshal(resp)

	return events.APIGatewayProxyResponse{
		StatusCode: 200,
		Body:       string(body),
		Headers:    map[string]string{"Content-Type": "application/json"},
	}, nil
}

func deleteKey(userId, keyId string) (events.APIGatewayProxyResponse, error) {
	_, err := ddb.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"PK": {S: aws.String(fmt.Sprintf("USER#%s", userId))},
			"SK": {S: aws.String(fmt.Sprintf("APIKEY#%s", keyId))},
		},
		UpdateExpression: aws.String("SET isActive = :false"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":false": {BOOL: aws.Bool(false)},
		},
	})

	if err != nil {
		return events.APIGatewayProxyResponse{StatusCode: 500, Body: err.Error()}, nil
	}

	return events.APIGatewayProxyResponse{StatusCode: 204}, nil
}

func main() {
	lambda.Start(handler)
}
