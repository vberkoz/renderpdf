package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/dynamodb"
)

func TestBatchJobItemInitializesAtomicTransitionCounters(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	job := batchJobReply{JobID: "job_123", ItemCount: 3, QueuedCount: 3, CreatedAt: now, UpdatedAt: now}
	item := batchJobItem("account_123", job, `{"version":"1"}`)
	for field, want := range map[string]int{"itemCount": 3, "queuedCount": 3, "runningCount": 0, "succeededCount": 0, "failedCount": 0, "cancelledCount": 0} {
		if got := batchNumber(item, field, -1); got != want {
			t.Fatalf("%s = %d, want %d", field, got, want)
		}
	}
	if got := len(item); got == 0 || item["status"] == nil || *item["status"].S != "queued" {
		t.Fatalf("job item is not initialized as queued: %#v", item["status"])
	}
}

func TestDerivedBatchStatus(t *testing.T) {
	cases := []struct {
		name string
		job  batchJobReply
		want string
	}{
		{"queued", batchJobReply{ItemCount: 2, QueuedCount: 2}, "queued"},
		{"running", batchJobReply{ItemCount: 2, QueuedCount: 1, RunningCount: 1}, "running"},
		{"completed with failures", batchJobReply{ItemCount: 2, SucceededCount: 1, FailedCount: 1}, "completed"},
		{"retry exhaustion is terminal", batchJobReply{ItemCount: 1, FailedCount: 1}, "completed"},
		{"cancelling", batchJobReply{ItemCount: 2, RunningCount: 1, CancelRequested: true}, "cancelling"},
		{"cancelled", batchJobReply{ItemCount: 2, CancelledCount: 2, CancelRequested: true}, "cancelled"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := derivedBatchStatus(tc.job); got != tc.want {
				t.Fatalf("status = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBatchJobsAreSortedNewestFirst(t *testing.T) {
	jobs := []batchJobReply{
		{JobID: "job_old", CreatedAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)},
		{JobID: "job_new", CreatedAt: time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)},
	}
	sortBatchJobsNewestFirst(jobs)
	if got := jobs[0].JobID; got != "job_new" {
		t.Fatalf("first job = %q, want newest job_new", got)
	}
}

type fakeBatchWorkerDB struct {
	transactInputs []*dynamodb.TransactWriteItemsInput
	getItem        func(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error)
}

func (f *fakeBatchWorkerDB) TransactWriteItemsWithContext(_ aws.Context, input *dynamodb.TransactWriteItemsInput, _ ...request.Option) (*dynamodb.TransactWriteItemsOutput, error) {
	f.transactInputs = append(f.transactInputs, input)
	return &dynamodb.TransactWriteItemsOutput{}, nil
}

func (f *fakeBatchWorkerDB) TransactWriteItems(input *dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
	f.transactInputs = append(f.transactInputs, input)
	return &dynamodb.TransactWriteItemsOutput{}, nil
}

func (f *fakeBatchWorkerDB) GetItem(input *dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
	if f.getItem != nil {
		return f.getItem(input)
	}
	return &dynamodb.GetItemOutput{}, nil
}

func newTestBatchWorkerDB() *fakeBatchWorkerDB {
	return &fakeBatchWorkerDB{
		getItem: func(input *dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
			pk := aws.StringValue(input.Key["PK"].S)
			if pk == "JOB#job_123" {
				return &dynamodb.GetItemOutput{Item: map[string]*dynamodb.AttributeValue{
					"input": {S: aws.String(`{"definition":{"version":"1","source":{"type":"html","content":"<h1>Hi</h1>"}}}`)},
				}}, nil
			}
			return &dynamodb.GetItemOutput{Item: map[string]*dynamodb.AttributeValue{
				"request": {S: aws.String(`{"version":"1","items":[{"definition":{"version":"1","source":{"type":"html","content":"<h1>Hi</h1>"}}}]}`)},
			}}, nil
		},
	}
}

func TestCreateBatchRejectsExhaustedMonthlyQuota(t *testing.T) {
	previousClient, previousTable := ddbClient, tableName
	t.Cleanup(func() {
		ddbClient, tableName = previousClient, previousTable
	})
	t.Setenv("FREE_MONTHLY_QUOTA", "25")
	tableName = "renderpdf-usage"
	monthKey := "USER_QUOTA#customer-123#" + time.Now().UTC().Format("2006-01")
	ddbClient = &fakeDynamoDB{
		getItem: func(input *dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
			if aws.StringValue(input.Key["requestId"].S) == monthKey {
				return &dynamodb.GetItemOutput{Item: map[string]*dynamodb.AttributeValue{
					"used":  {N: aws.String("25")},
					"limit": {N: aws.String("25")},
				}}, nil
			}
			return &dynamodb.GetItemOutput{}, nil
		},
	}

	resp := createBatch(context.Background(), events.APIGatewayProxyRequest{
		HTTPMethod: http.MethodPost,
		Path:       batchResource,
		Body:       `{"version":"1","items":[{"definition":{"version":"1","source":{"type":"html","content":"<h1>Item</h1>"}}}]}`,
	}, "customer-123", map[string]string{"Content-Type": "application/json"}, nil)

	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429; body=%s", resp.StatusCode, resp.Body)
	}
	var errResp APIErrorResponse
	if err := json.Unmarshal([]byte(resp.Body), &errResp); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if errResp.Code != "rate_limited" || errResp.Error != "Monthly PDF quota reached" {
		t.Fatalf("unexpected error response: %#v", errResp)
	}
}

func TestProcessBatchItemQuotaExceededFailsTerminallyWithoutRender(t *testing.T) {
	previousClient, previousTable := ddbClient, tableName
	previousDBFactory, previousRenderer := batchWorkerDBFactory, batchItemRenderer
	t.Cleanup(func() {
		ddbClient, tableName = previousClient, previousTable
		batchWorkerDBFactory, batchItemRenderer = previousDBFactory, previousRenderer
	})

	t.Setenv("FREE_MONTHLY_QUOTA", "25")
	tableName = "renderpdf-usage"
	ddbClient = &fakeDynamoDB{
		updateErr: awserr.New(dynamodb.ErrCodeConditionalCheckFailedException, "quota exhausted", nil),
	}
	workerDB := newTestBatchWorkerDB()
	batchWorkerDBFactory = func() batchWorkerDB { return workerDB }
	renderCalls := 0
	batchItemRenderer = func(context.Context, string, normalizedRenderRequest) ([]byte, error) {
		renderCalls++
		return []byte("%PDF-1.4"), nil
	}

	err := processBatchItem(context.Background(), batchQueueMessage{
		OwnerID: "customer-123",
		JobID:   "job_123",
		Ordinal: 1,
	})
	if err != nil {
		t.Fatalf("processBatchItem returned err = %v, want nil so SQS deletes message", err)
	}
	if renderCalls != 0 {
		t.Fatalf("renderCalls = %d, want 0 when quota exceeded", renderCalls)
	}
	if len(workerDB.transactInputs) != 2 {
		t.Fatalf("transactInputs = %d, want 2 (claim + fail)", len(workerDB.transactInputs))
	}
	failUpdate := workerDB.transactInputs[1].TransactItems[0].Update
	if aws.StringValue(failUpdate.ExpressionAttributeValues[":status"].S) != "failed" {
		t.Fatalf("status = %q, want failed", aws.StringValue(failUpdate.ExpressionAttributeValues[":status"].S))
	}
	if aws.StringValue(failUpdate.ExpressionAttributeValues[":code"].S) != "monthly_quota_exceeded" {
		t.Fatalf("errorCode = %q, want monthly_quota_exceeded", aws.StringValue(failUpdate.ExpressionAttributeValues[":code"].S))
	}
}

func TestProcessBatchItemRefundsQuotaOnRenderFailure(t *testing.T) {
	cases := []struct {
		name      string
		renderErr error
		wantErr   bool
	}{
		{
			name:      "4xx validation error marks failed and refunds",
			renderErr: &renderError{Code: "template_invalid", Message: "bad", Status: 422},
			wantErr:   false,
		},
		{
			name:      "500 error returns err for retry and refunds",
			renderErr: errors.New("chrome crashed"),
			wantErr:   true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			previousClient, previousTable := ddbClient, tableName
			previousDBFactory, previousRenderer := batchWorkerDBFactory, batchItemRenderer
			t.Cleanup(func() {
				ddbClient, tableName = previousClient, previousTable
				batchWorkerDBFactory, batchItemRenderer = previousDBFactory, previousRenderer
			})

			t.Setenv("FREE_MONTHLY_QUOTA", "25")
			tableName = "renderpdf-usage"
			fakeDDB := &fakeDynamoDB{}
			ddbClient = fakeDDB
			workerDB := newTestBatchWorkerDB()
			batchWorkerDBFactory = func() batchWorkerDB { return workerDB }
			batchItemRenderer = func(context.Context, string, normalizedRenderRequest) ([]byte, error) {
				return nil, tc.renderErr
			}

			err := processBatchItem(context.Background(), batchQueueMessage{
				OwnerID: "customer-123",
				JobID:   "job_123",
				Ordinal: 1,
			})
			if tc.wantErr && err == nil {
				t.Fatal("expected error for retryable render failure")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(fakeDDB.updateInputs) != 2 {
				t.Fatalf("updateInputs = %d, want 2 (reserve + refund)", len(fakeDDB.updateInputs))
			}
			if got := aws.StringValue(fakeDDB.updateInputs[1].ExpressionAttributeValues[":minusOne"].N); got != "-1" {
				t.Fatalf("refund delta = %q, want -1", got)
			}
		})
	}
}

func TestProcessBatchItemRetriesOnTransientQuotaError(t *testing.T) {
	previousClient, previousTable := ddbClient, tableName
	previousDBFactory, previousRenderer := batchWorkerDBFactory, batchItemRenderer
	t.Cleanup(func() {
		ddbClient, tableName = previousClient, previousTable
		batchWorkerDBFactory, batchItemRenderer = previousDBFactory, previousRenderer
	})

	tableName = "renderpdf-usage"
	transientErr := errors.New("dynamodb throttled")
	ddbClient = &fakeDynamoDB{
		getItem: func(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
			return nil, transientErr
		},
	}
	workerDB := newTestBatchWorkerDB()
	batchWorkerDBFactory = func() batchWorkerDB { return workerDB }
	renderCalls := 0
	batchItemRenderer = func(context.Context, string, normalizedRenderRequest) ([]byte, error) {
		renderCalls++
		return []byte("%PDF-1.4"), nil
	}

	err := processBatchItem(context.Background(), batchQueueMessage{
		OwnerID: "customer-123",
		JobID:   "job_123",
		Ordinal: 1,
	})
	if !errors.Is(err, transientErr) {
		t.Fatalf("err = %v, want wrapped %v", err, transientErr)
	}
	if renderCalls != 0 {
		t.Fatalf("renderCalls = %d, want 0 on transient quota error", renderCalls)
	}
	if len(workerDB.transactInputs) != 1 {
		t.Fatalf("transactInputs = %d, want 1 (claim only, not failed)", len(workerDB.transactInputs))
	}
}

func TestRenderBatchNormalizedSourcePropagatesOptions(t *testing.T) {
	prevHTMLRenderer := batchHTMLPDFRenderer
	prevDocRenderer := batchDocPDFRenderer
	prevURLRenderer := batchURLPDFRenderer
	prevPkgPreparer := batchPackagePreparer
	prevTplFactory := templateStoreFactory
	t.Cleanup(func() {
		batchHTMLPDFRenderer = prevHTMLRenderer
		batchDocPDFRenderer = prevDocRenderer
		batchURLPDFRenderer = prevURLRenderer
		batchPackagePreparer = prevPkgPreparer
		templateStoreFactory = prevTplFactory
	})

	store := &memoryTemplateAPIStore{
		templates: map[string]Template{
			"customer-a/tpl-1": {
				ID:      "tpl-1",
				Name:    "Batch Invoice",
				Type:    TemplateType("invoice"),
				HTML:    "<p>Secret: {{secret}}</p>",
				OwnerID: "customer-a",
			},
		},
	}
	templateStoreFactory = func() templateStore { return store }

	var gotHTML string
	var gotHTMLOpts documentRenderOptions
	var gotDocOpts documentRenderOptions
	var gotURL string
	var gotURLOpts documentRenderOptions

	batchHTMLPDFRenderer = func(_ context.Context, html string, opts documentRenderOptions) ([]byte, error) {
		gotHTML = html
		gotHTMLOpts = opts
		return []byte("%PDF-html"), nil
	}
	batchDocPDFRenderer = func(_ context.Context, _ string, opts documentRenderOptions) ([]byte, error) {
		gotDocOpts = opts
		return []byte("%PDF-doc"), nil
	}
	batchURLPDFRenderer = func(_ context.Context, targetURL string, opts documentRenderOptions) ([]byte, error) {
		gotURL = targetURL
		gotURLOpts = opts
		return []byte("%PDF-url"), nil
	}
	batchPackagePreparer = func(_ context.Context, _, uploadID, entrypoint string) (string, int64, func(), error) {
		return "file:///tmp/renderpdf-package-test/" + uploadID + "/" + entrypoint, 128, func() {}, nil
	}

	optsJSON := `"options":{"format":"Letter","margin":"12mm","landscape":true,"displayHeaderFooter":false,"redaction":{"enabled":true,"types":["email"]}}`

	// 1. renderKindHTML
	normHTML, err := normalizeCanonicalRenderRequestWithOwner(context.Background(), `{"version":"1","source":{"type":"html","content":"<p>test@example.com</p>"},`+optsJSON+`}`, "customer-a")
	if err != nil || normHTML.Kind != renderKindHTML {
		t.Fatalf("normalize html = %#v, err = %v", normHTML, err)
	}
	if _, err := renderBatchNormalizedSource(context.Background(), "customer-a", normHTML); err != nil {
		t.Fatalf("renderBatchNormalizedSource(html) err = %v", err)
	}
	if gotHTMLOpts.Format != "Letter" || gotHTMLOpts.Margin != "12mm" || !gotHTMLOpts.isLandscape() || gotHTMLOpts.DisplayHeaderFooter == nil || *gotHTMLOpts.DisplayHeaderFooter != false {
		t.Fatalf("html options lost: %#v", gotHTMLOpts)
	}
	if strings.Contains(gotHTML, "test@example.com") {
		t.Fatalf("expected redaction applied to batch html: %s", gotHTML)
	}

	// 2. renderKindDocument
	normDoc, err := normalizeCanonicalRenderRequestWithOwner(context.Background(), `{"version":"1","source":{"type":"markdown","content":"# Hello"},"data":{},`+optsJSON+`}`, "customer-a")
	if err != nil || normDoc.Kind != renderKindDocument {
		t.Fatalf("normalize doc = %#v, err = %v", normDoc, err)
	}
	if _, err := renderBatchNormalizedSource(context.Background(), "customer-a", normDoc); err != nil {
		t.Fatalf("renderBatchNormalizedSource(doc) err = %v", err)
	}
	if gotDocOpts.Format != "Letter" || gotDocOpts.Margin != "12mm" || !gotDocOpts.isLandscape() || gotDocOpts.DisplayHeaderFooter == nil || *gotDocOpts.DisplayHeaderFooter != false {
		t.Fatalf("doc options lost: %#v", gotDocOpts)
	}

	// 3. renderKindTemplate
	gotHTML, gotHTMLOpts = "", documentRenderOptions{}
	normTpl, err := normalizeCanonicalRenderRequestWithOwner(context.Background(), `{"version":"1","source":{"type":"template","templateId":"tpl-1","variables":{"secret":"ada@example.com"}},`+optsJSON+`}`, "customer-a")
	if err != nil || normTpl.Kind != renderKindTemplate {
		t.Fatalf("normalize template = %#v, err = %v", normTpl, err)
	}
	if _, err := renderBatchNormalizedSource(context.Background(), "customer-a", normTpl); err != nil {
		t.Fatalf("renderBatchNormalizedSource(template) err = %v", err)
	}
	if gotHTMLOpts.Format != "Letter" || gotHTMLOpts.Margin != "12mm" || !gotHTMLOpts.isLandscape() || gotHTMLOpts.DisplayHeaderFooter == nil || *gotHTMLOpts.DisplayHeaderFooter != false {
		t.Fatalf("template options lost: %#v", gotHTMLOpts)
	}
	if strings.Contains(gotHTML, "ada@example.com") {
		t.Fatalf("expected redaction applied to batch template: %s", gotHTML)
	}

	// 4. renderKindURL
	gotURL, gotURLOpts = "", documentRenderOptions{}
	normURL, err := normalizeCanonicalRenderRequestWithOwner(context.Background(), `{"version":"1","source":{"type":"url","url":"https://93.184.216.34/doc.html"},`+optsJSON+`}`, "customer-a")
	if err != nil || normURL.Kind != renderKindURL {
		t.Fatalf("normalize url = %#v, err = %v", normURL, err)
	}
	if _, err := renderBatchNormalizedSource(context.Background(), "customer-a", normURL); err != nil {
		t.Fatalf("renderBatchNormalizedSource(url) err = %v", err)
	}
	if gotURL != "https://93.184.216.34/doc.html" || gotURLOpts.Format != "Letter" || gotURLOpts.Margin != "12mm" || !gotURLOpts.isLandscape() || gotURLOpts.DisplayHeaderFooter == nil || *gotURLOpts.DisplayHeaderFooter != false {
		t.Fatalf("url propagation failed: url=%q opts=%#v", gotURL, gotURLOpts)
	}

	// 5. renderKindUpload
	gotURL, gotURLOpts = "", documentRenderOptions{}
	normUpload, err := normalizeCanonicalRenderRequestWithOwner(context.Background(), `{"version":"1","source":{"type":"upload","uploadId":"0f8fad5b-d9cb-469f-a165-70867728950e","entrypoint":"index.html"},`+optsJSON+`}`, "customer-a")
	if err != nil || normUpload.Kind != renderKindUpload {
		t.Fatalf("normalize upload = %#v, err = %v", normUpload, err)
	}
	if _, err := renderBatchNormalizedSource(context.Background(), "customer-a", normUpload); err != nil {
		t.Fatalf("renderBatchNormalizedSource(upload) err = %v", err)
	}
	if !strings.Contains(gotURL, "index.html") || gotURLOpts.Format != "Letter" || gotURLOpts.Margin != "12mm" || !gotURLOpts.isLandscape() || gotURLOpts.DisplayHeaderFooter == nil || *gotURLOpts.DisplayHeaderFooter != false {
		t.Fatalf("upload propagation failed: url=%q opts=%#v", gotURL, gotURLOpts)
	}

	// 6. Validation errors return 422 renderError across html/url/upload/template
	for _, bad := range []normalizedRenderRequest{
		{Kind: renderKindHTML, Body: `{"html":"<p>Hi</p>","options":{"format":"Invalid"}}`},
		{Kind: renderKindURL, Body: `{"url":"https://93.184.216.34/doc.html","options":{"margin":"99mm"}}`},
		{Kind: renderKindUpload, Body: `{"uploadId":"0f8fad5b-d9cb-469f-a165-70867728950e","options":{"format":"Invalid"}}`},
		{Kind: renderKindTemplate, Body: `{"templateId":"tpl-1","variables":{"secret":"x"},"options":{"margin":"99mm"}}`},
	} {
		_, err := renderBatchNormalizedSource(context.Background(), "customer-a", bad)
		var rErr *renderError
		if !errors.As(err, &rErr) || rErr.Status != 422 {
			t.Fatalf("expected 422 renderError for %s, got %#v", bad.Kind, err)
		}
	}
}
