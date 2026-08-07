# infra/

## Purpose

- Canonical home for infrastructure definitions and deploy-time configuration examples.

## Current Contents

- `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
- `/Users/basilsergius/projects/renderpdf/infra/parameters.json.example`
- `/Users/basilsergius/projects/renderpdf/infra/ecr-lifecycle-policy.json`

## Notes

- Root `cloudformation.yaml` is kept as a compatibility link for existing commands.
- Root `parameters.json` remains the local override file used by deployment when present.
- The deploy script applies the ECR lifecycle policy to each image repository, retaining only the two newest images.
