package main

import (
	"os"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/aws/aws-sdk-go/service/sqs"
	"github.com/pdfcpu/pdfcpu/pkg/api"
)

type dynamoDBAPI interface {
	GetItem(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error)
	PutItem(*dynamodb.PutItemInput) (*dynamodb.PutItemOutput, error)
	UpdateItem(*dynamodb.UpdateItemInput) (*dynamodb.UpdateItemOutput, error)
}

type sqsAPI interface {
	SendMessageWithContext(aws.Context, *sqs.SendMessageInput, ...request.Option) (*sqs.SendMessageOutput, error)
}

var (
	bucketName                    = os.Getenv("BUCKET_NAME")
	packageBucketName             = os.Getenv("PACKAGE_BUCKET_NAME")
	tableName                     = os.Getenv("TABLE_NAME")
	sess                          = session.Must(session.NewSession())
	s3Client                      = s3.New(sess)
	sqsClient         sqsAPI      = sqs.New(sess)
	ddbClient         dynamoDBAPI = dynamodb.New(sess)
)

func init() {
	api.DisableConfigDir()
}
