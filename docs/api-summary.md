# API Summary Cheat-Sheet

Condensed, token-optimized contract reference for RenderPDF API (`https://renderpdf.vberkoz.com/api/v1`).
Agents: Consult this file first. Inspect [openapi.yaml](file:///Users/basilsergius/projects/renderpdf/docs/openapi.yaml) only for deep/extended schema properties.

## Authentication & Headers

- **Auth**: `Authorization: Bearer <API_KEY>` (required for all routes except `/trial/*`, `/api-keys`, and `/analytics`).
- **Cognito Auth**: `Authorization: Bearer <COGNITO_ID_TOKEN>` (required for `/api-keys` and `/analytics`).
- **Content-Type**: `application/json` (standard JSON body for requests).
- **Accept**: `application/json` (default) or `application/pdf` (returns binary PDF response directly on `POST /render`).
- **Idempotency-Key**: Optional header (1–256 printable ASCII chars) on `POST /render`, `POST /merge`, and `POST /batches`. Replays identical 2xx responses for 24h (`X-Idempotent-Replay: true`) without double-billing or duplicating jobs; mismatched payloads return `409 idempotency_key_conflict`.
- **Quota & Retry Headers**:
  - `X-Quota-Limit` / `X-Quota-Remaining`: Emitted on authenticated `/quota`, `/render`, `/merge`, and `/batches` responses.
  - `X-Trial-Limit` / `X-Trial-Remaining`: Emitted on `/trial/render` and `/trial/quota`.
  - `Retry-After`: Emitted in seconds on `429` (rate limit / quota exhaustion) and `503` responses.
  - `X-File-Id`: Stored file ID returned on non-zero-retention `/render` and `/merge` responses.
  - `X-Request-Id`: Unique request ID for tracing and support.

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
    "landscape": false,
    "displayHeaderFooter": false,
    "headerTemplate": "<span>...</span>",
    "footerTemplate": "<span>...</span>",
    "password": "open_pass",
    "ownerPassword": "owner_pass",
    "permissions": "all|print|none",
    "pageNumbers": {
      "format": "Page {page} of {total}",
      "position": "bottom-center|bottom-right|bottom-left|top-center|top-right|top-left",
      "startPage": 2,
      "excludeCover": true,
      "startNumber": 1,
      "fontSize": 9,
      "color": "0.4 0.4 0.4"
    },
    "watermark": {
      "text": "CONFIDENTIAL",
      "diagonal": true,
      "rotation": 45,
      "opacity": 0.15,
      "color": "#dc2626",
      "fontSize": 54,
      "font": "Helvetica|Times-Roman|Courier",
      "position": "center|top-center|top-left|top-right|bottom-center|bottom-left|bottom-right",
      "pages": "all|odd|even|1|2-",
      "onTop": true
    },
    "compliance": {
      "profile": "pdfa-1b|pdfa-2b|pdfa-3b|pdfua-1|factur-x|zugferd",
      "pdfua": true,
      "title": "Invoice #INV-2026-001",
      "language": "en-US",
      "validateXml": true,
      "invoiceXml": "<rsm:CrossIndustryInvoice>...</rsm:CrossIndustryInvoice>",
      "invoiceProfile": "MINIMUM|BASIC WL|BASIC|EN 16931|EXTENDED",
      "xmlFilename": "factur-x.xml|zugferd-invoice.xml",
      "documentType": "INVOICE",
      "version": "1.0"
    },
    "waitFor": {
      "selector": "#chart svg",
      "function": "() => window.READY === true",
      "networkIdle": "networkidle0|networkidle2",
      "timeoutMs": 5000,
      "fonts": true
    },
    "zeroRetention": false,
    "responseFormat": "json|binary|pdf",
    "strictVariables": true,
    "allowExtraVariables": false
  },
  "label": "optional tracking label",
  "webhookUrl": "https://...",
  "webhookSecret": "secret"
}
```

### The 6 Source Types (`source.type`)

| Type | Required Fields | Example / Description |
|---|---|---|
| `html` | `content` (string) | `{"type": "html", "content": "<h1>{{title}}</h1>"}` (max 1 MB). When `data` or `css` is supplied, external assets (`src`, `srcset`, `link`), `<script>`, `<iframe>`, and CSS `url()`/`@import`/`@page` are disallowed (`422`) — use inline SVG, `{{qrcode}}`/`{{barcode}}`, `url`, or `upload`. |
| `markdown` | `content` (string) | `{"type": "markdown", "content": "# {{title}}"}` |
| `template` | `templateId` or `id` (string), opt: `variables` or `data` (obj) | `{"type": "template", "templateId": "tmpl_..."}` (cross-resolves saved sources) |
| `url` | `url` (valid http/https URI), opt: `headers` (obj), `cookies` (array) | `{"type": "url", "url": "https://example.com", "headers": {"Authorization": "Bearer ..."}, "cookies": [{"name": "sid", "value": "..."}]}` (same-origin scoped; SSRF/hop-by-hop headers scrubbed) |
| `upload` | `uploadId` (string), opt: `entrypoint` (str) | `{"type": "upload", "uploadId": "upload_...", "entrypoint": "index.html"}` |
| `stored` | `id` or `templateId` (string), opt: `data` or `variables` (obj) | `{"type": "stored", "id": "src_..."}` (cross-resolves saved templates) |

**Response**:
- `200 OK` (default JSON): `{"requestId": "uuid", "fileId": "file_uuid", "url": "https://signed-s3...", "size": 48392, "pageCount": 2, "warnings": [...]}` (signed URL expires in 15m; `warnings` omitted when empty)
- `200 OK` (`options.zeroRetention: true` with JSON): `{"requestId": "uuid", "size": 48392, "pageCount": 2, "data": "<base64-pdf>", "zeroRetention": true}` (0 S3 writes, 0 DocumentStore records)
- `200 OK` (`Accept: application/pdf` or `options.responseFormat: "binary"`): binary `application/pdf` payload (`X-Request-Id`, `X-File-Id`, `Content-Disposition: inline; filename="..."`, and `X-Retention-Policy: zero-retention` when `zeroRetention: true`)
- Status codes: `400` Malformed JSON or unknown field (returns `field`), `401` Missing auth, `403` Invalid/inactive API key or restricted region, `409` Storage limit or `Idempotency-Key` conflict, `422` Validation/render failure, `429` Monthly quota or rate limit exceeded (`Retry-After` set), `500` Internal error, `503` Service unavailable (`Retry-After` set), `504` Render timeout.

## Errors (`APIErrorResponse`)

```json
{
  "error": "Invalid render request: unknown field \"foo\"",
  "code": "render_request_invalid",
  "requestId": "uuid",
  "field": "foo",
  "retryable": false,
  "details": {}
}
```
- `retryable`: `true` for `429`, `500`, `502`, `503`, `504`; `false` for `400`, `401`, `403`, `404`, `405`, `409`, `413`, `422`.
- `details` / `warnings`: Optional bounded diagnostic context (e.g. `ssrf_blocked` subresource URLs, `failedAssetUrls`, `jsErrors`, `cssErrors`).

## Account Quota: `GET /quota`

- `GET /quota`: Check authenticated monthly PDF allowance (`200 OK` -> `{"limit": 25, "used": 4, "remaining": 21, "period": "2026-11"}` plus `X-Quota-Limit` and `X-Quota-Remaining` headers).

### Safe Control Blocks (`{{#each}}`, `{{#if}}`, `{{#unless}}`)

Templates and HTML/Markdown documents support bounded control blocks alongside `{{path.to.value}}` bindings:
- **Iteration**: `{{#each items}}<li>{{@index}}: {{name}} ({{../company.name}})</li>{{/each}}` (supports `{{this}}`, `{{.}}`, `{{@index}}`, `{{@first}}`, `{{@last}}`, relative item fields, and `../` parent lookups; max nesting depth 5, max 1,000 total iterations per render).
- **Conditionals**: `{{#if discount}}<p>Discount: {{discount}}</p>{{else}}<p>Standard rate</p>{{/if}}` and `{{#unless hideFooter}}...{{/unless}}`.
- **Extra Variables**: Unreferenced keys in `data`/`variables` are automatically permitted when control blocks are used, when saved template/source defaults are merged, or when `options.strictVariables: false` (`options.allowExtraVariables: true`) is set. Missing required placeholders inside active branches always return `422`.

### Dynamic Vector Barcodes & QR Codes

Templates and HTML documents can directly embed barcodes and QR codes rendered server-side as crisp, high-resolution vector SVGs (zero client-side JavaScript needed).

- **Handlebars-Style Template Helpers**:
  - `{{qrcode url}}` or `{{qrcode url size="140px" level="H"}}`
  - `{{barcode '128' trackingId}}` or `{{barcode '128' trackingId width="200px" height="50px" text=true}}`
  - `{{barcode 'code39' code}}` or `{{barcode 'datamatrix' secret}}`
  - Supports string literals (`{{barcode '128' 'STATIC-100'}}`) or data-binding variables (`trackingId`, `invoice.number`).
- **HTML Tags & Custom Attributes**:
  - `<qrcode value="https://example.com" size="140" level="M|L|Q|H" color="#000" background="#fff" />`
  - `<div data-qrcode="https://example.com" data-qr-size="120px"></div>`
  - `<barcode type="code128|128|code39|39|ean|ean13|ean8|2of5|datamatrix|pdf417|qr" value="INV-2026" width="220" height="60" text="true|false" />`
  - `<div data-barcode="INV-2026" data-barcode-type="code128"></div>`

### PDF/A, PDF/UA-1 & Invoicing Compliance (Factur-X / ZUGFeRD)

- **VeraPDF-Passing PDF/A, PDF/UA-1 & Invoicing Compliance (Factur-X / ZUGFeRD)**:
  - Supports ISO archival profiles (`pdfa-1b`, `pdfa-2b`, `pdfa-3b`), Universal Accessibility (`pdfua-1` or `options.compliance.pdfua: true`), and hybrid Franco-German e-invoicing (`factur-x`, `zugferd`).
  - Embeds a real 3-channel (`/N 3`) sRGB IEC61966-2.1 ICC color profile stream as `/DestOutputProfile` in `/OutputIntents` with `/S /GTS_PDFA1`.
  - Synchronizes XMP metadata (`dc:title`, `dc:creator`, `dc:description`, `pdfaid:part`, `pdfaid:conformance`, `pdfuaid:part`) with the PDF `/Info` dictionary and trailer `/ID`, and configures Tagged PDF structure (`/MarkInfo << /Marked true >>`, `/Lang`, `/ViewerPreferences << /DisplayDocTitle true >>`, `/StructTreeRoot`).
  - For `factur-x` and `zugferd`: validates UN/CEFACT CII XML structure against KoSIT EN 16931 rules (`CrossIndustryInvoice`, `ExchangedDocumentContext`, `ExchangedDocument/ID`, `SupplyChainTradeTransaction`), embeds the XML (`factur-x.xml` or `zugferd-invoice.xml`) into `/EmbeddedFiles` with `/Params << /Size ... /ModDate ... >>`, associates it in `/AF` with `/AFRelationship /Data` and stream `/Subtype /text/xml`, and adds the official Factur-X Adobe XMP extension schema (`urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#`).
  - Supported invoice profiles: `MINIMUM`, `BASIC WL`, `BASIC`, `EN 16931` (default, standard EU mandate), `EXTENDED`.
  - Note: PDF/A specification strictly forbids password encryption; combining `compliance` with `password` or `ownerPassword` returns `422`.

## Native PDF Merging: `POST /merge`

Merge multiple PDFs into a single document with optional unified page numbering, watermarks, encryption, and compliance metadata. (The legacy alias `POST /pdf/merge` is deprecated and emits RFC 8594 `Deprecation`, `Sunset`, and `Link: </api/v1/merge>; rel="successor-version"` headers.)

Request shape:
```json
{
  "version": "1",
  "files": ["file_cover123", "https://example.com/sheet.pdf", "file_terms456"],
  "items": [
    { "fileId": "file_cover123" },
    { "url": "https://example.com/sheet.pdf" },
    { "data": "<base64-encoded-pdf>" }
  ],
  "options": {
    "pageNumbers": {
      "format": "Page {page} of {total}",
      "position": "bottom-center"
    },
    "watermark": {
      "text": "CONFIDENTIAL",
      "diagonal": true,
      "opacity": 0.15
    },
    "password": "open_pass",
    "ownerPassword": "owner_pass",
    "permissions": "all|print|none",
    "compliance": {
      "profile": "factur-x",
      "invoiceXml": "<rsm:CrossIndustryInvoice>...</rsm:CrossIndustryInvoice>"
    }
  },
  "label": "Quarterly Report.pdf",
  "webhookUrl": "https://...",
  "webhookSecret": "secret"
}
```
- Accepts either `files` (shorthand list of file IDs or HTTP URLs) or `items` (explicit list of `fileId`, `url`, or base64 `data`).
- Min 2 items, max 100 items. Max total input: 50 MB.
- Response (`200 OK`): `{"requestId": "uuid", "fileId": "file_uuid", "url": "https://signed-s3...", "size": 98392, "pageCount": 12}`.

## Batches (Asynchronous Bulk PDF)

- `GET /batches`: List batch jobs (`200 OK` -> `{"jobs": [BatchJobRecord]}`).
- `POST /batches`: Submit batch (1–99 items) (`201 Created` -> `BatchJobRecord`; supports `Idempotency-Key` header).
  - Shape: `{"version": "1", "source": {"type": "stored", "id": "src_..."}, "items": [{"data": {...}}, {"definition": {...}}], "options": {"webhookUrl": "...", "webhookSecret": "...", "mergeOutput": true}}`.
  - Batch can apply a shared stored `source` with per-item `data` bindings, or individual item `definition` objects.
  - Setting `"mergeOutput": true` automatically merges all completed item PDFs into a single unified PDF upon export.
- `GET /batches/{id}`: Batch status & item counts (`200 OK` -> `BatchJobRecord` with statuses: `queued|running|cancelling|completed|completed_with_errors|cancelled|failed`).
- `GET /batches/{id}/items`: Item results (`200 OK` -> `{"items": [BatchItemRecord]}` with `status`, `outputFileId`, `errorCode`, `errorMessage`).
- `POST /batches/{id}/cancel`: Cancel pending items (`200 OK` -> `BatchJobRecord`).
- `GET /batches/{id}/download`: Get download URL for batch export (`200 OK` -> `{"fileId": "...", "url": "https://...", "format": "zip|pdf"}`).
  - Query parameter `?format=pdf` forces a merged PDF export; `?format=zip` forces a ZIP archive. Default follows the job's `mergeOutput` option.

## Trial (Unauthenticated, IP Rate-Limited)

- `POST /trial/render`: Render raw HTML (max 1 MB; 3 PDFs/day) (`200 OK` -> `RenderSuccessResponse`, `400`, `429`).
  - Body: `{"html": "<h1>Trial</h1>"}`
- `GET /trial/quota`: Quota check (`200 OK` -> `{"limit": 3, "remaining": 2}`).

## Templates (`/templates`)

- `GET /templates`: List owned templates and starters (`200 OK` -> `{"templates": [TemplateRecord], "starters": [StarterTemplate]}`).
- `POST /templates`: Create template (`201 Created` -> `TemplateRecord`).
  - Body: `{"name": "Invoice", "type": "invoice", "html": "...", "variables": {...}}`
- `GET /templates/{id}`: Get template (`200 OK` -> `TemplateRecord`, `404`).
- `PUT /templates/{id}`: Update template (`200 OK` -> `TemplateRecord`).
- `DELETE /templates/{id}`: Delete template (`204 No Content`).

## Sources (`/sources`)

- `GET /sources`: List saved source definitions (`200 OK` -> `{"sources": [SourceRecord]}`).
- `POST /sources`: Save definition (`201 Created` -> `SourceRecord`).
  - Body: `{"name": "Report", "definition": { <CanonicalRenderRequest> }}`
- `GET /sources/{id}`: Get source definition (`200 OK` -> `SourceRecord`).
- `PUT /sources/{id}`: Update source definition (`200 OK` -> `SourceRecord`).
- `DELETE /sources/{id}`: Delete source definition (`204 No Content`).

## Files & Packages (`/files`)

- `GET /files`: List customer files (`200 OK` -> `{"files": [FileRecord]}`: rendered PDFs, uploads, batch ZIPs).
- `POST /files/upload`: Get 15-min S3 PUT URL for asset ZIP (`201 Created` -> `{"uploadId": "...", "uploadUrl": "...", "expiresIn": 900}`). (Legacy alias `POST /uploads` is deprecated and returns RFC 8594 `Deprecation`, `Sunset`, and `Link: </api/v1/files/upload>; rel="successor-version"` headers.)
- `GET /files/{id}`: Get metadata (`200 OK` -> `FileRecord`).
- `DELETE /files/{id}`: Delete file and S3 object (`204 No Content`).
- `GET /files/{id}/download`: Get 15-min signed download URL (`200 OK` -> `{"url": "..."}`).

## API Keys (`/api-keys`) & Analytics (`/analytics`) — Cognito JWT Auth

- `GET /api-keys`: List API keys (`200 OK` -> `{"keys": [ApiKeyRecord], "nextCursor": "...", "limit": 50}`; optional query `?limit=1..100&cursor=<token>`).
- `POST /api-keys`: Create API key (`200 OK` -> `{"keyId": "...", "apiKey": "rpdf_live_...", "name": "..."}`).
- `DELETE /api-keys/{id}`: Revoke API key (`204 No Content`).
- `POST /analytics`: Log client analytics event (`200 OK` -> `{"success": true}`). Body: `{"eventName": "...", "metadata": {...}}`.
