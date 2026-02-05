# MODULE 3: DEPLOYMENT AUTOMATION - IDEMPOTENT
**Reference:** 02-LAMBDA-FUNCTION.md

**AI Context:** Bash scripting, AWS CLI v2 commands, Go cross-compilation for Linux
**Focus:** Idempotent deployment scripts, error handling and rollback

## Reasoning
Deployment script must handle:
- **Build optimization**: Only rebuild if source changed (checksum comparison)
- **Package size**: chromedp dependencies are large → use S3 if >50MB
- **Stack updates**: Detect create vs update scenarios
- **Rollback capability**: Preserve previous version on failure
- **Environment detection**: Different settings for dev/prod

Decision tree:
- If no changes detected: Skip build, report "No changes"
- If code changed: Build, package, deploy Lambda code only
- If infrastructure changed: Update CloudFormation stack
- If deployment fails: Rollback to previous version
- Always: Verify deployment success before exit

Optimizations:
- Cache Go modules between builds
- Parallel operations where possible
- Clear progress reporting
- Exit codes for CI/CD integration

## State Detection
- Check if `deploy.sh` exists and is executable
- Verify CloudFormation stack current state
- Compare local code with deployed version
- Check if build artifacts are up-to-date

## Tasks (Conditional)
1. **If missing**: Create `deploy.sh` script that:
   - Builds Go binary for Linux/amd64
   - Packages with chromedp dependencies
   - Creates deployment ZIP
   - Uploads to S3 (or inline if < 50MB)
   - Updates CloudFormation stack
   - Outputs API Gateway URL
2. **If exists**: Update only if code changed
3. **Always**: Handle both create and update stack operations

## Verification
```bash
./deploy.sh
aws cloudformation describe-stacks --stack-name renderpdf
```

## Success Criteria
- Script runs without errors
- Detects and skips unchanged components
- Handles both create and update operations
- Prints clear status messages
- Exits with code 0 on success
