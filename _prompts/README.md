# HOW TO USE THESE PROMPTS (IDEMPOTENT)

## Idempotent Strategy

**SAFE TO RE-RUN**: All prompts detect existing state and only fill gaps or fix issues.

### Benefits
- **Resume from failures** without breaking existing code
- **Iterative development** - refine components incrementally  
- **Team collaboration** - multiple developers can run same prompts
- **Error recovery** - fix issues without manual cleanup

### Execution Pattern
Each prompt follows: **Detect → Fill Gaps → Verify**

---

## Workflow (Execute in Any Order)

### Step 0: Setup
```bash
cat _prompts/00-MASTER-PLAN.md
```
**AI Instruction:** "Read this file. Acknowledge the architecture. Detect current project state."

---

### Step 1: Infrastructure (Idempotent)
```bash
cat _prompts/01-INFRASTRUCTURE.md
```
**AI Instruction:** "Check existing CloudFormation stack. Create/update only missing components."

**Verification:**
```bash
aws cloudformation validate-template --template-body file://cloudformation.yaml
aws cloudformation describe-stacks --stack-name renderpdf
```

---

### Step 2: Lambda Function (Idempotent)
```bash
cat _prompts/02-LAMBDA-FUNCTION.md
```
**AI Instruction:** "Check existing Lambda code. Update only broken/missing functionality."

**Verification:**
```bash
cd api && go mod tidy && go test -v
```

---

### Step 3: Deployment (Idempotent)
```bash
cat _prompts/03-DEPLOYMENT.md
```
**AI Instruction:** "Check deployment script. Skip unchanged components during deployment."

**Verification:**
```bash
./deploy.sh
```

---

### Step 4: Testing (Idempotent)
```bash
cat _prompts/04-TESTING.md
```
**AI Instruction:** "Check test scripts exist. Run tests and update only if failures detected."

**Verification:**
```bash
./test-api.sh && ./test-local.sh
```

---

### Step 5: Landing Page (Idempotent)
```bash
cat _prompts/05-LANDING-PAGE.md
```
**AI Instruction:** "Check landing page functionality. Update only broken features."

**Verification:**
Open `landing/index.html` and test form submission.

---

### Step 6: Authentication Infrastructure (Idempotent)
```bash
cat _prompts/06-AUTH-INFRASTRUCTURE.md
```
**AI Instruction:** "Check Cognito setup. Add only missing auth components."

**Verification:**
```bash
aws cloudformation validate-template --template-body file://cloudformation.yaml
aws cognito-idp describe-user-pool --user-pool-id <pool-id>
```

---

### Step 7: Authentication Lambda (Idempotent)
```bash
cat _prompts/07-AUTH-LAMBDA.md
```
**AI Instruction:** "Check auth functions exist. Implement only missing/broken components."

**Verification:**
```bash
cd auth && go mod tidy && go test -v
```

---

### Step 8: Dashboard (Idempotent)
```bash
cat _prompts/08-DASHBOARD.md
```
**AI Instruction:** "Check dashboard files. Update only broken functionality."

**Verification:**
Open `dashboard/login.html` and test authentication flow.

---

### Step 9: Auth Deployment (Idempotent)
```bash
cat _prompts/09-AUTH-DEPLOYMENT.md
```
**AI Instruction:** "Check auth deployment status. Deploy only changed components."

**Verification:**
```bash
./deploy.sh
aws s3 ls s3://bucket-name/dashboard/
```

---

### Step 10: Auth Testing (Idempotent)
```bash
cat _prompts/10-AUTH-TESTING.md
```
**AI Instruction:** "Check auth tests exist. Run tests and report results."

**Verification:**
```bash
./test-auth.sh && ./test-dashboard.sh
```

---

## Key Principles

1. **Idempotent by design** - Safe to re-run any prompt multiple times
2. **State detection first** - Always check what exists before creating
3. **Incremental updates** - Fill gaps without breaking existing functionality
4. **Preserve data** - Never destroy existing configurations or data
5. **Verify after changes** - Test functionality after any modifications

## Recovery Patterns

**Partial failure**: Re-run specific module to complete missing pieces
**Code corruption**: Re-run module to restore functionality
**Configuration drift**: Re-run to align with desired state
**Team sync**: Anyone can run prompts to get up-to-date state

## Full System Verification

```bash
# Verify entire system health
aws cloudformation validate-template --template-body file://cloudformation.yaml
cd api && go mod tidy && go test -v
cd ../auth && go mod tidy && go test -v
cd ..
./deploy.sh
./test-api.sh
./test-auth.sh
```
