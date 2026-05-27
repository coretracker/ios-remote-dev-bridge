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
- `make`
- `npm`
- `pnpm`
- `yarn`
- `bun`

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
- repo type (`swift`, `xcode`, `mixed`, `node`, or `unknown`)
- detected package manager
- discovered command mappings
- per-command metadata including resolved path, execution type, and executable bit
- `missing` keys with actionable not-found messages and checked paths
- `missingRecommended` for expected command keys that were not found
- `hints` describing what repo signals were detected

Recognized command keys:
- `setup`
- `checks`
- `build`
- `tests`
- `launch`
- `pr`
- `logs`
- `doctor`

Discovery checks:
- `package.json` scripts
- `Makefile` targets
- `scripts/harness/*.sh`
- `Scripts/harness/*.sh`
- common fallback scripts such as `scripts/setup.sh`, `scripts/check.sh`, and `scripts/test.sh`

Example:

```bash
curl -G -H "Authorization: Bearer TOKEN" \
  --data-urlencode "repoPath=/path/to/repo" \
  http://localhost:3000/discover
```

Example response:

```json
{
  "repoPath": "/path/to/repo",
  "repoRoot": "/path/to/repo",
  "repoType": "xcode",
  "packageManager": "unknown",
  "commands": {
    "checks": {
      "source": "script-file",
      "sourceId": "Scripts/harness/check.sh",
      "type": "script",
      "path": "/path/to/repo/Scripts/harness/check.sh",
      "relativePath": "Scripts/harness/check.sh",
      "exists": true,
      "executable": true,
      "display": "./Scripts/harness/check.sh"
    }
  },
  "missingRecommended": ["launch", "pr"],
  "hints": [
    "Detected Xcode project/workspace files.",
    "Detected shell harness scripts under Scripts/harness."
  ]
}
```

## 4) `POST /jobs`

Starts an async job.

If the discovered workflow is a repo-local shell script, the bridge runs that script directly from the repo root. It does not provide arbitrary shell execution.

Body:
- `commandKey` (required): one of `setup`, `checks`, `build`, `tests`, `launch`, `pr`, `logs`, `doctor`
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
- `Repository path is not a directory`: `repoPath` points at a file, not a repo folder
- `Workflow '<key>' was found at '<path>', but it is not executable`: make the script executable and retry
- `Unable to checkout ref`: invalid git ref in `repoRef`
