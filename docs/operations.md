# Operations Runbook

## AWS Budget Alerts

The CloudFormation stack creates one SNS topic and two account-level cost
budgets. Both publish to the topic, whose email subscription sends the alerts
to `OperationsAlertEmail`.

| Budget | Default | Alert condition |
| --- | ---: | --- |
| Normal operating cost | $15/month | Actual or forecast spend exceeds 80% ($12) |
| Emergency cost ceiling | $30/month | Actual or forecast spend exceeds 100% ($30) |

Set `OperationsAlertEmail` to the operational owner and set the two limits to
values appropriate for the AWS account before deployment. These are
account-level budgets: costs from unrelated workloads in the same account also
count toward the limits.

After the first deployment or after changing the email address, AWS sends an
SNS subscription-confirmation message. Confirm it before relying on alerts.

## UptimeRobot Free Monitor and Status Page

UptimeRobot is intentionally configured outside CloudFormation because it is a
third-party account and its public status-page URL is account-specific. Create
the following free HTTP(S) monitors in UptimeRobot:

| Name | URL | Interval | Expected result |
| --- | --- | --- | --- |
| RenderPDF website | `https://renderpdf.vberkoz.com/` | 5 minutes | HTTP 200–299 |
| RenderPDF API | `https://renderpdf.vberkoz.com/api/v1/trial/quota` | 5 minutes | HTTP 200–299 |

Then create a public status page containing both monitors and save its public
URL in the operational password manager. Configure the same operational email
address for downtime and recovery notifications. Do not commit UptimeRobot API
keys, credentials, or status-page management URLs to this repository.

The API monitor uses the read-only trial quota endpoint, so it never creates a
PDF or consumes the trial-render quota.

## Support & Feedback Email Routing (Forward Email)

The CloudFormation stack defines Route 53 MX and TXT records for `renderpdf.vberkoz.com` using [Forward Email](https://forwardemail.net) to forward incoming messages sent to `support@renderpdf.vberkoz.com` directly to `SupportFeedbackEmail` (default: `vberkoz@gmail.com`).

- **MX Records**: `mx1.forwardemail.net` (priority 10), `mx2.forwardemail.net` (priority 20).
- **Routing TXT Record**: `forward-email=support:${SupportFeedbackEmail},*:${SupportFeedbackEmail}` routes emails sent to `support@renderpdf.vberkoz.com` as well as any other address on the domain.
- **SPF TXT Record**: `v=spf1 a mx include:spf.forwardemail.net -all` authorizes Forward Email to handle deliveries without landing in spam.

To change the forwarding destination, update the `SupportFeedbackEmail` parameter in `parameters.json` and deploy.

## AWS CloudWatch Alarms (Always-Free Tier)

The CloudFormation stack defines 5 standard-resolution CloudWatch Alarms and 2 CloudWatch Logs Metric Filters configured to operate permanently within the AWS Always-Free Tier ($0.00/month). All alarms publish directly to `OperationsAlertsTopic` and deliver emails to `OperationsAlertEmail`.

| Alarm Name | Metric Source | Condition | Evaluation | Purpose / Remediation |
| --- | --- | --- | --- | --- |
| `${AppName}-api-5xx-spikes` | `AWS/ApiGateway` `5XXError` | $\ge 5$ | 5 min (1 period) | Catches API-wide 5xx error spikes across all endpoints (PDF, Auth, Analytics, Webhooks). Check API Gateway logs and Lambda execution logs. |
| `${AppName}-chromium-timeouts-crashes` | `RenderPDF/Observability` `ChromiumTimeouts` | $\ge 1$ | 5 min (1 period) | Filter on `/aws/lambda/${AppName}-generate` for Chromium crashes, startup timeouts, and 504 page navigation hangs. Check for malformed customer HTML or heavy assets. |
| `${AppName}-webhook-dlq-messages` | `AWS/SQS` `ApproximateNumberOfMessagesVisible` on `WebhookDeadLetterQueue` | $> 0$ | 5 min (1 period) | Customer webhook delivery failed after 4 retries and moved to dead-letter queue. Check target URL health and customer endpoint status. |
| `${AppName}-batch-dlq-messages` | `AWS/SQS` `ApproximateNumberOfMessagesVisible` on `BatchDeadLetterQueue` | $> 0$ | 5 min (1 period) | Asynchronous batch item failed rendering or processing. Check `BatchReconcilerFunction` logs and batch item records in DynamoDB. |
| `${AppName}-paddle-webhook-failures` | `RenderPDF/Observability` `PaddleWebhookProcessingFailures` | $> 0$ | 5 min (1 period) | Critical billing failure. Sourced from `/aws/lambda/${AppName}-analytics-node` logs when webhook signature verification fails, overage credit fails, or DynamoDB write fails. Investigate immediately to avoid billing discrepancy. |

### Verifying and Testing Alarms

Confirm all alarms are in `OK` state:

```bash
aws cloudwatch describe-alarms --alarm-name-prefix renderpdf --query 'MetricAlarms[*].[AlarmName,StateValue]' --output table
```

Simulate an alarm trigger to verify email delivery:

```bash
aws cloudwatch set-alarm-state \
  --alarm-name renderpdf-webhook-dlq-messages \
  --state-value ALARM \
  --state-reason "Verification drill"
```

Reset the alarm to `OK` afterwards:

```bash
aws cloudwatch set-alarm-state \
  --alarm-name renderpdf-webhook-dlq-messages \
  --state-value OK \
  --state-reason "Verification drill complete"
```
