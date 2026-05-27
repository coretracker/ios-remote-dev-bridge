# API Reference

Base URL: `http://<host>:<port>`

Auth: `Authorization: Bearer <API_TOKEN>` for all endpoints except `GET /health`.

## Status values

Jobs return one of:
- `queued`
- `running`
- `passed`
- `failed`
- `canceled`

## 1) `GET /health`

Basic service health and metrics.

Example:

```bash
curl http://localhost:3000/health
```

## 2) `GET /capabilities`

Returns command allowlist, executable allowlist, and tool availability/version info for:
- `swift`
- `xcodebuild`
- `xcrun`
- `bundle`

Example:

```bash
curl -H "Authorization: Bearer TOKEN" http://localhost:3000/capabilities
```

## 3) `GET /discover?repoPath=...`

Discovers workflows in a repository and maps canonical command keys.

Query params:
- `repoPath` (required): path to target repo on server machine

Response includes:
- repo root
- detected package manager
- discovered command mappings
- `missing` keys with actionable not-found messages

Example:

```bash
curl -G -H "Authorization: Bearer TOKEN" \
  --data-urlencode "repoPath=/path/to/repo" \
  http://localhost:3000/discover
```

## 4) `POST /jobs`

Starts an async job.

Body:
- `commandKey` (required): one of allowlisted command keys
- `repoPath` (required)
- `repoRef` (optional): branch/tag/commit for git repos
- `args` (optional): array of additional args
- `env` (optional): object, filtered by allow rules
- `timeoutMs` (optional): clamped by `MAX_TIMEOUT_MS`
- `idempotencyKey` (optional): deduplicates identical requests
- `deterministic` (optional object)
- `deterministic.simulatorName` (optional)
- `deterministic.simulatorOS` (optional)

Example:

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "commandKey": "build",
    "repoPath": "/path/to/repo",
    "repoRef": "main",
    "args": [],
    "env": { "CI": "1" },
    "timeoutMs": 1200000,
    "idempotencyKey": "build-main-0001"
  }'
```

## 5) `GET /jobs/:id`

Returns current job status, exit code, timing, and error details (if failed).

Example:

```bash
curl -H "Authorization: Bearer TOKEN" http://localhost:3000/jobs/<job-id>
```

## 6) `GET /jobs/:id/logs`

Returns logs.

Query params:
- `offset` (optional, default `0`)
- `limit` (optional, default `200`)
- `format` (optional: `json` or `text`, default `json`)
- `follow` (optional: `true/false`) for live stream (SSE)

Examples:

```bash
curl -H "Authorization: Bearer TOKEN" \
  "http://localhost:3000/jobs/<job-id>/logs?offset=0&limit=200"
```

```bash
curl -N -H "Authorization: Bearer TOKEN" \
  "http://localhost:3000/jobs/<job-id>/logs?follow=true"
```

## 7) `GET /jobs/:id/artifacts`

Lists artifacts for a job.

Example:

```bash
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/jobs/<job-id>/artifacts
```

## 8) `GET /jobs/:id/artifacts/:artifactId`

Downloads a single artifact.
- files are downloaded directly
- directory artifacts are streamed as `.tar.gz`

Example:

```bash
curl -L -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/jobs/<job-id>/artifacts/<artifact-id> \
  -o artifact.out
```

## 9) `POST /jobs/:id/cancel`

Cancels queued or running jobs.

Example:

```bash
curl -X POST -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/jobs/<job-id>/cancel
```

## Common error messages

- `401 Unauthorized`: invalid/missing token
- `429 Rate limit exceeded`: too many requests in current window
- `Command key '<key>' is not in allowlist`: blocked by allowlist
- `No workflow found for '<key>'`: repo discovery could not map that command
- `Executable '<name>' is not allowed`: resolved command is outside allowed tools
- `Repository path does not exist`: invalid `repoPath`
- `Unable to checkout ref`: invalid git ref in `repoRef`
