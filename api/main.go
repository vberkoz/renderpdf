package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/andybalholm/brotli"
	"golang.org/x/net/html"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
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

type requestAnalytics struct {
	RequestID  string
	Plan       string
	Status     string
	ErrorType  string
	HTMLBytes  int64
	PDFBytes   int64
	DurationMs int64
	RenderMs   int64
	Country    string
	CustomerID string
	APIKeyID   string
}

type dynamoDBAPI interface {
	GetItem(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error)
	PutItem(*dynamodb.PutItemInput) (*dynamodb.PutItemOutput, error)
	UpdateItem(*dynamodb.UpdateItemInput) (*dynamodb.UpdateItemOutput, error)
}

var (
	bucketName                  = os.Getenv("BUCKET_NAME")
	tableName                   = os.Getenv("TABLE_NAME")
	sess                        = session.Must(session.NewSession())
	s3Client                    = s3.New(sess)
	ddbClient       dynamoDBAPI = dynamodb.New(sess)
	chromeSetupOnce sync.Once
	chromeSetupErr  error
)

func handler(ctx context.Context, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	corsHeaders := map[string]string{
		"Content-Type":                  "application/json",
		"Access-Control-Allow-Origin":   "*",
		"Access-Control-Allow-Headers":  "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
		"Access-Control-Allow-Methods":  "GET,POST,OPTIONS",
		"Access-Control-Expose-Headers": "X-Trial-Limit,X-Trial-Remaining",
	}
	if isTrialQuotaRequest(request) {
		quota, err := currentTrialQuota(trialViewerIP(request), time.Now().UTC())
		if err != nil {
			fmt.Printf("Trial quota lookup failed: %v\n", err)
			return errorResponse(503, "Trial quota is temporarily unavailable", corsHeaders), nil
		}
		corsHeaders["X-Trial-Limit"] = fmt.Sprintf("%d", quota.Limit)
		corsHeaders["X-Trial-Remaining"] = fmt.Sprintf("%d", quota.Remaining)
		body, _ := json.Marshal(map[string]int{"limit": quota.Limit, "remaining": quota.Remaining})
		return events.APIGatewayProxyResponse{StatusCode: 200, Body: string(body), Headers: corsHeaders}, nil
	}
	isTrial := isTrialRequest(request)
	plan := "api"
	if isTrial {
		plan = "trial"
	}
	requestID := uuid.New().String()
	startedAt := time.Now()
	analytics := requestAnalytics{
		RequestID:  requestID,
		Plan:       plan,
		Status:     "error",
		ErrorType:  "unknown",
		HTMLBytes:  int64(len(request.Body)),
		Country:    requestCountry(request),
		CustomerID: authorizerValue(request, "userId"),
		APIKeyID:   authorizerValue(request, "apiKeyId"),
	}
	defer func() {
		analytics.DurationMs = maxInt64(1, time.Since(startedAt).Milliseconds())
		trackUsage(ctx, analytics)
	}()

	if trialModeOnly() && !isTrial {
		analytics.ErrorType = "not_found"
		return errorResponse(404, "Not found", corsHeaders), nil
	}
	if isTrial && len(request.Body) > (2*trialMaxHTMLBytes())+64*1024 {
		analytics.ErrorType = "validation"
		return errorResponse(413, "HTML exceeds the trial size limit", corsHeaders), nil
	}

	var req Request
	if err := json.Unmarshal([]byte(request.Body), &req); err != nil {
		analytics.ErrorType = "validation"
		return errorResponse(400, "Invalid request", corsHeaders), nil
	}
	if strings.TrimSpace(req.HTML) == "" {
		analytics.ErrorType = "validation"
		return errorResponse(400, "HTML is required", corsHeaders), nil
	}
	if isTrial && len(req.HTML) > trialMaxHTMLBytes() {
		analytics.ErrorType = "validation"
		return errorResponse(413, "HTML exceeds the trial size limit", corsHeaders), nil
	}
	analytics.HTMLBytes = int64(len(req.HTML))
	var quota *trialQuota
	if isTrial {
		slot, err := acquireTrialSlot(requestID, time.Now().UTC())
		if err != nil {
			if err == errTrialCapacityReached {
				analytics.ErrorType = "capacity"
				corsHeaders["Retry-After"] = "10"
				return errorResponse(503, "Trial capacity is busy; try again shortly", corsHeaders), nil
			}
			analytics.ErrorType = "quota"
			fmt.Printf("Trial capacity error: %v\n", err)
			return errorResponse(503, "Trial service temporarily unavailable", corsHeaders), nil
		}
		defer releaseTrialSlot(slot)

		quota, err = consumeTrialQuota(trialViewerIP(request), time.Now().UTC())
		if err != nil {
			if err == errTrialLimitExceeded {
				analytics.ErrorType = "rate_limit"
				corsHeaders["X-Trial-Limit"] = fmt.Sprintf("%d", trialDailyLimit())
				corsHeaders["X-Trial-Remaining"] = "0"
				return errorResponse(429, "Daily trial limit reached", corsHeaders), nil
			}
			analytics.ErrorType = "quota"
			fmt.Printf("Trial quota error: %v\n", err)
			return errorResponse(503, "Trial service temporarily unavailable", corsHeaders), nil
		}
		corsHeaders["X-Trial-Limit"] = fmt.Sprintf("%d", quota.Limit)
		corsHeaders["X-Trial-Remaining"] = fmt.Sprintf("%d", quota.Remaining)
	}

	html := injectPrintCSS(req.HTML)
	html = ensureColgroup(html)
	html = rewriteTfoot(html)
	renderStartedAt := time.Now()
	pdfBytes, err := generatePDF(ctx, html)
	analytics.RenderMs = maxInt64(1, time.Since(renderStartedAt).Milliseconds())
	if err != nil {
		fmt.Printf("PDF generation failed: %v\n", err)
		if errors.Is(err, context.DeadlineExceeded) {
			analytics.Status = "timeout"
			analytics.ErrorType = "render_timeout"
		} else {
			analytics.ErrorType = "render"
		}
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
		analytics.ErrorType = "storage"
		refundTrialQuota(quota)
		restoreTrialRemainingHeader(quota, corsHeaders)
		return errorResponse(500, err.Error(), corsHeaders), nil
	}

	url := fmt.Sprintf("https://%s.s3.amazonaws.com/%s", bucketName, key)
	analytics.Status = "success"
	analytics.ErrorType = ""
	analytics.PDFBytes = int64(len(pdfBytes))

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
	if !ok {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func generatePDF(ctx context.Context, html string) ([]byte, error) {
	// Use one deadline for the browser's entire lifetime. A launch-only child
	// context becomes Chrome's owner inside chromedp; when that shorter context
	// expires it kills an otherwise healthy browser during PDF rendering.
	generationCtx, generationCancel := context.WithTimeout(ctx, 24*time.Second)
	defer generationCancel()

	chromePath, err := prepareChrome()
	if err != nil {
		return nil, err
	}
	fmt.Printf("Using Chrome at: %s\n", chromePath)

	os.RemoveAll("/tmp/chrome-data")
	os.MkdirAll("/tmp/chrome-data", 0755)

	var browserOutput bytes.Buffer
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chromePath),
		chromedp.CombinedOutput(&browserOutput),
		// Chrome can spend most of ten seconds faulting the browser image into
		// memory during a Lambda cold start before it prints the DevTools URL.
		// Keep this below API Gateway's synchronous timeout, but leave enough
		// headroom for the first invocation of a fresh execution environment.
		chromedp.WSURLReadTimeout(18*time.Second),
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-setuid-sandbox", true),
		// Lambda's Firecracker runtime requires Chrome to avoid spawning the
		// usual browser process tree. Disable proxy resolution as well: Chrome's
		// V8 proxy resolver is not supported in single-process mode and can block
		// startup before the DevTools endpoint is published.
		chromedp.Flag("no-zygote", true),
		chromedp.Flag("single-process", true),
		chromedp.Flag("no-proxy-server", true),
		chromedp.Flag("proxy-bypass-list", "*"),
		chromedp.UserDataDir("/tmp/chrome-data"),
		chromedp.WindowSize(1920, 1080),
	)

	fmt.Println("Creating Chrome allocator...")
	allocCtx, allocCancel := chromedp.NewExecAllocator(generationCtx, opts...)
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
	if err := chromedp.Run(taskCtx); err != nil {
		return nil, fmt.Errorf("failed to start browser: %v: %s", err, browserOutput.String())
	}
	fmt.Println("Browser started successfully")

	var buf []byte
	escaped := url.PathEscape(html)

	fmt.Println("Running chromedp...")
	err = chromedp.Run(taskCtx,
		// Issue navigation without waiting for every remote asset to finish.
		// A document may contain an external image or stylesheet that is slow
		// or unreachable from Lambda; that must not consume the API Gateway
		// timeout before we can print the rest of the HTML.
		chromedp.ActionFunc(func(ctx context.Context) error {
			_, _, errorText, _, err := page.Navigate("data:text/html;charset=utf-8," + escaped).Do(ctx)
			if err != nil {
				return err
			}
			if errorText != "" {
				return fmt.Errorf("page navigation failed: %s", errorText)
			}
			return nil
		}),
		chromedp.WaitReady("body"),
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
		// Give fast local/remote assets a chance to render, but keep the
		// request bounded when a remote resource never responds.
		chromedp.Sleep(1*time.Second),
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

func prepareChrome() (string, error) {
	const (
		bundleRoot = "/opt/chromium"
		chromePath = "/tmp/chromium"
	)

	chromeSetupOnce.Do(func() {
		startedAt := time.Now()
		if err := inflateBrotliFile(filepath.Join(bundleRoot, "chromium.br"), chromePath, 0700); err != nil {
			chromeSetupErr = err
			return
		}
		if err := extractBrotliTar(filepath.Join(bundleRoot, "fonts.tar.br"), "/tmp/fonts"); err != nil {
			chromeSetupErr = err
			return
		}
		if err := extractBrotliTar(filepath.Join(bundleRoot, "al2023.tar.br"), "/tmp/al2023"); err != nil {
			chromeSetupErr = err
			return
		}
		if err := extractBrotliTar(filepath.Join(bundleRoot, "swiftshader.tar.br"), "/tmp"); err != nil {
			chromeSetupErr = err
			return
		}
		os.Setenv("FONTCONFIG_PATH", "/tmp/fonts")
		os.Setenv("LD_LIBRARY_PATH", "/tmp:/tmp/al2023/lib:"+os.Getenv("LD_LIBRARY_PATH"))

		fmt.Printf("Chrome extraction completed in %s\n", time.Since(startedAt))
	})

	if chromeSetupErr != nil {
		return "", fmt.Errorf("prepare Chrome: %w", chromeSetupErr)
	}
	return chromePath, nil
}

func inflateBrotliFile(sourcePath, targetPath string, mode os.FileMode) error {
	input, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open %s: %w", sourcePath, err)
	}
	defer input.Close()

	output, err := os.OpenFile(targetPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return fmt.Errorf("create %s: %w", targetPath, err)
	}
	_, copyErr := io.Copy(output, brotli.NewReader(input))
	closeErr := output.Close()
	if copyErr != nil {
		return fmt.Errorf("decompress %s: %w", sourcePath, copyErr)
	}
	return closeErr
}

func extractBrotliTar(sourcePath, targetRoot string) error {
	input, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open %s: %w", sourcePath, err)
	}
	defer input.Close()
	if err := os.MkdirAll(targetRoot, 0755); err != nil {
		return err
	}

	archive := tar.NewReader(brotli.NewReader(input))
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", sourcePath, err)
		}
		target := filepath.Join(targetRoot, header.Name)
		if !strings.HasPrefix(target, targetRoot+string(os.PathSeparator)) {
			return fmt.Errorf("invalid archive path %q", header.Name)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, os.FileMode(header.Mode)); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			output, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode))
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(output, archive)
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		}
	}
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

func main() {
	lambda.Start(handler)
}
