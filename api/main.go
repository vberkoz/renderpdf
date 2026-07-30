package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
	"github.com/google/uuid"
)

type Request struct {
	HTML string `json:"html"`
}

type Response struct {
	RequestID string `json:"requestId"`
	URL       string `json:"url"`
	Size      int64  `json:"size"`
}

type dynamoDBAPI interface {
	GetItem(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error)
	PutItem(*dynamodb.PutItemInput) (*dynamodb.PutItemOutput, error)
	UpdateItem(*dynamodb.UpdateItemInput) (*dynamodb.UpdateItemOutput, error)
}

var (
	bucketName             = os.Getenv("BUCKET_NAME")
	tableName              = os.Getenv("TABLE_NAME")
	sess                   = session.Must(session.NewSession())
	s3Client               = s3.New(sess)
	ddbClient  dynamoDBAPI = dynamodb.New(sess)
)

func handler(ctx context.Context, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	corsHeaders := map[string]string{
		"Content-Type":                  "application/json",
		"Access-Control-Allow-Origin":   "*",
		"Access-Control-Allow-Headers":  "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
		"Access-Control-Allow-Methods":  "POST,OPTIONS",
		"Access-Control-Expose-Headers": "X-Trial-Limit,X-Trial-Remaining",
	}
	isTrial := isTrialRequest(request)
	if trialModeOnly() && !isTrial {
		return errorResponse(404, "Not found", corsHeaders), nil
	}
	if isTrial && len(request.Body) > (2*trialMaxHTMLBytes())+64*1024 {
		return errorResponse(413, "HTML exceeds the trial size limit", corsHeaders), nil
	}

	var req Request
	if err := json.Unmarshal([]byte(request.Body), &req); err != nil {
		return errorResponse(400, "Invalid request", corsHeaders), nil
	}
	if strings.TrimSpace(req.HTML) == "" {
		return errorResponse(400, "HTML is required", corsHeaders), nil
	}
	if isTrial && len(req.HTML) > trialMaxHTMLBytes() {
		return errorResponse(413, "HTML exceeds the trial size limit", corsHeaders), nil
	}

	requestID := uuid.New().String()
	var quota *trialQuota
	if isTrial {
		slot, err := acquireTrialSlot(requestID, time.Now().UTC())
		if err != nil {
			if err == errTrialCapacityReached {
				corsHeaders["Retry-After"] = "10"
				return errorResponse(503, "Trial capacity is busy; try again shortly", corsHeaders), nil
			}
			fmt.Printf("Trial capacity error: %v\n", err)
			return errorResponse(503, "Trial service temporarily unavailable", corsHeaders), nil
		}
		defer releaseTrialSlot(slot)

		quota, err = consumeTrialQuota(trialViewerIP(request), time.Now().UTC())
		if err != nil {
			if err == errTrialLimitExceeded {
				corsHeaders["X-Trial-Limit"] = fmt.Sprintf("%d", trialDailyLimit())
				corsHeaders["X-Trial-Remaining"] = "0"
				return errorResponse(429, "Daily trial limit reached", corsHeaders), nil
			}
			fmt.Printf("Trial quota error: %v\n", err)
			return errorResponse(503, "Trial service temporarily unavailable", corsHeaders), nil
		}
		corsHeaders["X-Trial-Limit"] = fmt.Sprintf("%d", quota.Limit)
		corsHeaders["X-Trial-Remaining"] = fmt.Sprintf("%d", quota.Remaining)
	}

	html := injectPrintCSS(req.HTML)
	html = ensureColgroup(html)
	html = rewriteTfoot(html)
	pdfBytes, err := generatePDF(ctx, html)
	if err != nil {
		refundTrialQuota(quota)
		restoreTrialRemainingHeader(quota, corsHeaders)
		return errorResponse(500, err.Error(), corsHeaders), nil
	}

	key := fmt.Sprintf("%s.pdf", requestID)
	_, err = s3Client.PutObject(&s3.PutObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(key),
		Body:   bytes.NewReader(pdfBytes),
	})
	if err != nil {
		refundTrialQuota(quota)
		restoreTrialRemainingHeader(quota, corsHeaders)
		return errorResponse(500, err.Error(), corsHeaders), nil
	}

	url := fmt.Sprintf("https://%s.s3.amazonaws.com/%s", bucketName, key)
	plan := "api"
	if isTrial {
		plan = "trial"
	}
	trackUsage(requestID, int64(len(pdfBytes)), plan)

	resp := Response{RequestID: requestID, URL: url, Size: int64(len(pdfBytes))}
	body, _ := json.Marshal(resp)

	return events.APIGatewayProxyResponse{
		StatusCode: 200,
		Body:       string(body),
		Headers:    corsHeaders,
	}, nil
}

func errorResponse(status int, message string, headers map[string]string) events.APIGatewayProxyResponse {
	body, _ := json.Marshal(map[string]string{"error": message})
	return events.APIGatewayProxyResponse{StatusCode: status, Body: string(body), Headers: headers}
}

func restoreTrialRemainingHeader(quota *trialQuota, headers map[string]string) {
	if quota != nil {
		headers["X-Trial-Remaining"] = fmt.Sprintf("%d", min(quota.Limit, quota.Remaining+1))
	}
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

func generatePDF(ctx context.Context, html string) ([]byte, error) {
	chromePath := "/opt/chrome-headless-shell-linux64/chrome-headless-shell"
	if _, err := os.Stat(chromePath); os.IsNotExist(err) {
		chromePath = "/opt/google/chrome/chrome"
		if _, err := os.Stat(chromePath); os.IsNotExist(err) {
			return nil, fmt.Errorf("chrome binary not found")
		}
	}
	fmt.Printf("Using Chrome at: %s\n", chromePath)
	os.Setenv("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/dev/null")
	os.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/dev/null")

	os.RemoveAll("/tmp/chrome-data")
	os.MkdirAll("/tmp/chrome-data", 0755)

	var browserOutput bytes.Buffer
	opts := []chromedp.ExecAllocatorOption{
		chromedp.ExecPath(chromePath),
		chromedp.CombinedOutput(&browserOutput),
		chromedp.WSURLReadTimeout(30 * time.Second),
		chromedp.NoSandbox,
		chromedp.NoFirstRun,
		chromedp.NoDefaultBrowserCheck,
		chromedp.Headless,
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-setuid-sandbox", true),
		chromedp.Flag("no-zygote", true),
		chromedp.Flag("single-process", true),
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("disable-background-networking", true),
		chromedp.Flag("disable-default-apps", true),
		chromedp.Flag("disable-sync", true),
		chromedp.Flag("disable-translate", true),
		chromedp.Flag("hide-scrollbars", true),
		chromedp.Flag("mute-audio", true),
		chromedp.Flag("no-first-run", true),
		chromedp.Flag("safebrowsing-disable-auto-update", true),
		chromedp.UserDataDir("/tmp/chrome-data"),
		chromedp.WindowSize(1920, 1080),
	}

	fmt.Println("Creating Chrome allocator...")
	allocCtx, allocCancel := chromedp.NewExecAllocator(ctx, opts...)
	defer allocCancel()

	fmt.Println("Creating Chrome context...")
	taskCtx, taskCancel := chromedp.NewContext(
		allocCtx,
		chromedp.WithLogf(func(format string, args ...interface{}) {
			fmt.Printf("chromedp: "+format+"\n", args...)
		}),
		chromedp.WithErrorf(func(format string, args ...interface{}) {
			fmt.Printf("chromedp ERROR: "+format+"\n", args...)
		}),
	)
	defer taskCancel()

	fmt.Println("Starting browser...")
	// Start the browser first with a timeout
	startCtx, startCancel := context.WithTimeout(taskCtx, 35*time.Second)
	defer startCancel()

	if err := chromedp.Run(startCtx); err != nil {
		return nil, fmt.Errorf("failed to start browser: %v: %s", err, browserOutput.String())
	}
	fmt.Println("Browser started successfully")

	timeoutCtx, timeoutCancel := context.WithTimeout(taskCtx, 40*time.Second)
	defer timeoutCancel()

	var buf []byte
	escaped := url.PathEscape(html)

	fmt.Println("Running chromedp...")
	err := chromedp.Run(timeoutCtx,
		chromedp.Navigate("data:text/html;charset=utf-8,"+escaped),
		chromedp.ActionFunc(func(ctx context.Context) error {
			return emulation.SetDeviceMetricsOverride(
				1920,
				1080,
				1,
				false,
			).WithScreenOrientation(
				&emulation.ScreenOrientation{
					Type:  emulation.OrientationTypePortraitPrimary,
					Angle: 0,
				},
			).Do(ctx)
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			return emulation.SetEmulatedMedia().WithMedia("print").Do(ctx)
		}),
		chromedp.Evaluate(`document.body.offsetHeight`, nil),
		chromedp.Sleep(300*time.Millisecond),
		chromedp.ActionFunc(func(ctx context.Context) error {
			var err error
			buf, _, err = page.PrintToPDF().
				WithPrintBackground(true).
				WithPreferCSSPageSize(true).
				WithScale(1).
				WithDisplayHeaderFooter(true).
				WithHeaderTemplate(`<div style="font-size:10px;width:100%;padding:0 0.5cm;display:flex;justify-content:space-between;"><span class="title"></span><span class="date"></span></div>`).
				WithFooterTemplate(`<div style="font-size:10px;width:100%;padding:0 0.5cm;display:flex;justify-content:space-between;"><span>Generated by RenderPDF</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`).
				WithMarginTop(0.5).
				WithMarginBottom(0.5).
				WithMarginLeft(0).
				WithMarginRight(0).
				Do(ctx)
			return err
		}),
	)

	return buf, err
}

func rewriteTfoot(htmlStr string) string {
	doc, err := html.Parse(strings.NewReader(htmlStr))
	if err != nil {
		return htmlStr
	}

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "tfoot" {
			n.Data = "tbody"
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	var buf bytes.Buffer
	html.Render(&buf, doc)
	return buf.String()
}

func ensureColgroup(html string) string {
	re := regexp.MustCompile(`(?i)<table([^>]*)>`)
	return re.ReplaceAllStringFunc(html, func(m string) string {
		if strings.Contains(strings.ToLower(html[strings.Index(html, m):]), "<colgroup") {
			return m
		}
		return m + `<colgroup><col style="width:40%"><col style="width:20%"><col style="width:20%"><col style="width:20%"></colgroup>`
	})
}

func injectPrintCSS(html string) string {
	if strings.Contains(html, "__RENDERPDF_INJECTED__") {
		return html
	}

	const css = `<!-- __RENDERPDF_INJECTED__ -->
<style id="__lambda_print_fix__">
@media print {
  * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    forced-color-adjust: none !important;
  }
  table {
    table-layout: fixed !important;
    width: 100% !important;
  }
  tfoot {
    display: table-row-group !important;
  }
  tr {
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
}
</style>
`

	if strings.Contains(html, "</head>") {
		return strings.Replace(html, "</head>", css+"</head>", 1)
	}

	return css + html
}

func trackUsage(requestID string, size int64, plan string) {
	ddbClient.PutItem(&dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item: map[string]*dynamodb.AttributeValue{
			"requestId":  {S: aws.String(requestID)},
			"timestamp":  {N: aws.String(fmt.Sprintf("%d", time.Now().Unix()))},
			"size":       {N: aws.String(fmt.Sprintf("%d", size))},
			"entityType": {S: aws.String("PDF_REQUEST")},
			"plan":       {S: aws.String(plan)},
		},
	})
}

func main() {
	lambda.Start(handler)
}
