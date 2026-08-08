# scripts/

## Purpose

- Canonical home for operational shell scripts.

## Current Contents

- `/Users/basilsergius/projects/renderpdf/scripts/verify-api.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-auth.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-infra.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-shell.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-deployed-api.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/deploy-landing.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/test-api.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/test-template-docs.sh`

## Notes

- Root `deploy.sh`, `deploy-landing.sh`, and `test-api.sh` remain thin compatibility wrappers.
- Verification entrypoints live in `scripts/verify-*.sh`.
- Set `RENDERPDF_API_KEY` when running `test-api.sh` to exercise the deployed
  template create, render, update, and delete lifecycle in addition to the
  public render checks.
- Run `test-template-docs.sh` with the same variable to execute the public
  template documentation requests against a deployed API.
