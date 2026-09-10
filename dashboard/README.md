# dashboard/

## Purpose

- Static dashboard for sign-in, API key and template management, and test PDF generation.
- Includes HTML/CSS JSON and Markdown document editors with local validation, a network-isolated preview, authenticated rendering, and a PDF download result.
- Served publicly at `https://renderpdf.vberkoz.com/app/`.

## Entrypoints

- `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/index.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/app.js`
- `/Users/basilsergius/projects/renderpdf/dashboard/stats/index.html`

## Safe To Edit

- HTML, CSS, and JS files in this folder.
- `/Users/basilsergius/projects/renderpdf/dashboard/debug.html`
  - Safe if the change is clearly limited to debugging support.

## Treat Carefully

- `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
  - Hard-codes Cognito domain, client ID, and redirect URI.
- `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`
  - Controls token capture and redirect behavior.
- `/Users/basilsergius/projects/renderpdf/dashboard/app.js`
  - Depends on the `/api/v1` API shape and specific JSON response payloads.

## How To Test

- Static review:
  - Read the HTML and JS together to confirm paths still match.
- Deployment-backed verification:
  - Deploy via `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh` when dashboard assets change.
- Manual checks:
  - login redirect path
  - callback token storage
  - API key list/create/delete flow
  - test PDF generation button
  - HTML/CSS JSON and Markdown samples, validation errors, preview, render, and download flow

## Common Pitfalls

- This is a plain static app, not a bundled frontend project.
- Hard-coded production URLs are easy to break.
- Login, callback, and app behavior must stay aligned with CloudFormation Cognito settings.
