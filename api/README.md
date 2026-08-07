# api/

## Purpose

- Go Lambda that accepts HTML or a previously uploaded ZIP package and returns a PDF download URL.
- Also records usage in DynamoDB.

## Entrypoints

- `/Users/basilsergius/projects/renderpdf/api/main.go`
- `/Users/basilsergius/projects/renderpdf/api/Dockerfile`
- `/Users/basilsergius/projects/renderpdf/api/main_test.go`

## Safe To Edit

- `/Users/basilsergius/projects/renderpdf/api/main.go`
- `/Users/basilsergius/projects/renderpdf/api/main_test.go`
- `/Users/basilsergius/projects/renderpdf/api/Dockerfile`
- `/Users/basilsergius/projects/renderpdf/api/go.mod`
- `/Users/basilsergius/projects/renderpdf/api/go.sum`

## Treat Carefully

- `/Users/basilsergius/projects/renderpdf/api/main.go`
  - Contains AWS env var names, S3/DynamoDB behavior, and Chrome runtime assumptions.
- `/Users/basilsergius/projects/renderpdf/api/Dockerfile`
  - Installs Chrome and defines the Lambda bootstrap build.
- `/Users/basilsergius/projects/renderpdf/api/renderpdf`
  - Assumption: local compiled artifact, not the source of truth.

## How To Test

- Unit/package tests:
  - `cd /Users/basilsergius/projects/renderpdf/api && go test ./...`
- Deployed integration smoke test:
  - `cd /Users/basilsergius/projects/renderpdf && ./scripts/test-api.sh`

## Common Pitfalls

- `main_test.go` skips if Chrome is not found in the expected path.
- The handler depends on env vars such as bucket/table names.
- PDF behavior is sensitive to Chrome flags and `/tmp` usage.
- Docker image build, not the checked-in binary, is the deploy path.
