# MODULE 2: LAMBDA FUNCTION (Go) - IDEMPOTENT
**Reference:** 01-INFRASTRUCTURE.md

**AI Context:** Go 1.21+ syntax, chromedp headless browser automation, AWS Lambda runtime
**Focus:** Production-ready error handling, memory optimization for Lambda

## Reasoning
Lambda function challenges:
- **Cold starts**: chromedp initialization takes time → pre-warm browser context
- **Memory usage**: PDF generation is memory-intensive → optimize for 512MB-1GB
- **Timeouts**: Complex HTML can take time → implement proper timeouts
- **Concurrency**: Multiple requests → stateless design, no global state

Implementation strategy:
- If code missing: Create full implementation with error handling
- If exists but broken: Fix specific issues, preserve working parts
- If outdated: Update dependencies, improve performance
- Always: Test with sample HTML to verify PDF generation

Error handling priorities:
1. Invalid HTML → 400 with clear message
2. PDF generation failure → 500 with retry suggestion
3. S3 upload failure → 503 with temporary error
4. Timeout → 504 with size limit guidance

## State Detection
- Check if `api/main.go` exists and compiles
- Verify Go modules are initialized
- Test if chromedp dependencies work
- Validate existing function logic

## Tasks (Conditional)
1. **If missing**: Create `api/main.go` with:
   - Lambda handler for API Gateway proxy events
   - Parse JSON body: `{ "html": "..." }`
   - Generate PDF using chromedp
   - Upload to S3 with UUID filename
   - Save metadata to DynamoDB
   - Return: `{ "requestId": "uuid", "url": "s3-url", "size": bytes }`
2. **If exists**: Update only broken/missing functionality
3. **Always**: Handle errors gracefully with proper HTTP status codes

## Local Testing (Conditional)
**If missing**: Create `api/test_local.go`:
```go
// Standalone test that generates PDF from sample HTML
// Saves to local file instead of S3
// Prints "PDF GENERATION TEST PASSED" on success
```

## Verification
```bash
cd api && go mod tidy && go test -v
```

## Success Criteria
- Code compiles without errors
- PDF generated from `<h1>Test</h1>` is valid
- File size > 0 bytes
- No panics or crashes
