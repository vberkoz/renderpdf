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
