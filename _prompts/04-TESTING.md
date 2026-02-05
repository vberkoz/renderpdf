# MODULE 4: E2E TESTING - IDEMPOTENT
**Reference:** 03-DEPLOYMENT.md

**AI Context:** Bash test scripts, curl HTTP testing, PDF binary validation
**Focus:** Automated testing, clear pass/fail criteria, no manual steps

## Reasoning
Testing strategy must cover:
- **API functionality**: Request/response format validation
- **PDF quality**: File integrity, not corrupted
- **Error scenarios**: Invalid input, timeouts, failures
- **Performance**: Response times within acceptable limits
- **Edge cases**: Large HTML, complex CSS, special characters

Test prioritization:
1. **Smoke test**: Simple HTML → PDF (must pass for basic functionality)
2. **Complex HTML**: Real-world examples from doc-examples/
3. **Error handling**: Invalid JSON, malformed HTML
4. **Performance**: Measure and log response times
5. **Integration**: End-to-end flow including S3 download

Decision logic:
- If tests missing: Create comprehensive test suite
- If tests exist: Run and report results, update if API changed
- If tests fail: Identify root cause, don't mask failures
- Always: Validate PDF files are not corrupted (file signature check)

## State Detection
- Check if test scripts exist and are executable
- Verify API endpoint is accessible
- Test if sample HTML files exist in `doc-examples/`
- Validate previous test results

## Tasks (Conditional)
1. **If missing**: Create `test-api.sh` script that:
   - Reads API URL from CloudFormation outputs
   - Sends POST request with sample HTML
   - Validates response structure
   - Downloads PDF from returned URL
   - Verifies PDF is valid (file signature check)
   - Tests with multiple HTML samples from `doc-examples/`

2. **If missing**: Create `test-local.sh` for pre-deployment testing:
   - Uses SAM CLI or Go test to invoke Lambda locally
   - No AWS deployment required

3. **If exists**: Run tests and update only if failures detected

## Verification
```bash
./test-api.sh
./test-local.sh
```

## Success Criteria
- Tests pass for simple HTML (`<h1>Hello</h1>`)
- Tests pass for complex HTML (invoice.html, report.html)
- Downloaded PDFs are valid (not corrupted)
- Response times logged
- Output: "ALL TESTS PASSED ✓"
