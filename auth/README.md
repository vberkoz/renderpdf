# auth/

## Purpose

- Go Lambdas for:
  - API key authorization
  - authenticated API key management
- Shared helper code for key hashing/generation.

## Entrypoints

- `/Users/basilsergius/projects/renderpdf/auth/authorizer.go`
- `/Users/basilsergius/projects/renderpdf/auth/api-keys.go`
- `/Users/basilsergius/projects/renderpdf/auth/utils.go`
- `/Users/basilsergius/projects/renderpdf/auth/Dockerfile.authorizer`
- `/Users/basilsergius/projects/renderpdf/auth/Dockerfile.apikeys`
- `/Users/basilsergius/projects/renderpdf/auth/utils_test.go`

## Safe To Edit

- `/Users/basilsergius/projects/renderpdf/auth/authorizer.go`
- `/Users/basilsergius/projects/renderpdf/auth/api-keys.go`
- `/Users/basilsergius/projects/renderpdf/auth/utils.go`
- `/Users/basilsergius/projects/renderpdf/auth/utils_test.go`
- `/Users/basilsergius/projects/renderpdf/auth/go.mod`
- `/Users/basilsergius/projects/renderpdf/auth/go.sum`
- Dockerfiles in this folder

## Treat Carefully

- `/Users/basilsergius/projects/renderpdf/auth/authorizer.go`
  - Uses build tag `authorizer` and depends on DynamoDB table structure.
- `/Users/basilsergius/projects/renderpdf/auth/api-keys.go`
  - Uses build tag `apikeys` and assumes Cognito claims shape in API Gateway authorizer context.
- `/Users/basilsergius/projects/renderpdf/auth/authorizer`
- `/Users/basilsergius/projects/renderpdf/auth/api-keys`
  - Ignored local compiled artifacts, not intended edit targets.

## How To Test

- Package tests:
  - `cd /Users/basilsergius/projects/renderpdf/auth && go test ./...`
- Integration note:
  - Assumption: end-to-end auth testing is mostly manual today because `test-auth.sh` and `test-dashboard.sh` are referenced in `_prompts/` but are not present in the repo.

## Common Pitfalls

- Build tags matter. The two Lambda binaries do not compile from the same entry file.
- DynamoDB key names must stay aligned with `infra/cloudformation.yaml`.
- `api-keys.go` hard-codes the allowed dashboard origin.
- Prompt docs mention files like `oauth-callback.go` that do not exist in current source.
