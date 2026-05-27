# Remote Dev Bridge Service (Repo-Agnostic)

A Node.js HTTP service that lets a Linux-based coding agent trigger and monitor workflows on a remote machine (including macOS) without local Xcode tooling.

The service:
- discovers available workflows in any target repo at runtime
- runs only allowlisted command keys (`setup`, `checks`, `build`, `tests`, `launch`, `pr`, `logs`, `doctor` by default)
- executes only allowlisted tools directly, plus discovered repo-local scripts
- executes jobs asynchronously with queueing, cancellation, timeout, and per-job isolated workspace
- streams logs and exposes artifacts through HTTP

## What makes it repo-agnostic

You provide a `repoPath` when creating a job. The service then discovers commands from:
- `package.json` scripts
- `Makefile` targets
- shell harness scripts such as `scripts/harness/*.sh` and `Scripts/harness/*.sh`
- common script files (for example `scripts/test.sh`)

If a command key is not discoverable, the API returns a clear `not found` error.

## Quick start

## 1) Install

```bash
npm install
cp .env.example .env
```

## 2) Configure

Set a real token in `.env`:

```bash
API_TOKEN=replace-with-strong-token
```

## 3) Run

```bash
npm start
```

Service default: `http://localhost:3000`

## Common flow

1. Check service health.
2. Discover repo workflows (`/discover`).
3. Start job (`POST /jobs`).
4. Track status (`GET /jobs/:id`).
5. Read or stream logs (`GET /jobs/:id/logs`).
6. Fetch artifacts (`GET /jobs/:id/artifacts`).
7. Cancel if needed (`POST /jobs/:id/cancel`).

## Security model

- Token auth (`Authorization: Bearer <API_TOKEN>`)
- Command key allowlist only (no arbitrary shell endpoint)
- Executable allowlist only for non-script commands: `swift`, `xcodebuild`, `xcrun`, `bundle`, `make`, `npm`, `pnpm`, `yarn`, `bun`
- Script execution is limited to discovered repo-local workflow files
- Environment variable filtering (`ALLOWED_ENV_*`)
- Secret redaction in logs
- In-memory rate limiting

## Deterministic execution behavior

Each job runs in an isolated workspace under `WORK_ROOT/<job-id>` with:
- fixed repo checkout/copy path (`.../repo`)
- fixed derived data path (`.../derived-data`)
- explicit simulator env hints when provided (`deterministic.simulatorName`, `deterministic.simulatorOS`)

## API reference

See [API.md](/task-workspaces/z4fi8BH5uiWftfztCuA-Q/docs/API.md).

## Example requests

Replace:
- `TOKEN` with your API token
- `/path/to/repo` with the target repository path on the remote machine

### Health

```bash
curl http://localhost:3000/health
```

### Capabilities (tool availability)

```bash
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/capabilities
```

### Discovery

```bash
curl -G -H "Authorization: Bearer TOKEN" \
  --data-urlencode "repoPath=/path/to/repo" \
  http://localhost:3000/discover
```

Example response shape:

```json
{
  "repoPath": "/path/to/repo",
  "repoRoot": "/path/to/repo",
  "repoType": "swift",
  "packageManager": "unknown",
  "commands": {
    "setup": {
      "path": "/path/to/repo/scripts/harness/setup.sh",
      "type": "script",
      "exists": true,
      "executable": true
    }
  },
  "missingRecommended": ["launch"],
  "hints": [
    "Detected a Swift package manifest.",
    "Detected shell harness scripts under scripts/harness."
  ]
}
```

### Start a job

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "commandKey": "tests",
    "repoPath": "/path/to/repo",
    "repoRef": "main",
    "args": ["--verbose"],
    "timeoutMs": 1800000,
    "idempotencyKey": "sample-tests-main-001",
    "env": {
      "CI": "1",
      "SIMULATOR_DEVICE_NAME": "iPhone 16"
    },
    "deterministic": {
      "simulatorName": "iPhone 16",
      "simulatorOS": "iOS-18-5"
    }
  }'
```

### Check job status

```bash
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/jobs/<job-id>
```

### Read logs (paginated)

```bash
curl -H "Authorization: Bearer TOKEN" \
  "http://localhost:3000/jobs/<job-id>/logs?offset=0&limit=200"
```

### Stream logs (SSE)

```bash
curl -N -H "Authorization: Bearer TOKEN" \
  "http://localhost:3000/jobs/<job-id>/logs?follow=true"
```

### List artifacts

```bash
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/jobs/<job-id>/artifacts
```

### Download one artifact

```bash
curl -L -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/jobs/<job-id>/artifacts/<artifact-id> \
  -o artifact.out
```

### Cancel a running or queued job

```bash
curl -X POST -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/jobs/<job-id>/cancel
```

## Notes

- `/health` is open by default for liveness checks.
- Completed job workspaces are removed after `JOB_RETENTION_MS`.
- Artifacts become unavailable after cleanup.
