# MODULE 4: E2E TESTING
**Reference:** 03-DEPLOYMENT.md

## Tasks
1. Create `test-api.sh` script that:
   - Reads API URL from CloudFormation outputs
   - Sends POST request with sample HTML
   - Validates response structure
   - Downloads PDF from returned URL
   - Verifies PDF is valid (file signature check)
   - Tests with multiple HTML samples from `doc-examples/`

2. Create `test-local.sh` for pre-deployment testing:
   - Uses SAM CLI or Go test to invoke Lambda locally
   - No AWS deployment required

## Verification
```bash
./test-api.sh
```
Output: "ALL TESTS PASSED ✓"

## Success Criteria
- Tests pass for simple HTML (`<h1>Hello</h1>`)
- Tests pass for complex HTML (invoice.html, report.html)
- Downloaded PDFs are valid (not corrupted)
- Response times logged
