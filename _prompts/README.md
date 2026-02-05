# HOW TO USE THESE PROMPTS

## Workflow (Execute in Order)

### Step 0: Setup
```bash
# Read the master plan
cat _prompts/00-MASTER-PLAN.md
```
**AI Instruction:** "Read this file. Acknowledge the architecture. Do not generate code yet."

---

### Step 1: Infrastructure
```bash
# Execute infrastructure module
cat _prompts/01-INFRASTRUCTURE.md
```
**AI Instruction:** "Implement the CloudFormation template based on this prompt."

**Checkpoint:**
```bash
aws cloudformation validate-template --template-body file://cloudformation.yaml
```
✅ **MUST PASS** before proceeding to Step 2.

---

### Step 2: Lambda Function
```bash
cat _prompts/02-LAMBDA-FUNCTION.md
```
**AI Instruction:** "Implement the Lambda function and local test."

**Checkpoint:**
```bash
cd api && go test -v
```
✅ **MUST PASS** before proceeding to Step 3.

---

### Step 3: Deployment
```bash
cat _prompts/03-DEPLOYMENT.md
```
**AI Instruction:** "Create the deployment script."

**Checkpoint:**
```bash
./deploy.sh
```
✅ **MUST COMPLETE** and output API URL.

---

### Step 4: Testing
```bash
cat _prompts/04-TESTING.md
```
**AI Instruction:** "Create E2E test scripts."

**Checkpoint:**
```bash
./test-api.sh
```
✅ **ALL TESTS MUST PASS**.

---

### Step 5: Landing Page (Optional)
```bash
cat _prompts/05-LANDING-PAGE.md
```
**AI Instruction:** "Enhance the landing page with interactive form."

**Checkpoint:**
Open `landing/index.html` in browser and test.

---

### Step 6: Authentication Infrastructure
```bash
cat _prompts/06-AUTH-INFRASTRUCTURE.md
```
**AI Instruction:** "Add Cognito and API key infrastructure to CloudFormation."

**Checkpoint:**
```bash
aws cloudformation validate-template --template-body file://cloudformation.yaml
```
✅ **MUST PASS** before proceeding to Step 7.

---

### Step 7: Authentication Lambda Functions
```bash
cat _prompts/07-AUTH-LAMBDA.md
```
**AI Instruction:** "Implement Lambda authorizer and API key management functions."

**Checkpoint:**
```bash
cd auth && go test -v
```
✅ **MUST PASS** before proceeding to Step 8.

---

### Step 8: User Dashboard
```bash
cat _prompts/08-DASHBOARD.md
```
**AI Instruction:** "Create dashboard for Google login and API key management."

**Checkpoint:**
Open `dashboard/login.html` in browser and verify UI loads.

---

### Step 9: Authentication Deployment
```bash
cat _prompts/09-AUTH-DEPLOYMENT.md
```
**AI Instruction:** "Update deployment script for authentication components."

**Checkpoint:**
```bash
./deploy.sh
```
✅ **MUST COMPLETE** and output Cognito + Dashboard URLs.

---

### Step 10: Authentication Testing
```bash
cat _prompts/10-AUTH-TESTING.md
```
**AI Instruction:** "Create E2E tests for authentication flow."

**Checkpoint:**
```bash
./test-auth.sh
```
✅ **ALL AUTH TESTS MUST PASS**.

---

## Key Principles

1. **Never skip checkpoints** - If a test fails, fix it before moving forward
2. **One module at a time** - Don't ask AI to implement multiple modules simultaneously
3. **Paste errors back** - If checkpoint fails, paste the error to AI: "Fix this before Module X"
4. **Keep context** - Reference previous modules: "Based on the Lambda function we built in Module 2..."

## Regression Testing

After any changes, re-run all checkpoints:
```bash
aws cloudformation validate-template --template-body file://cloudformation.yaml
cd api && go test -v
cd auth && go test -v
./deploy.sh
./test-api.sh
./test-auth.sh
```
