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

## Canonical render contract

`POST /api/v1/render` is the preferred authenticated entry point. Its strict,
versioned source union is:

```json
{
  "version": "1",
  "source": { "type": "html", "content": "<h1>{{title}}</h1>" },
  "css": "body { font-family: Arial, sans-serif; }",
  "data": { "title": "Monthly report" },
  "options": { "format": "A4", "margin": "18mm" }
}
```

Valid `source.type` values are `html`, `markdown`, `template`, `url`, `upload`,
and `stored`. The first two use `content`; template uses `templateId` and
`variables`; URL uses `url`; upload uses `uploadId` and optional `entrypoint`.
Stored uses a saved source `id`.
All forms may supply `webhookUrl` and `webhookSecret`.

Rendered PDFs are written to private, encrypted S3 prefixes keyed by opaque
account hashes. The response and `pdf.completed` webhook contain a signed
download URL valid for 15 minutes, rather than a public bucket URL.

## Saved sources

Authenticated customers can save reusable HTML or Markdown definitions:

- `POST /api/v1/sources`
- `GET /api/v1/sources`
- `GET /api/v1/sources/{id}`
- `PUT /api/v1/sources/{id}`
- `DELETE /api/v1/sources/{id}`

Create and update accept `{ "name": "…", "definition": { …canonical render definition… } }`.
Definitions may use only `html` or `markdown` sources and cannot include
webhook delivery settings. Read/list responses expose metadata only, never the
private definition content. Render one with:

```json
{
  "version": "1",
  "source": { "type": "stored", "id": "src_…" },
  "data": { "report": { "title": "August report" } }
}
```

The saved definition supplies its CSS, page options, and default data. The
render request may override `data` and provide webhook settings, but cannot
alter the saved source type, CSS, or page options.

## Files

- `POST /api/v1/files/upload` issues a 15-minute presigned ZIP upload URL.
- `GET /api/v1/files` lists the authenticated account's uploaded packages and
  rendered PDFs, including type, MIME type, size, checksum, retention date,
  origin request/job metadata, and creation time.
- `GET /api/v1/files/{id}/download` returns a 15-minute signed download URL.
- `DELETE /api/v1/files/{id}` removes the metadata record and its private
  object. Ownership is always derived from the authenticated account.

Current limits: 100 saved sources and 25 MiB of source definitions per
account; ZIP uploads are 25 MiB compressed; generated PDFs retain for at most
30 days. The batch API supports up to 99 items and two active jobs
per account. Objects remain private and all download URLs are short lived.

## Batches

`GET /api/v1/batches/{id}/download` packages completed item PDFs into a
private ZIP artifact (up to 100 MiB) and returns a 15-minute signed download
URL. Repeated requests reuse the same private artifact.

- `POST /api/v1/batches` validates and creates a queued job, returning its
  `jobId` and counters.
- `GET /api/v1/batches` lists the authenticated account's jobs, newest first.
- `GET /api/v1/batches/{id}` returns job state, totals, progress, and times.
- `GET /api/v1/batches/{id}/items` lists item state and output file IDs.
- `POST /api/v1/batches/{id}/cancel` cancels pending work.

## Inline Document JSON Contract

The `html` and `markdown` variants of `POST /api/v1/render` accept versioned
source documents. It validates and compiles the payload into safe HTML, then
uses the standard PDF storage, quota, analytics, and webhook pipeline.

Every render receives a generated `requestId`. Document analytics record the
request ID plus source metadata (source type such as `document_json` or
`markdown`, `inline`, contract version, and normalized-source byte size), but
never the source content. The same normalized contract is used by saved
sources and batch items.

### Source variants

Use a versioned source object for Markdown:

```json
{
  "version": "1",
  "source": {
    "type": "markdown",
    "content": "# {{report.title}}\n\n{{report.summary}}"
  },
  "css": "body { font-family: Arial, sans-serif; }",
  "data": { "report": { "title": "Monthly report", "summary": "Ready." } },
  "options": { "format": "A4", "margin": "18mm" }
}
```

The service validates Markdown
source shape, a 768 KiB content limit, unknown source fields, options, CSS,
binding data depth, and bindings, then converts the source into a safe HTML
fragment before using the same controlled document shell and PDF pipeline.

Markdown bindings are resolved before conversion. Values use the same required
and unused-value rules as HTML documents, then are treated as Markdown plain
text: they are HTML-escaped and Markdown-escaped, so data cannot introduce
links, formatting, tables, or raw markup.

The compiler uses [Goldmark](https://github.com/yuin/goldmark), a
CommonMark-compatible Go parser. Its initial profile enables tables,
strikethrough, and task lists only; raw HTML is not enabled.

```json
{
  "version": "1",
  "source": { "type": "html", "content": "<main><h1>{{title}}</h1><p>{{body}}</p></main>" },
  "css": "body { font-family: Arial, sans-serif; } h1 { color: #123456; }",
  "data": {
    "title": "Monthly report",
    "body": "Prepared for Ada & Sons."
  },
  "options": {
    "format": "A4",
    "margin": "18mm"
  },
  "webhookUrl": "https://hooks.example.com/renderpdf",
  "webhookSecret": "optional-signing-secret"
}
```

- `version` must be the string `"1"`.
- `source.type` is `html` or `markdown`; `source.content` must be non-empty.
- `css` is a string and may be empty.
- `data` is required and may be an empty object when the HTML has no bindings.
- HTML bindings use `{{path.to.value}}`. Every binding must have a value in
  `data`, and every supplied data leaf must be used; missing, unused, and
  malformed bindings return distinct 422 errors.
- Binding values are HTML-escaped before insertion. Raw HTML interpolation is
  not supported by this endpoint.
- The service wraps resolved HTML in a complete document shell with UTF-8
  metadata and a `<style>` element. It generates `@page` `size` and `margin`
  from `options`, rather than accepting page settings as part of the payload.
- Any `@page` rule in source content or `css` is rejected; page size and margin must
  come from `options`.
- Scripts, event-handler attributes, `iframe`, `embed`, `object`, `applet`,
  `base`, and stylesheet links are rejected. Local and remote document assets
  are not supported yet, including CSS `url()` and `@import` references.
- JavaScript is disabled in the document-specific PDF renderer as defense in
  depth; this does not change the existing HTML, URL, upload, or template
  rendering modes.
- Links may use `http`, `https`, `mailto`, or an in-document `#anchor`; other
  URL schemes and relative/local URLs are rejected.
- `options.format` and `options.margin` are optional layout-intent strings;
  omitted values default to `A4` and `18mm`.
- Supported `options.format` values are `A4`, `Letter`, and `Legal`.
- `options.margin` must use `mm` or `in`, from `0mm` through `50mm` or from
  `0in` through `2in` (for example, `18mm` or `0.5in`).
- `webhookUrl` and `webhookSecret` are optional and use the same signed,
  asynchronous `pdf.completed` delivery behavior as other authenticated
  render requests.

### Limits and rejected fields

- Request JSON: 1 MiB; HTML: 768 KiB; CSS: 128 KiB; data: 256 KiB.
- The final HTML/CSS input supplied to the renderer is limited to 1 MiB. The
  document compiler rechecks this after data binding.
- `data` may be nested no more than 10 levels, including its root object.
- Only `version`, `source`, `css`, `data`, `options`, `webhookUrl`, and
  `webhookSecret` are allowed at the top level. Only `format` and `margin` are
  allowed under `options`.
- Fields such as `javascript`, `scripts`, `assets`, and arbitrary page-size or
  margin-side options are rejected as unknown fields.

## Template Storage

See the [persistence model](../docs/persistence-model.md) for the active
source, file, batch-job, and batch-item record model.

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

Use `POST /api/v1/render` with a `template` source and nested `variables`.
It runs the resolved HTML through the normal PDF pipeline. For example:

```json
{
  "version": "1",
  "source": {
    "type": "template",
    "templateId": "invoice-template-id",
    "variables": {
      "invoice": { "number": "INV-1042" },
      "customer": { "name": "Ada & Sons" }
    }
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
  - Ignored local compiled artifact, not the source of truth.

## How To Test

- Unit/package tests:
  - `cd /Users/basilsergius/projects/renderpdf/api && go test ./...`
- Deployed integration smoke test:
  - `cd /Users/basilsergius/projects/renderpdf && ./scripts/test-api.sh`

## Common Pitfalls

- `main_test.go` skips if Chrome is not found in the expected path.
- The handler depends on env vars such as bucket/table names.
- PDF behavior is sensitive to Chrome flags and `/tmp` usage.
- Docker image build, not a local binary, is the deploy path.
