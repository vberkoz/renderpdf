# MODULE 2: LAMBDA FUNCTION (Go)
**Reference:** 01-INFRASTRUCTURE.md

## Tasks
1. Implement `api/main.go` with:
   - Lambda handler for API Gateway proxy events
   - Parse JSON body: `{ "html": "..." }`
   - Generate PDF using chromedp
   - Upload to S3 with UUID filename
   - Save metadata to DynamoDB
   - Return: `{ "requestId": "uuid", "url": "s3-url", "size": bytes }`
2. Handle errors gracefully with proper HTTP status codes

## Local Testing
Create `api/test_local.go`:
```go
// Standalone test that generates PDF from sample HTML
// Saves to local file instead of S3
// Prints "PDF GENERATION TEST PASSED" on success
```

## Verification
```bash
cd api
go test -v
```

## Success Criteria
- PDF generated from `<h1>Test</h1>` is valid
- File size > 0 bytes
- No panics or crashes
