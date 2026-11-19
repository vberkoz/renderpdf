package main

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func extractCFNResourceBlock(t *testing.T, template, resourceName string) string {
	t.Helper()
	lines := strings.Split(template, "\n")
	inResources := false
	start := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inResources {
			if trimmed == "Resources:" && !strings.HasPrefix(line, " ") {
				inResources = true
			}
			continue
		}
		if line != "" && !strings.HasPrefix(line, " ") && !strings.HasPrefix(trimmed, "#") {
			if start != -1 {
				return strings.Join(lines[start:i], "\n")
			}
			break
		}
		if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "   ") && strings.HasSuffix(trimmed, ":") {
			name := strings.TrimSuffix(trimmed, ":")
			if start != -1 {
				return strings.Join(lines[start:i], "\n")
			}
			if name == resourceName {
				start = i
			}
		}
	}
	if start != -1 {
		return strings.Join(lines[start:], "\n")
	}
	t.Fatalf("CloudFormation resource %q not found", resourceName)
	return ""
}

type parsedIAMStatement struct {
	effect    string
	actions   []string
	resources []string
}

func parseIAMStatements(block string) []parsedIAMStatement {
	lines := strings.Split(block, "\n")
	var statements []parsedIAMStatement
	var current *parsedIAMStatement
	field := ""
	inPolicies := false
	inStatements := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if trimmed == "Policies:" {
			inPolicies = true
			continue
		}
		if !inPolicies {
			continue
		}
		if trimmed == "Statement:" {
			inStatements = true
			continue
		}
		if !inStatements {
			continue
		}
		if strings.HasPrefix(trimmed, "- Effect:") {
			if current != nil {
				statements = append(statements, *current)
			}
			current = &parsedIAMStatement{effect: strings.TrimSpace(strings.TrimPrefix(trimmed, "- Effect:"))}
			field = ""
			continue
		}
		if current == nil {
			continue
		}
		if strings.HasPrefix(trimmed, "Action:") {
			val := strings.TrimSpace(strings.TrimPrefix(trimmed, "Action:"))
			field = "action"
			if val != "" {
				current.actions = append(current.actions, trimYAMLQuote(val))
				field = ""
			}
			continue
		}
		if strings.HasPrefix(trimmed, "Resource:") {
			val := strings.TrimSpace(strings.TrimPrefix(trimmed, "Resource:"))
			field = "resource"
			if val != "" {
				current.resources = append(current.resources, trimYAMLQuote(val))
				field = ""
			}
			continue
		}
		if strings.HasPrefix(trimmed, "- ") {
			item := trimYAMLQuote(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
			switch field {
			case "action":
				current.actions = append(current.actions, item)
			case "resource":
				current.resources = append(current.resources, item)
			}
		}
	}
	if current != nil {
		statements = append(statements, *current)
	}
	return statements
}

func trimYAMLQuote(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 2 && ((v[0] == '\'' && v[len(v)-1] == '\'') || (v[0] == '"' && v[len(v)-1] == '"')) {
		return v[1 : len(v)-1]
	}
	return v
}

func TestCloudFormationPhase1Hardening(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "infra", "cloudformation.yaml"))
	if err != nil {
		t.Fatalf("read cloudformation.yaml: %v", err)
	}
	template := string(raw)

	t.Run("DocumentStoreTable enables TTL on expiresAt", func(t *testing.T) {
		block := extractCFNResourceBlock(t, template, "DocumentStoreTable")
		for _, want := range []string{"TimeToLiveSpecification:", "AttributeName: expiresAt", "Enabled: true"} {
			if !strings.Contains(block, want) {
				t.Fatalf("DocumentStoreTable missing %q:\n%s", want, block)
			}
		}
	})

	t.Run("BatchWorkerFunction includes monthly quota and notification env vars", func(t *testing.T) {
		block := extractCFNResourceBlock(t, template, "BatchWorkerFunction")
		requiredVars := []string{
			"TABLE_NAME: !Ref UsageTable",
			"FREE_MONTHLY_QUOTA: !Ref FreeMonthlyQuota",
			"STARTER_MONTHLY_QUOTA: !Ref StarterMonthlyQuota",
			"PRO_MONTHLY_QUOTA: !Ref ProMonthlyQuota",
			"TEMPLATE_TABLE_NAME: !Ref TemplatesTable",
			"NOTIFICATION_FROM_EMAIL: !Ref NotificationFromEmail",
			"SES_REGION: !Ref SesRegion",
			"USER_POOL_ID: !Ref UserPoolV2",
		}
		for _, want := range requiredVars {
			if !strings.Contains(block, want) {
				t.Fatalf("BatchWorkerFunction missing %q:\n%s", want, block)
			}
		}
	})

	t.Run("TrialPdfFunction uses TrialLambdaExecutionRole and omits DOCUMENT_STORE_TABLE_NAME", func(t *testing.T) {
		block := extractCFNResourceBlock(t, template, "TrialPdfFunction")
		if !strings.Contains(block, "Role: !GetAtt TrialLambdaExecutionRole.Arn") {
			t.Fatalf("TrialPdfFunction does not reference TrialLambdaExecutionRole:\n%s", block)
		}
		if strings.Contains(block, "DOCUMENT_STORE_TABLE_NAME") {
			t.Fatalf("TrialPdfFunction must omit DOCUMENT_STORE_TABLE_NAME:\n%s", block)
		}
	})

	t.Run("TrialLambdaExecutionRole is least-privilege", func(t *testing.T) {
		block := extractCFNResourceBlock(t, template, "TrialLambdaExecutionRole")
		if !strings.Contains(block, "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole") {
			t.Fatalf("TrialLambdaExecutionRole missing AWSLambdaBasicExecutionRole:\n%s", block)
		}
		if !strings.Contains(block, "PolicyName: TrialLeastPrivilegeAccess") {
			t.Fatalf("TrialLambdaExecutionRole missing TrialLeastPrivilegeAccess policy:\n%s", block)
		}
		if strings.Count(block, "PolicyName:") != 1 {
			t.Fatalf("TrialLambdaExecutionRole must have exactly 1 inline policy:\n%s", block)
		}

		forbidden := []string{
			"DocumentStoreTable",
			"TemplatesTable",
			"ApiKeysTable",
			"PackageBucket",
			"WebhookQueue",
			"BatchQueue",
			"BatchDeadLetterQueue",
			"sqs:",
			"ses:",
			"cognito-idp:",
			"apigateway:",
			"bedrock:",
			"${PdfBucket.Arn}/*",
			"s3:DeleteObject",
			"s3:*",
			"dynamodb:*",
			"Resource: '*'",
		}
		for _, token := range forbidden {
			if strings.Contains(block, token) {
				t.Fatalf("TrialLambdaExecutionRole contains forbidden privilege %q:\n%s", token, block)
			}
		}

		statements := parseIAMStatements(block)
		if len(statements) != 2 {
			t.Fatalf("TrialLambdaExecutionRole statement count = %d, want 2; statements=%#v", len(statements), statements)
		}

		for i := range statements {
			sort.Strings(statements[i].actions)
			sort.Strings(statements[i].resources)
		}

		wantS3 := parsedIAMStatement{
			effect:    "Allow",
			actions:   []string{"s3:GetObject", "s3:PutObject"},
			resources: []string{"!Sub '${PdfBucket.Arn}/files/trial/*'"},
		}
		wantDDB := parsedIAMStatement{
			effect:    "Allow",
			actions:   []string{"dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"},
			resources: []string{"!GetAtt UsageTable.Arn"},
		}
		if !reflect.DeepEqual(statements[0], wantS3) {
			t.Fatalf("statement[0] = %#v, want %#v", statements[0], wantS3)
		}
		if !reflect.DeepEqual(statements[1], wantDDB) {
			t.Fatalf("statement[1] = %#v, want %#v", statements[1], wantDDB)
		}
	})
}

func TestCloudFormationPhase2DefaultHeaderFooterFlag(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "infra", "cloudformation.yaml"))
	if err != nil {
		t.Fatalf("read cloudformation.yaml: %v", err)
	}
	template := string(raw)

	if !strings.Contains(template, "DefaultDisplayHeaderFooter:") || !strings.Contains(template, "Default: 'false'") {
		t.Fatalf("expected DefaultDisplayHeaderFooter parameter defaulting to 'false'")
	}

	for _, fnName := range []string{"PdfFunction", "TrialPdfFunction", "BatchWorkerFunction"} {
		t.Run(fnName, func(t *testing.T) {
			block := extractCFNResourceBlock(t, template, fnName)
			if !strings.Contains(block, "DEFAULT_DISPLAY_HEADER_FOOTER: !Ref DefaultDisplayHeaderFooter") {
				t.Fatalf("%s missing DEFAULT_DISPLAY_HEADER_FOOTER env var:\n%s", fnName, block)
			}
		})
	}
}
