# Standalone Load Runner

Deploy this folder as a separate Railway/Leapcell service.

## Local

```bash
cd load-runner
npm install
npm run ui
```

Open `http://localhost:3366`.

## Railway

- Root directory: `load-runner`
- Build command: `npm install`
- Start command: `npm run ui`
- Port: `3366` (or use Railway `PORT` env)

Notes:
- Live preview is now served from the same public service URL at `/dashboard` (no second public port needed).
- `DASHBOARD_PORT` is internal for the child runner process only.
- For `k6` and `hybrid` modes on Railway, deploy with the provided `Dockerfile` so `k6` is installed.
- For `headed test` on Railway, deploy with the provided `Dockerfile`; it includes `xvfb`, and the runner will use `xvfb-run` automatically when no display is present.
- In no-display runtimes, headed concurrency is auto-capped to `10` by default (override with `HEADED_SAFE_MAX_CONCURRENT` env if needed).

Required in UI when starting browser tests:
- `Register URL`
- `Users File` (default `e2e/prod-load/live-users.500.csv`)

Use mode selector:
- headed test
- headless test
- hybrid (browser + k6)
- k6 test
# load-test
# load-test
