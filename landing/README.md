# landing/

## Purpose

- Static public landing page and demo form for the PDF API.
- Served publicly at `https://renderpdf.vberkoz.com/`, with API docs at `https://renderpdf.vberkoz.com/docs/api`, and legal/compliance pages at `/terms`, `/privacy`, `/refund`, and `/cancellation`.

## Entrypoints

- `/Users/basilsergius/projects/renderpdf/landing/index.html`

## Safe To Edit

- `/Users/basilsergius/projects/renderpdf/landing/index.html`

## Treat Carefully

- `/Users/basilsergius/projects/renderpdf/landing/index.html`
  - Contains the live API URL and in-page fetch behavior.
- `/Users/basilsergius/projects/renderpdf/landing/docs/api/index.html`
  - Public API docs entrypoint (Quick start), with individual article pages under `landing/docs/api/*/index.html`. Served from the same CloudFront distribution.

## How To Test

- Static review:
  - Confirm the form, result area, and fetch path still line up.
- Deploy-backed verification:
  - `cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy-landing.sh`
- Manual checks after deploy:
  - page loads
  - demo form submits
  - returned PDF link downloads

## Common Pitfalls

- The page posts directly to the production API URL.
- There is no local asset pipeline; edits are direct-file edits.
- Root deploy scripts assume this folder name and path.
