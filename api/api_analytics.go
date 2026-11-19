package main

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

type requestAnalytics struct {
	RequestID     string
	Plan          string
	Status        string
	ErrorType     string
	HTMLBytes     int64
	PDFBytes      int64
	DurationMs    int64
	RenderMs      int64
	Country       string
	CustomerID    string
	APIKeyID      string
	SourceType    string
	SourceMode    string
	SourceVersion string
	SourceBytes   int64
}

func requestCountry(request events.APIGatewayProxyRequest) string {
	for name, value := range request.Headers {
		if strings.EqualFold(name, "CloudFront-Viewer-Country") {
			country := strings.ToUpper(strings.TrimSpace(value))
			if len(country) == 2 && country[0] >= 'A' && country[0] <= 'Z' && country[1] >= 'A' && country[1] <= 'Z' {
				return country
			}
		}
	}
	return ""
}

func authorizerValue(request events.APIGatewayProxyRequest, name string) string {
	value, ok := request.RequestContext.Authorizer[name]
	if ok {
		if text, ok := value.(string); ok {
			return text
		}
		return fmt.Sprint(value)
	}
	// API-key requests provide userId directly. Cognito-authorized dashboard
	// requests provide the account subject under claims.sub. Treat both as the
	// same template owner so the browser never has to handle an API key.
	if name == "userId" {
		if claims, ok := request.RequestContext.Authorizer["claims"].(map[string]interface{}); ok {
			if sub, ok := claims["sub"].(string); ok {
				return sub
			}
		}
		if claims, ok := request.RequestContext.Authorizer["claims"].(map[string]string); ok {
			return claims["sub"]
		}
	}
	return ""
}

func trialViewerIP(request events.APIGatewayProxyRequest) string {
	for name, value := range request.Headers {
		if strings.EqualFold(name, "X-RenderPDF-Viewer-IP") {
			if ip := net.ParseIP(strings.TrimSpace(value)); ip != nil {
				return ip.String()
			}
		}
	}

	return request.RequestContext.Identity.SourceIP
}

func trackUsage(parentCtx context.Context, analytics requestAnalytics) {
	now := time.Now().UTC()
	input := &dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item: map[string]*dynamodb.AttributeValue{
			"requestId":        {S: aws.String(analytics.RequestID)},
			"timestamp":        {N: aws.String(fmt.Sprintf("%d", now.Unix()))},
			"status":           {S: aws.String(analytics.Status)},
			"entityType":       {S: aws.String("PDF_REQUEST")},
			"plan":             {S: aws.String(analytics.Plan)},
			"GSI1PK":           {S: aws.String("USAGE#" + now.Format("2006-01-02"))},
			"GSI1SK":           {S: aws.String(fmt.Sprintf("%020d#%s", now.UnixNano(), analytics.RequestID))},
			"durationMs":       {N: aws.String(strconv.FormatInt(analytics.DurationMs, 10))},
			"renderDurationMs": {N: aws.String(strconv.FormatInt(analytics.RenderMs, 10))},
			"htmlBytes":        {N: aws.String(strconv.FormatInt(analytics.HTMLBytes, 10))},
		},
	}
	if analytics.PDFBytes > 0 {
		input.Item["size"] = &dynamodb.AttributeValue{N: aws.String(strconv.FormatInt(analytics.PDFBytes, 10))}
	}
	if analytics.ErrorType != "" {
		input.Item["errorType"] = &dynamodb.AttributeValue{S: aws.String(analytics.ErrorType)}
	}
	if analytics.Country != "" {
		input.Item["country"] = &dynamodb.AttributeValue{S: aws.String(analytics.Country)}
	}
	if analytics.CustomerID != "" {
		input.Item["customerId"] = &dynamodb.AttributeValue{S: aws.String(analytics.CustomerID)}
	}
	if analytics.APIKeyID != "" {
		input.Item["apiKeyId"] = &dynamodb.AttributeValue{S: aws.String(analytics.APIKeyID)}
	}
	if analytics.SourceType != "" {
		input.Item["sourceType"] = &dynamodb.AttributeValue{S: aws.String(analytics.SourceType)}
		input.Item["sourceMode"] = &dynamodb.AttributeValue{S: aws.String(analytics.SourceMode)}
		input.Item["sourceVersion"] = &dynamodb.AttributeValue{S: aws.String(analytics.SourceVersion)}
		input.Item["sourceBytes"] = &dynamodb.AttributeValue{N: aws.String(strconv.FormatInt(analytics.SourceBytes, 10))}
	}

	// Usage analytics must never consume the remaining request time after a PDF
	// has already been generated. The indexed write is best-effort.
	ctx, cancel := context.WithTimeout(parentCtx, 2*time.Second)
	defer cancel()
	if client, ok := ddbClient.(interface {
		PutItemWithContext(context.Context, *dynamodb.PutItemInput, ...request.Option) (*dynamodb.PutItemOutput, error)
	}); ok {
		if _, err := client.PutItemWithContext(ctx, input); err != nil {
			fmt.Printf("Usage analytics write skipped: %v\n", err)
		}
		return
	}
	if _, err := ddbClient.PutItem(input); err != nil {
		fmt.Printf("Usage analytics write skipped: %v\n", err)
	}
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
