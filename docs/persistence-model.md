# Persistence Model

This is the persistence contract for saved render inputs, files, and future
batch rendering. The model is implemented by the authenticated source, file,
and batch APIs; this document records their durable data shapes and rules.

## Principles

- Every record is owned by exactly one authenticated account. Client requests
  never supply an owner ID.
- Saved document definitions reuse the canonical `POST /api/v1/render`
  contract. Delivery settings are intentionally excluded so a source can be
  rendered, shared with a batch, or delivered to different webhooks without
  mutating the source.
- Object storage is private. API responses issue short-lived download or
  upload URLs; no source, package, or PDF becomes public by default.
- IDs are opaque UUIDs with entity prefixes in API responses (`src_`, `file_`,
  `job_`). Object keys must not expose an account identifier.
- Each writer is idempotent. `requestId`/`jobId`/`itemId` are persisted before
  asynchronous work is queued.

## Storage locations

Use a dedicated DynamoDB table, `DocumentStoreTable`, rather than the usage
analytics table. It isolates retention, access patterns, and future batch
write volume from billing and analytics traffic. Keep the existing template
table in place during the first release; a future template import may create a
`source` that references a template ID without copying it.

Use private S3 prefixes in the existing appropriate buckets:

| Content | Bucket | Key shape |
| --- | --- | --- |
| Saved JSON/Markdown definition | private document bucket | `sources/{account-hash}/{source-id}/definition.json` |
| Original package/upload | package bucket | `uploads/{account-hash}/{upload-id}.zip` |
| Rendered PDF | PDF bucket | `files/{account-hash}/{file-id}.pdf` |
| Batch manifest/ZIP | private PDF bucket | `batches/{account-hash}/{job-id}/…` |

The record, not the object key, is the authority for ownership and access.
`account-hash` is a one-way digest, never a raw account ID.

## DynamoDB keys and indexes

`DocumentStoreTable` has primary key `(PK, SK)` and one account-listing GSI:

| Index | Partition key | Sort key | Purpose |
| --- | --- | --- | --- |
| Primary | `PK` | `SK` | Read/write an entity or list one job's items. |
| `AccountIndex` | `GSI1PK` | `GSI1SK` | List an account's sources, files, and jobs by type/date. |

Account keys use a stable one-way digest of the authenticated account ID, as
the template store already does:

```text
accountKey = ACCOUNT#{sha256(accountId)}
```

All account-owned root records use `PK = accountKey`. Batch items use
`PK = JOB#{jobId}` to allow ordered item queries, and copy `accountKey` for
authorization checks and the account index.

## Batch outbox delivery

Batch creation writes the job and its `queued` item records atomically. Each
item starts with `enqueueState = pending`; the DocumentStore DynamoDB stream
invokes a dedicated dispatcher for each inserted item. The dispatcher takes a
conditional enqueue lease, sends the item to SQS, then marks it `sent`.

If SQS or the acknowledgement write fails, the stream event is retried without
requiring a customer to poll the job. Delivery is intentionally at-least-once:
a failure after SQS accepts a message may re-send it, but the worker's
conditional item claim ensures only one PDF is rendered. The request-driven
recovery path remains as a fallback for batches written before the stream
dispatcher was deployed.

## Source record

```json
{
  "PK": "ACCOUNT#…",
  "SK": "SOURCE#src_01…",
  "entityType": "SOURCE",
  "sourceId": "src_01…",
  "ownerKey": "ACCOUNT#…",
  "name": "August report",
  "sourceType": "html",
  "definitionVersion": "1",
  "definitionFileId": "file_01…",
  "definitionBytes": 1248,
  "checksum": "sha256:…",
  "createdAt": "2026-08-19T12:00:00Z",
  "updatedAt": "2026-08-19T12:00:00Z",
  "GSI1PK": "ACCOUNT#…",
  "GSI1SK": "SOURCE#2026-08-19T12:00:00Z#src_01…"
}
```

The definition object contains only the normalized reusable input:

```json
{
  "version": "1",
  "source": {
    "type": "markdown",
    "content": "# {{report.title}}"
  },
  "css": "body { font-family: Arial, sans-serif; }",
  "data": { "report": { "title": "Monthly report" } },
  "options": { "format": "A4", "margin": "18mm" }
}
```

It omits `webhookUrl`, `webhookSecret`, request IDs, output URLs, and any
account identity. A saved template source uses:

```json
{ "version": "1", "source": { "type": "template", "templateId": "…", "variables": {} } }
```

An uploaded-package source uses `source.type: "upload"`, `uploadId`, and an
optional `entrypoint`. Saved URL sources are deferred because their content is
not immutable; callers can still use the inline `url` render source.

## File record

```json
{
  "PK": "ACCOUNT#…",
  "SK": "FILE#file_01…",
  "entityType": "FILE",
  "fileId": "file_01…",
  "ownerKey": "ACCOUNT#…",
  "kind": "rendered_pdf",
  "contentType": "application/pdf",
  "sizeBytes": 48392,
  "checksum": "sha256:…",
  "bucket": "private-pdf-bucket",
  "objectKey": "files/file_01….pdf",
  "origin": { "requestId": "…", "sourceId": "src_01…", "jobId": "job_01…", "itemId": "item_001" },
  "createdAt": "2026-08-19T12:00:00Z",
  "expiresAt": 1787131200,
  "GSI1PK": "ACCOUNT#…",
  "GSI1SK": "FILE#2026-08-19T12:00:00Z#file_01…"
}
```

Valid `kind` values initially are `source_definition`, `uploaded_package`,
and `rendered_pdf`. `expiresAt` is optional for retained customer files and is
the DynamoDB TTL value when retention ends. Deleting a file first marks it
`deleting`; a worker then removes the object and record. This avoids orphaned
references and makes retries safe.

## Batch job and item records

## Batch request contract

`POST /api/v1/batches` accepts exactly one of these modes:

```json
{
  "version": "1",
  "source": { "type": "stored", "id": "src_..." },
  "items": [
    { "data": { "customer": { "name": "Ada" } } },
    { "data": { "customer": { "name": "Grace" } } }
  ],
  "options": { "webhookUrl": "https://example.com/hooks/render" }
}
```

This mode uses one saved source and lets each item supply only its data. The
other mode omits top-level `source` and supplies a complete canonical render
definition under each item’s `definition` field. Item definitions cannot set
webhooks; delivery settings are job-level options. Explicit definitions support
every canonical render source (`html`, `markdown`, `template`, `url`, and
`upload`); stored sources resolve to their saved HTML or Markdown definition.
Both modes require 1–99 items and contract version `"1"`.

```json
{
  "PK": "ACCOUNT#…",
  "SK": "BATCH#job_01…",
  "entityType": "BATCH_JOB",
  "jobId": "job_01…",
  "ownerKey": "ACCOUNT#…",
  "sourceId": "src_01…",
  "status": "queued",
  "itemCount": 50,
  "queuedCount": 50,
  "runningCount": 0,
  "succeededCount": 0,
  "failedCount": 0,
  "cancelledCount": 0,
  "createdAt": "2026-08-19T12:00:00Z",
  "GSI1PK": "ACCOUNT#…",
  "GSI1SK": "BATCH#2026-08-19T12:00:00Z#job_01…"
}
```

```json
{
  "PK": "JOB#job_01…",
  "SK": "ITEM#000001",
  "entityType": "BATCH_ITEM",
  "jobId": "job_01…",
  "itemId": "item_01…",
  "ownerKey": "ACCOUNT#…",
  "ordinal": 1,
  "status": "queued",
  "data": { "customer": { "name": "Ada" } },
  "requestId": null,
  "outputFileId": null,
  "errorCode": null,
  "errorMessage": null,
  "attempt": 0,
  "createdAt": "2026-08-19T12:00:00Z"
}
```

Job states are `queued`, `running`, `completed`, `completed_with_errors`,
`cancelled`, and `failed`. Item states are `queued`, `running`, `succeeded`,
`failed`, and `cancelled`. Counters are changed atomically with item state
transitions; an item cannot enter a terminal state twice.

## Retention and deletion

- Source definitions persist until a customer deletes them or account
  retention requires removal.
- Original uploads retain their current short lifecycle unless a saved source
  references them; referenced packages receive an explicit retention policy.
- Rendered PDFs use a plan-specific retention period. Their download URLs are
  short lived even when the object is retained.
- A source cannot be deleted while a non-terminal batch references it. Either
  reject deletion with `409` or require an explicit batch cancellation first.
- Deleting a source never deletes already-rendered PDF files. A customer can
  delete those files independently.

## Initial limits and authorization

- A customer can save at most 100 sources totaling 25 MiB of normalized
  definition content. Source creation checks both limits before writing an
  object.
- ZIP uploads remain limited to 25 MiB compressed, 50 MiB extracted, and 500
  files. Uploaded-package retention is one day.
- Rendered PDF retention is capped at 30 days. All object URLs are signed and
  short lived; neither source files nor PDFs receive public-read access.
- The batch contract supports a maximum of 99 items per job and two active
  jobs per account. The batch APIs and worker will enforce these atomically
  when they are introduced.
- Source and file reads, updates, downloads, and deletes derive the account
  key from authentication and query only that account partition. Future batch
  jobs and items must copy the same account key and perform the identical
  ownership check before every read or state transition.

## Observability and audit metadata

Record only identifiers and operational metadata: source ID, file ID, job ID,
item ID, render request ID, byte sizes, duration, quota decision, and status
transition. Never emit source definitions, bound data, HTML, Markdown, CSS,
PDF URLs, or document content to analytics or application logs.

Batch workers emit structured `BATCH_AUDIT` events for claims, terminal item
transitions, and successful renders. CloudWatch metric filters/dashboards can
derive queue depth, batch duration, item failure rate, and storage growth from
those events and SQS/S3 native metrics. The production dashboard should expose
only aggregates, not document content.

## Initial implementation boundary

The first persistence release should implement source and file records only.
Batch-job and batch-item records are defined here so their later queue and
worker implementation can reuse the same IDs, ownership checks, file origins,
and normalized source definition without a schema migration.
