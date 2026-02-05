# MODULE 3: DEPLOYMENT AUTOMATION
**Reference:** 02-LAMBDA-FUNCTION.md

## Tasks
1. Create `deploy.sh` script that:
   - Builds Go binary for Linux/amd64
   - Packages with chromedp dependencies
   - Creates deployment ZIP
   - Uploads to S3 (or inline if < 50MB)
   - Updates CloudFormation stack
   - Outputs API Gateway URL

## Verification
```bash
./deploy.sh
```
Should complete without errors and print API URL.

## Success Criteria
- Script is idempotent (can run multiple times)
- Handles both create and update stack operations
- Prints clear status messages
- Exits with code 0 on success
