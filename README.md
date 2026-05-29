# Remote Dev Bridge Service

HTTP service for running repo workflows on a remote machine, including macOS machines used for Swift or Xcode work.

## What it does

- Finds common repo workflows at runtime.
- Lets agents run only approved command keys such as `setup`, `checks`, `build`, `tests`, `launch`, and `pr`.
- Supports package scripts, Make targets, and repo-local shell scripts.
- Runs jobs in isolated work folders.
- Exposes job status, logs, artifacts, and cancellation over HTTP.

## What it can discover

The service checks a repo for:

- `package.json` scripts
- `Makefile` targets
- all `*.sh` files under `Scripts/` or `scripts/` (recursive)

Recognized command keys:

- `setup`
- `checks`
- `build`
- `tests`
- `launch`
- `pr`
- `logs`
- `doctor`

If a command key is not found, the API explains what was checked and how to fix it.

## Security model

- Token auth with `Authorization: Bearer <API_TOKEN>`
- No arbitrary shell endpoint
- Non-script commands are limited to approved tools such as `swift`, `xcodebuild`, `xcrun`, `bundle`, and `swiftformat`
- Script execution is limited to discovered repo-local workflow files
- Environment variables are filtered
- Sensitive values are hidden in logs
- Basic rate limiting is enabled

## How jobs run

Each job runs in its own workspace under `WORK_ROOT/<job-id>`.

- By default, commands run in the original repo folder you passed in
- If `repoRef` is requested, the bridge makes its own checkout under `.../repo`
- Derived data goes into `.../derived-data`
- Optional simulator hints can be passed through `deterministic.simulatorName` and `deterministic.simulatorOS`

## Quick start

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Configure

Set a real API token in `.env`:

```bash
API_TOKEN=replace-with-strong-token
```

### 3. Run

```bash
npm start
```

Default address: `http://localhost:3000`

## Recommended agent flow

1. Call `GET /health`
2. Call `GET /discover?repoPath=...`
3. Choose a discovered command key
4. Call `POST /jobs`
5. Poll `GET /jobs/:id`
6. Read `GET /jobs/:id/logs`
7. Fetch `GET /jobs/:id/artifacts` if needed
8. Call `POST /jobs/:id/cancel` if needed

## Examples

Replace:

- `TOKEN` with your API token
- `/path/to/repo` with the repo path on the remote machine

### Health

```bash
curl http://localhost:3000/health
```

### Capabilities

```bash
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/capabilities
```

### Discover workflows

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
  "repoType": "swift",
  "packageManager": "unknown",
  "commands": {
    "setup": {
      "path": "/path/to/repo/Scripts/setup.sh",
      "type": "script",
      "exists": true,
      "executable": true
    }
  },
  "missingRecommended": ["launch"],
  "hints": [
    "Detected a Swift package manifest.",
    "Detected shell scripts under Scripts/."
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

Example response:

```json
{
  "reused": false,
  "job": {
    "id": "job_123",
    "status": "queued"
  }
}
```

Notes:

- `POST /jobs` returns `job.id`, not a top-level `jobId`
- early responses may still show empty `commandDisplay` and `repoRoot`

### Check job status

```bash
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/jobs/<job-id>
```

### Read logs

```bash
curl -H "Authorization: Bearer TOKEN" \
  "http://localhost:3000/jobs/<job-id>/logs?offset=0&limit=200"
```

### Stream logs

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

### Cancel a job

```bash
curl -X POST -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/jobs/<job-id>/cancel
```

## Notes

- `GET /health` is open by default
- completed job workspaces are removed after `JOB_RETENTION_MS`
- artifacts are no longer available after cleanup

## Full API reference

See [LLMs.txt](/task-workspaces/z4fi8BH5uiWftfztCuA-Q/docs/LLMs.txt).
