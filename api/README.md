# api/

## Purpose

- Go Lambda that accepts HTML or a previously uploaded ZIP package and returns a PDF download URL.
- Also records usage in DynamoDB.

## Template Variable Contract

- Templates use `{{path.to.value}}` placeholders, for example
  `{{customer.name}}` or `{{invoice.number}}`.
- Placeholder values must be supplied as a nested JSON object. Values are
  HTML-escaped before insertion.
- Every placeholder is required and additional variable values are rejected.
  These validation failures use HTTP 422 when template endpoints are added.
- Raw HTML interpolation is intentionally unsupported.

## Template Storage

- Customer templates are stored durably in a dedicated DynamoDB table, keyed
  by a one-way owner partition derived from the authenticated customer ID.
- A customer may store up to 100 templates, each up to 1 MiB of HTML. The
  limit is reserved atomically with the template write.
- The table uses CloudFormation retain policies so normal deployments and
  resource replacement do not discard customer templates.

## Template API

All template routes require an API key. The authenticated API-key owner is
used as the template owner; `ownerId` is never accepted from request JSON.

- `POST /api/v1/templates`
- `GET /api/v1/templates`
- `GET /api/v1/templates/{id}`
- `PUT /api/v1/templates/{id}`
- `DELETE /api/v1/templates/{id}`

Create and update requests accept `name`, `type`, `html`, and optional
`variables` default data. When present, the data must match the template's
placeholders and is returned with the stored template. Create returns 201,
successful reads and updates return 200, and deletion returns 204.

## Render a Template

`POST /api/v1/render-template` accepts a `templateId` and nested `variables`,
then runs the resolved HTML through the normal PDF pipeline. For example:

```json
{
  "templateId": "invoice-template-id",
  "variables": {
    "invoice": { "number": "INV-1042" },
    "customer": { "name": "Ada & Sons" }
  }
}
```

## Bundled Starter Templates

Invoice, Contract, Certificate, and Receipt starter definitions are available
in `starter_templates.go`. Their variable groups and representative payloads
are documented in `/Users/basilsergius/projects/renderpdf/docs/starter-templates.md`.
`GET /api/v1/templates` also returns the starter definitions and their exact
variable paths in its `starters` array, ready to copy into `POST /templates`.

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
