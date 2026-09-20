package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/cognitoidentityprovider"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/ses"
)

type sesEmailSender interface {
	SendEmailWithContext(ctx aws.Context, input *ses.SendEmailInput, opts ...request.Option) (*ses.SendEmailOutput, error)
}

type cognitoUserGetter interface {
	AdminGetUserWithContext(ctx aws.Context, input *cognitoidentityprovider.AdminGetUserInput, opts ...request.Option) (*cognitoidentityprovider.AdminGetUserOutput, error)
}

var (
	sesClient      sesEmailSender    = ses.New(sess)
	cognitoClient  cognitoUserGetter = cognitoidentityprovider.New(sess)
	defaultSESFrom                   = "RenderPDF <support@renderpdf.vberkoz.com>"
)

func notificationSenderAddress() string {
	from := strings.TrimSpace(os.Getenv("NOTIFICATION_FROM_EMAIL"))
	if from != "" {
		return from
	}
	return defaultSESFrom
}

func sendSESEmail(ctx context.Context, toEmail, subject, htmlBody, textBody string) error {
	toEmail = strings.TrimSpace(toEmail)
	if toEmail == "" {
		return fmt.Errorf("recipient email is required")
	}
	if sesClient == nil {
		return fmt.Errorf("SES client is not configured")
	}
	fromEmail := notificationSenderAddress()
	input := &ses.SendEmailInput{
		Source: aws.String(fromEmail),
		Destination: &ses.Destination{
			ToAddresses: []*string{aws.String(toEmail)},
		},
		Message: &ses.Message{
			Subject: &ses.Content{
				Data:    aws.String(subject),
				Charset: aws.String("UTF-8"),
			},
			Body: &ses.Body{
				Html: &ses.Content{
					Data:    aws.String(htmlBody),
					Charset: aws.String("UTF-8"),
				},
				Text: &ses.Content{
					Data:    aws.String(textBody),
					Charset: aws.String("UTF-8"),
				},
			},
		},
	}
	_, err := sesClient.SendEmailWithContext(ctx, input)
	return err
}

func resolveCustomerEmail(ctx context.Context, customerID, directEmail string) string {
	if email := strings.TrimSpace(directEmail); email != "" {
		return email
	}
	if customerID == "" {
		return ""
	}

	// 1. Check USER_PROFILE#<customerID> in UsageTable
	if tableName != "" && ddbClient != nil {
		res, err := ddbClient.GetItem(&dynamodb.GetItemInput{
			TableName: aws.String(tableName),
			Key: map[string]*dynamodb.AttributeValue{
				"requestId": {S: aws.String("USER_PROFILE#" + customerID)},
				"timestamp": {N: aws.String("0")},
			},
			ConsistentRead: aws.Bool(true),
		})
		if err == nil && res.Item != nil && res.Item["customerEmail"] != nil && res.Item["customerEmail"].S != nil {
			email := strings.TrimSpace(*res.Item["customerEmail"].S)
			if email != "" {
				return email
			}
		}

		// 2. Check BILLING#<customerID> in UsageTable
		billRes, err := ddbClient.GetItem(&dynamodb.GetItemInput{
			TableName: aws.String(tableName),
			Key: map[string]*dynamodb.AttributeValue{
				"requestId": {S: aws.String("BILLING#" + customerID)},
				"timestamp": {N: aws.String("0")},
			},
			ConsistentRead: aws.Bool(true),
		})
		if err == nil && billRes.Item != nil && billRes.Item["customerEmail"] != nil && billRes.Item["customerEmail"].S != nil {
			email := strings.TrimSpace(*billRes.Item["customerEmail"].S)
			if email != "" {
				return email
			}
		}
	}

	// 3. Fallback to Cognito AdminGetUser if user pool ID is available
	userPoolID := strings.TrimSpace(os.Getenv("USER_POOL_ID"))
	if userPoolID != "" && cognitoClient != nil {
		userRes, err := cognitoClient.AdminGetUserWithContext(ctx, &cognitoidentityprovider.AdminGetUserInput{
			UserPoolId: aws.String(userPoolID),
			Username:   aws.String(customerID),
		})
		if err == nil && userRes != nil {
			for _, attr := range userRes.UserAttributes {
				if attr.Name != nil && *attr.Name == "email" && attr.Value != nil {
					email := strings.TrimSpace(*attr.Value)
					if email != "" {
						// Cache to USER_PROFILE for next time
						if tableName != "" && ddbClient != nil {
							_, _ = ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
								TableName: aws.String(tableName),
								Key: map[string]*dynamodb.AttributeValue{
									"requestId": {S: aws.String("USER_PROFILE#" + customerID)},
									"timestamp": {N: aws.String("0")},
								},
								UpdateExpression: aws.String("SET customerEmail = :email, entityType = :entity, updatedAt = :now"),
								ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
									":email":  {S: aws.String(email)},
									":entity": {S: aws.String("USER_PROFILE")},
									":now":    {N: aws.String(fmt.Sprintf("%d", time.Now().Unix()))},
								},
							})
						}
						return email
					}
				}
			}
		}
	}

	return ""
}

func claimQuota80Alert(quotaKey string, now time.Time) (bool, error) {
	if ddbClient == nil || tableName == "" {
		return false, fmt.Errorf("DynamoDB client is not available")
	}
	_, err := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(quotaKey)},
			"timestamp": {N: aws.String("0")},
		},
		UpdateExpression:    aws.String("SET alert80SentAt = :now"),
		ConditionExpression: aws.String("attribute_not_exists(alert80SentAt)"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":now": {N: aws.String(fmt.Sprintf("%d", now.Unix()))},
		},
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeConditionalCheckFailedException {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func claimQuota100Alert(quotaKey string, limit int, now time.Time) (bool, error) {
	if ddbClient == nil || tableName == "" {
		return false, fmt.Errorf("DynamoDB client is not available")
	}
	_, err := ddbClient.UpdateItem(&dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"requestId": {S: aws.String(quotaKey)},
			"timestamp": {N: aws.String("0")},
		},
		UpdateExpression:    aws.String("SET alert100SentLimit = :limit, alert100SentAt = :now"),
		ConditionExpression: aws.String("attribute_not_exists(alert100SentLimit) OR alert100SentLimit < :limit"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":limit": {N: aws.String(fmt.Sprintf("%d", limit))},
			":now":   {N: aws.String(fmt.Sprintf("%d", now.Unix()))},
		},
	})
	if err != nil {
		if awsErr, ok := err.(awserr.Error); ok && awsErr.Code() == dynamodb.ErrCodeConditionalCheckFailedException {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func buildQuota80Email(used, limit int) (subject, htmlBody, textBody string) {
	subject = "RenderPDF Quota Alert: 80% of monthly allowance reached"
	pct := (used * 100) / limit
	if pct < 80 {
		pct = 80
	}

	textBody = fmt.Sprintf(
		"RenderPDF Quota Alert\n\n"+
			"You've used 80%% of your monthly RenderPDF allowance. Upgrade to avoid API disruptions.\n\n"+
			"Current Usage: %d / %d PDFs (%d%%)\n\n"+
			"Upgrade your monthly allowance here:\n"+
			"https://renderpdf.vberkoz.com/app/#billing\n\n"+
			"— RenderPDF Team",
		used, limit, pct,
	)

	htmlBody = fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RenderPDF Quota Alert</title>
</head>
<body style="margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f7f9fb; color: #17212b;">
  <table width="100%%" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8ef; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
    <tr>
      <td style="padding: 32px 32px 20px 32px; text-align: center; border-bottom: 1px solid #f1f5f9;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em;">RenderPDF</h1>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px;">
        <div style="display: inline-block; padding: 4px 12px; border-radius: 9999px; background: #fef3c7; color: #92400e; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px;">Quota Notice</div>
        <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1e293b;">80%% Monthly Allowance Reached</h2>
        <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #475569;">
          You've used 80%% of your monthly RenderPDF allowance. Upgrade to avoid API disruptions.
        </p>
        <div style="background: #f8fafc; border: 1px solid #e2e8ef; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <div style="display: flex; justify-content: space-between; font-size: 14px; font-weight: 500; color: #334155; margin-bottom: 8px;">
            <span>Current Usage</span>
            <span><strong>%d</strong> / %d PDFs (%d%%)</span>
          </div>
          <div style="width: 100%%; height: 8px; background: #e2e8ef; border-radius: 9999px; overflow: hidden;">
            <div style="width: %d%%; height: 100%%; background: #f59e0b; border-radius: 9999px;"></div>
          </div>
        </div>
        <div style="text-align: center; margin-top: 28px;">
          <a href="https://renderpdf.vberkoz.com/app/#billing" style="display: inline-block; padding: 12px 28px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">Upgrade Plan</a>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding: 20px 32px; background: #f8fafc; border-top: 1px solid #f1f5f9; text-align: center; font-size: 12px; color: #94a3b8;">
        RenderPDF Automated Quota Service &bull; <a href="https://renderpdf.vberkoz.com/app/#billing" style="color: #64748b; text-decoration: underline;">Manage Subscription</a>
      </td>
    </tr>
  </table>
</body>
</html>`, used, limit, pct, pct)
	return subject, htmlBody, textBody
}

func buildQuota100Email(used, limit int) (subject, htmlBody, textBody string) {
	subject = "RenderPDF Quota Alert: Monthly allowance reached (100%)"

	textBody = fmt.Sprintf(
		"RenderPDF Quota Alert\n\n"+
			"You've reached 100%% of your monthly RenderPDF allowance (%d / %d PDFs).\n\n"+
			"To avoid API disruptions and continue rendering PDFs, you can purchase an overage pack or upgrade your tier immediately:\n\n"+
			"Quick Link - Purchase 1,000 PDF overage:\n"+
			"https://renderpdf.vberkoz.com/app/#billing\n\n"+
			"Quick Link - Upgrade tier:\n"+
			"https://renderpdf.vberkoz.com/app/#billing\n\n"+
			"— RenderPDF Team",
		used, limit,
	)

	htmlBody = fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RenderPDF Quota Exceeded</title>
</head>
<body style="margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f7f9fb; color: #17212b;">
  <table width="100%%" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8ef; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
    <tr>
      <td style="padding: 32px 32px 20px 32px; text-align: center; border-bottom: 1px solid #f1f5f9;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em;">RenderPDF</h1>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px;">
        <div style="display: inline-block; padding: 4px 12px; border-radius: 9999px; background: #fee2e2; color: #991b1b; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px;">Quota Exceeded</div>
        <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1e293b;">100%% Monthly Allowance Reached</h2>
        <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #475569;">
          You've used 100%% of your monthly RenderPDF allowance (%d / %d PDFs). Subsequent rendering requests will be rejected until the quota resets or additional credits are purchased.
        </p>
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="margin: 0; font-size: 14px; color: #b91c1c; font-weight: 500;">
            Choose a quick option below to restore immediate API access:
          </p>
        </div>
        <table width="100%%" border="0" cellspacing="0" cellpadding="0" style="margin-top: 16px;">
          <tr>
            <td align="center" style="padding-bottom: 12px;">
              <a href="https://renderpdf.vberkoz.com/app/#billing" style="display: inline-block; width: 80%%; text-align: center; padding: 12px 24px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">Purchase 1,000 PDF Overage</a>
            </td>
          </tr>
          <tr>
            <td align="center">
              <a href="https://renderpdf.vberkoz.com/app/#billing" style="display: inline-block; width: 80%%; text-align: center; padding: 12px 24px; background: #f1f5f9; color: #334155; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; border: 1px solid #cbd5e1;">Upgrade Tier</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding: 20px 32px; background: #f8fafc; border-top: 1px solid #f1f5f9; text-align: center; font-size: 12px; color: #94a3b8;">
        RenderPDF Automated Quota Service &bull; <a href="https://renderpdf.vberkoz.com/app/#billing" style="color: #64748b; text-decoration: underline;">Manage Subscription</a>
      </td>
    </tr>
  </table>
</body>
</html>`, used, limit)
	return subject, htmlBody, textBody
}

func maybeSendQuotaAlert(customerID, directEmail, quotaKey string, used, limit int, now time.Time) {
	if customerID == "" || limit <= 0 {
		return
	}

	// 1. Check 100% capacity threshold
	if used >= limit {
		claimed, err := claimQuota100Alert(quotaKey, limit, now)
		if err != nil {
			fmt.Printf("Error claiming 100%% quota alert for %s: %v\n", customerID, err)
			return
		}
		if claimed {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			email := resolveCustomerEmail(ctx, customerID, directEmail)
			if email != "" {
				subj, html, text := buildQuota100Email(used, limit)
				if sendErr := sendSESEmail(ctx, email, subj, html, text); sendErr != nil {
					fmt.Printf("Failed to send 100%% quota alert email to %s: %v\n", email, sendErr)
				} else {
					fmt.Printf("Sent 100%% quota alert email to %s (used %d of %d)\n", email, used, limit)
				}
			} else {
				fmt.Printf("No email found to send 100%% quota alert for customer %s\n", customerID)
			}
		}
		return
	}

	// 2. Check 80% capacity threshold (80% <= used < 100%)
	if used >= (limit*8)/10 {
		claimed, err := claimQuota80Alert(quotaKey, now)
		if err != nil {
			fmt.Printf("Error claiming 80%% quota alert for %s: %v\n", customerID, err)
			return
		}
		if claimed {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			email := resolveCustomerEmail(ctx, customerID, directEmail)
			if email != "" {
				subj, html, text := buildQuota80Email(used, limit)
				if sendErr := sendSESEmail(ctx, email, subj, html, text); sendErr != nil {
					fmt.Printf("Failed to send 80%% quota alert email to %s: %v\n", email, sendErr)
				} else {
					fmt.Printf("Sent 80%% quota alert email to %s (used %d of %d)\n", email, used, limit)
				}
			} else {
				fmt.Printf("No email found to send 80%% quota alert for customer %s\n", customerID)
			}
		}
	}
}
