# doc-examples/

## Purpose

- Sample HTML documents used for PDF generation checks and manual examples.

## Entrypoints

- `/Users/basilsergius/projects/renderpdf/doc-examples/invoice.html`
- `/Users/basilsergius/projects/renderpdf/doc-examples/report.html`
- `/Users/basilsergius/projects/renderpdf/doc-examples/short-rows.html`
- `/Users/basilsergius/projects/renderpdf/doc-examples/variable-columns.html`

## Safe To Edit

- Any sample HTML file in this folder.
- Add new sample files here if they are clearly test/example inputs.

## Treat Carefully

- Existing sample filenames
  - `scripts/test-api.sh` references `invoice.html` and `report.html` by name.
- HTML table structures
  - These samples appear to exercise pagination and table-layout behavior in the PDF renderer.

## How To Test

- Deployed smoke test:
  - `cd /Users/basilsergius/projects/renderpdf && ./scripts/test-api.sh`
- Manual checks:
  - paste the sample HTML into the landing page or dashboard test area

## Common Pitfalls

- Renaming files can silently break `scripts/test-api.sh`.
- These examples are not isolated fixtures; they are part of the current smoke-test path.
