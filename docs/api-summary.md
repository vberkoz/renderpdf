# API Summary Cheat-Sheet

Condensed, token-optimized contract reference for RenderPDF API (`https://renderpdf.vberkoz.com/api/v1`).
Agents: Consult this file first. Inspect [openapi.yaml](file:///Users/basilsergius/projects/renderpdf/docs/openapi.yaml) only for deep/extended schema properties.

## Authentication & Headers

- **Auth**: `Authorization: Bearer <API_KEY>` (required for all routes except `/trial/*`).
- **Content-Type**: `application/json` (standard JSON body for requests).

## Canonical Render: `POST /render`

Request shape:
```json
{
  "version": "1",
  "source": { "type": "<source_type>", ... },
  "css": "body { font-size: 14px; }",
  "data": { "key": "value" },
  "options": {
    "format": "A4|Letter|Legal",
    "margin": "18mm",
    "displayHeaderFooter": false,
    "headerTemplate": "<span>...</span>",
    "footerTemplate": "<span>...</span>",
    "password": "open_pass",
    "ownerPassword": "owner_pass",
    "permissions": "all|print|none"
  },
  "label": "optional tracking label",
  "webhookUrl": "https://...",
  "webhookSecret": "secret"
}
```

### The 6 Source Types (`source.type`)

| Type | Required Fields | Example / Description |
|---|---|---|
| `html` | `content` (string) | `{"type": "html", "content": "<h1>{{title}}</h1>"}` (max 1 MB) |
| `markdown` | `content` (string) | `{"type": "markdown", "content": "# {{title}}"}` |
| `template` | `templateId` (string), opt: `variables` (obj) | `{"type": "template", "templateId": "tmpl_..."}` |
| `url` | `url` (valid http/https URI) | `{"type": "url", "url": "https://example.com"}` |
| `upload` | `uploadId` (string), opt: `entrypoint` (str) | `{"type": "upload", "uploadId": "upload_...", "entrypoint": "index.html"}` |
| `stored` | `id` (string) | `{"type": "stored", "id": "src_..."}` (saved source definition) |

**Response**:
- `200 OK`: `{"requestId": "uuid", "url": "https://signed-s3...", "size": 48392}` (signed URL expires in 15m)
- Status codes: `400` Malformed JSON, `401` Unauthorized, `403` Quota exceeded, `422` Validation failure, `429` Rate limit, `500` Chromium/internal error.

## Batches (Asynchronous Bulk PDF)

- `GET /batches`: List batch jobs (`200 OK` -> `[BatchJobRecord]`).
- `POST /batches`: Submit batch (1–99 items) (`202 Accepted` -> `BatchJobRecord`).
  - Shape: `{"version": "1", "source": {"type": "stored", "id": "src_..."}, "items": [{"data": {...}}, {"definition": {...}}], "options": {"webhookUrl": "...", "webhookSecret": "..."}}`.
  - Batch can apply a shared stored `source` with per-item `data` bindings, or individual item `definition` objects.
- `GET /batches/{id}`: Batch status & item counts (`200 OK` -> `BatchJobRecord` with statuses: `queued|running|completed|completed_with_errors|cancelled|failed`).
- `GET /batches/{id}/items`: Item results (`200 OK` -> `[BatchItemRecord]` with `status`, `outputFileId`, errors).
- `POST /batches/{id}/cancel`: Cancel pending items (`200 OK` -> `BatchJobRecord`).
- `GET /batches/{id}/download`: Get download URL for ZIP archive of batch PDFs (`200 OK` -> `{"downloadUrl": "https://..."}`).

## Trial (Unauthenticated, IP Rate-Limited)

- `POST /trial/render`: Render raw HTML (max 1 MB; 3 PDFs/day) (`200 OK` -> `RenderSuccessResponse`, `400`, `429`).
  - Body: `{"html": "<h1>Trial</h1>"}`
- `GET /trial/quota`: Quota check (`200 OK` -> `{"limit": 3, "remaining": 2}`).

## Templates (`/templates`)

- `GET /templates`: List owned templates (`200 OK` -> `[TemplateRecord]`).
- `POST /templates`: Create template (`201 Created` -> `TemplateRecord`).
  - Body: `{"name": "Invoice", "html": "...", "css": "...", "options": {...}, "defaultData": {...}}`
- `GET /templates/{id}`: Get template (`200 OK` -> `TemplateRecord`, `404`).
- `PUT /templates/{id}`: Update template (`200 OK` -> `TemplateRecord`).
- `DELETE /templates/{id}`: Delete template (`200 OK` -> `{"success": true}`).

## Sources (`/sources`)

- `GET /sources`: List saved source definitions (`200 OK` -> `[SourceRecord]`).
- `POST /sources`: Save definition (`201 Created` -> `SourceRecord`).
  - Body: `{"name": "Report", "definition": { <CanonicalRenderRequest> }}`
- `GET /sources/{id}`: Get source definition (`200 OK` -> `SourceRecord`).
- `PUT /sources/{id}`: Update source definition (`200 OK` -> `SourceRecord`).
- `DELETE /sources/{id}`: Delete source definition (`200 OK`).

## Files & Packages (`/files`)

- `GET /files`: List customer files (`200 OK` -> `[FileRecord]`: rendered PDFs, uploads, batch ZIPs).
- `POST /files/upload`: Get 15-min S3 PUT URL for asset ZIP (`200 OK` -> `{"uploadId": "...", "uploadUrl": "...", "expiresIn": 900}`).
- `GET /files/{id}`: Get metadata (`200 OK` -> `FileRecord`).
- `DELETE /files/{id}`: Delete file and S3 object (`200 OK`).
- `GET /files/{id}/download`: Get 15-min signed download URL (`200 OK` -> `{"url": "...", "expiresIn": 900}`).

## API Keys (`/api-keys`) & Analytics (`/analytics`)

- `GET /api-keys`: List API keys (`200 OK` -> `[ApiKeyRecord]`).
- `POST /api-keys`: Create API key (`201 Created` -> `{"id": "...", "key": "rpdf_live_...", "name": "..."}`).
- `DELETE /api-keys/{id}`: Revoke API key (`200 OK`).
- `GET /analytics`: Usage stats for admin (`200 OK` -> `{"totalRequests": 100, "totalBytes": 1000, "periodDays": 30}`, `403`).
- `POST /analytics`: Log client analytics event (`200 OK` -> `{"success": true}`). Body: `{"eventName": "...", "metadata": {...}}`.
