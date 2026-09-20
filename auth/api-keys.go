//go:build apikeys

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/apigateway"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/google/uuid"
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

type CreateKeyRequest struct {
	Name string `json:"name,omitempty"`
}

type CreateKeyResponse struct {
	KeyID  string `json:"keyId"`
	APIKey string `json:"apiKey"`
	Name   string `json:"name,omitempty"`
}

type ListKeysResponse struct {
	Keys []APIKeyInfo `json:"keys"`
}

type APIKeyInfo struct {
	KeyID     string `json:"keyId"`
	Name      string `json:"name,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	LastUsed  int64  `json:"lastUsed,omitempty"`
	IsActive  bool   `json:"isActive"`
}

type APIErrorResponse struct {
	Error     string `json:"error"`
	Code      string `json:"code"`
	RequestID string `json:"requestId,omitempty"`
}

func handler(ctx context.Context, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	requestID := request.RequestContext.RequestID
	if requestID == "" {
		requestID = uuid.NewString()
	}

	corsHeaders := map[string]string{
		"Access-Control-Allow-Origin":      "https://dashboard.renderpdf.vberkoz.com",
		"Access-Control-Allow-Credentials": "true",
		"Content-Type":                     "application/json",
		"Access-Control-Expose-Headers":    "X-Request-Id",
		"X-Request-Id":                     requestID,
	}
	userID := cognitoSubject(request)
	userEmail := cognitoEmail(request)
	if userID == "" {
		return apiErrorResponse(401, "authentication_required", "Authentication is required", corsHeaders), nil
	}

	switch request.HTTPMethod {
	case "POST":
		var req CreateKeyRequest
		if request.Body != "" {
			_ = json.Unmarshal([]byte(request.Body), &req)
		}
		return createKey(userID, userEmail, req.Name, corsHeaders)
	case "GET":
		return listKeys(userID, corsHeaders)
	case "DELETE":
		keyId := request.PathParameters["id"]
		return deleteKey(userID, keyId, corsHeaders)
	default:
		return apiErrorResponse(405, "method_not_allowed", "Method not allowed", corsHeaders), nil
	}
}

func cognitoSubject(request events.APIGatewayProxyRequest) string {
	claims, ok := request.RequestContext.Authorizer["claims"].(map[string]interface{})
	if !ok {
		return ""
	}
	subject, _ := claims["sub"].(string)
	return strings.TrimSpace(subject)
}

func cognitoEmail(request events.APIGatewayProxyRequest) string {
	claims, ok := request.RequestContext.Authorizer["claims"].(map[string]interface{})
	if !ok {
		return ""
	}
	email, _ := claims["email"].(string)
	return strings.TrimSpace(email)
}

func apiErrorResponse(status int, code, message string, headers map[string]string) events.APIGatewayProxyResponse {
	body, _ := json.Marshal(APIErrorResponse{Error: message, Code: code, RequestID: headers["X-Request-Id"]})
	return events.APIGatewayProxyResponse{StatusCode: status, Body: string(body), Headers: headers}
}

func getUserKeyCount(userId string) (int, error) {
	result, err := ddb.Query(&dynamodb.QueryInput{
		TableName:              aws.String(tableName),
		KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :sk)"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":pk": {S: aws.String(fmt.Sprintf("USER#%s", userId))},
			":sk": {S: aws.String("APIKEY#")},
		},
		Select: aws.String("COUNT"),
	})
	if err != nil {
		return 0, err
	}
	if result.Count != nil {
		return int(*result.Count), nil
	}
	return 0, nil
}

func createKey(userId, userEmail, keyName string, headers map[string]string) (events.APIGatewayProxyResponse, error) {
	keyName = strings.TrimSpace(keyName)
	if keyName == "" {
		existingCount, err := getUserKeyCount(userId)
		if err == nil && existingCount == 0 {
			keyName = "Default Key"
		} else {
			keyName = "API Key"
		}
	}

	keyId := uuid.New().String()
	apiKey := generateAPIKey()
	hashedKey := hashKey(apiKey)

	var apiGatewayKeyId string
	tier := getUserBillingTier(userId)
	planID := resolveUsagePlanID(tier, freeUsagePlanID, starterUsagePlanID, proUsagePlanID)

	if planID != "" {
		keyNameForAgw := fmt.Sprintf("%s-%s", userId, keyId)
		createOutput, err := apigw.CreateApiKey(&apigateway.CreateApiKeyInput{
			Name:    aws.String(keyNameForAgw),
			Value:   aws.String(hashedKey),
			Enabled: aws.Bool(true),
		})
		if err != nil {
			fmt.Printf("API Gateway CreateApiKey failed: %v\n", err)
		} else if createOutput != nil && createOutput.Id != nil {
			apiGatewayKeyId = *createOutput.Id
			_, planErr := apigw.CreateUsagePlanKey(&apigateway.CreateUsagePlanKeyInput{
				UsagePlanId: aws.String(planID),
				KeyId:       aws.String(apiGatewayKeyId),
				KeyType:     aws.String("API_KEY"),
			})
			if planErr != nil {
				fmt.Printf("API Gateway CreateUsagePlanKey failed: %v\n", planErr)
			}
		}
	}

	item := map[string]*dynamodb.AttributeValue{
		"PK":        {S: aws.String(fmt.Sprintf("USER#%s", userId))},
		"SK":        {S: aws.String(fmt.Sprintf("APIKEY#%s", keyId))},
		"GSI1PK":    {S: aws.String(fmt.Sprintf("APIKEY#%s", hashedKey))},
		"keyId":     {S: aws.String(keyId)},
		"name":      {S: aws.String(keyName)},
		"userId":    {S: aws.String(userId)},
		"createdAt": {N: aws.String(fmt.Sprintf("%d", time.Now().Unix()))},
		"isActive":  {BOOL: aws.Bool(true)},
	}
	if apiGatewayKeyId != "" {
		item["apiGatewayKeyId"] = &dynamodb.AttributeValue{S: aws.String(apiGatewayKeyId)}
	}
	if userEmail != "" {
		item["email"] = &dynamodb.AttributeValue{S: aws.String(userEmail)}
	}

	_, err := ddb.PutItem(&dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item:      item,
	})

	if err != nil {
		fmt.Printf("API key create failed: %v\n", err)
		return apiErrorResponse(503, "api_keys_unavailable", "API key management is temporarily unavailable", headers), nil
	}
	if userEmail != "" && usageTableName != "" {
		_, _ = ddb.UpdateItem(&dynamodb.UpdateItemInput{
			TableName: aws.String(usageTableName),
			Key: map[string]*dynamodb.AttributeValue{
				"requestId": {S: aws.String(fmt.Sprintf("USER_PROFILE#%s", userId))},
				"timestamp": {N: aws.String("0")},
			},
			UpdateExpression: aws.String("SET customerEmail = :email, entityType = :entity, updatedAt = :now"),
			ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
				":email":  {S: aws.String(userEmail)},
				":entity": {S: aws.String("USER_PROFILE")},
				":now":    {N: aws.String(fmt.Sprintf("%d", time.Now().Unix()))},
			},
		})
	}
	saveAnalyticsEvent(userId, "api_key_created")

	resp := CreateKeyResponse{KeyID: keyId, APIKey: apiKey, Name: keyName}
	body, _ := json.Marshal(resp)

	return events.APIGatewayProxyResponse{
		StatusCode: 200,
		Body:       string(body),
		Headers:    headers,
	}, nil
}

func saveAnalyticsEvent(customerID, eventName string) {
	if usageTableName == "" {
		return
	}
	now := time.Now().UTC()
	eventID := uuid.NewString()
	_, err := ddb.PutItem(&dynamodb.PutItemInput{
		TableName: aws.String(usageTableName),
		Item: map[string]*dynamodb.AttributeValue{
			"requestId":  {S: aws.String("ANALYTICS#" + eventID)},
			"timestamp":  {N: aws.String(fmt.Sprintf("%d", now.Unix()))},
			"entityType": {S: aws.String("ANALYTICS")},
			"eventName":  {S: aws.String(eventName)},
			"customerId": {S: aws.String(customerID)},
			"GSI1PK":     {S: aws.String("ANALYTICS#" + now.Format("2006-01-02"))},
			"GSI1SK":     {S: aws.String(fmt.Sprintf("%020d#%s", now.UnixNano(), eventID))},
			"expiresAt":  {N: aws.String(fmt.Sprintf("%d", now.Add(90*24*time.Hour).Unix()))},
		},
	})
	if err != nil {
		fmt.Printf("Analytics event write skipped: %v\n", err)
	}
}

func listKeys(userId string, headers map[string]string) (events.APIGatewayProxyResponse, error) {
	result, err := ddb.Query(&dynamodb.QueryInput{
		TableName:              aws.String(tableName),
		KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :sk)"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":pk": {S: aws.String(fmt.Sprintf("USER#%s", userId))},
			":sk": {S: aws.String("APIKEY#")},
		},
	})

	if err != nil {
		fmt.Printf("API key list failed: %v\n", err)
		return apiErrorResponse(503, "api_keys_unavailable", "API key management is temporarily unavailable", headers), nil
	}

	keys := []APIKeyInfo{}
	for _, item := range result.Items {
		key := APIKeyInfo{
			KeyID:    *item["keyId"].S,
			IsActive: *item["isActive"].BOOL,
		}
		if item["name"] != nil && item["name"].S != nil {
			key.Name = *item["name"].S
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
		Headers:    headers,
	}, nil
}

func deleteKey(userId, keyId string, headers map[string]string) (events.APIGatewayProxyResponse, error) {
	// Look up the key first to see if apiGatewayKeyId is present
	getItem, getErr := ddb.GetItem(&dynamodb.GetItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"PK": {S: aws.String(fmt.Sprintf("USER#%s", userId))},
			"SK": {S: aws.String(fmt.Sprintf("APIKEY#%s", keyId))},
		},
	})
	if getErr == nil && getItem != nil && getItem.Item != nil {
		if agwKey := getItem.Item["apiGatewayKeyId"]; agwKey != nil && agwKey.S != nil && *agwKey.S != "" {
			_, err := apigw.DeleteApiKey(&apigateway.DeleteApiKeyInput{
				ApiKey: agwKey.S,
			})
			if err != nil {
				fmt.Printf("API Gateway DeleteApiKey failed: %v\n", err)
			}
		}
	}

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
		fmt.Printf("API key revoke failed: %v\n", err)
		return apiErrorResponse(503, "api_keys_unavailable", "API key management is temporarily unavailable", headers), nil
	}

	return events.APIGatewayProxyResponse{StatusCode: 204, Headers: headers}, nil
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

func main() {
	lambda.Start(handler)
}
