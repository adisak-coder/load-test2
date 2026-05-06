# k6 Prod Load Suite

This folder contains API-level production load tests for the IELTS proctoring flow.
The scripts drive the same backend endpoints as the UI, so they are useful for latency, throughput, and data-consistency checks.

Important limits:
- k6 does not validate browser rendering, permissions, or client routing.
- These runs mutate real schedule/runtime state.
- Use a dedicated production E2E tenant and a dedicated schedule per scenario run.

## Scenarios

- `k6/prod-start-exam-200.js`
  - 200 students in the waiting room
  - measures propagation from `runtime.actualStartAt` to student visibility of `live`
  - threshold: `start_exam_propagation_ms max < 2000`

- `k6/prod-section-transition-200.js`
  - 200 students
  - uses proctor `end-section-now` as the proxy for section-zero transition
  - threshold: `section_transition_ms max < 2000`
  - requires a schedule that accepts section override actions; authentic IELTS mode rejects the endpoint

- `k6/prod-submit-storm-200.js`
  - 200 students
  - near-simultaneous submit storm
  - thresholds: `submit_request_ms p(95) < 2000`, `submit_request_ms max < 10000`
  - verifies `attempt.submittedAt`, `answers`, `writingAnswers`, and `finalSubmission`

- `k6/prod-resume-100.js`
  - 100 students
  - simulates browser close by pausing requests, then refreshing attempt credentials with a new `clientSessionId`
  - verifies attempt identity and prior state survive the resume path

- `k6/prod-auto-submit-200.js`
  - 200 students
  - proctor completes the exam and the backend auto-submits the cohort
  - verifies `attempt.submittedAt` and `finalSubmission`

## Data

- `e2e/prod-data/prod-target.json` contains the non-secret target data, including 200 students.
- `e2e/prod-data/prod-creds.json` contains the login secrets and remains untracked.

## Safety gate

Set `K6_CONFIRM_PROD=true` before running any scenario. The scripts refuse to run without it.

## Common overrides

- `K6_BASE_URL` defaults to `prod-target.json.baseURL`
- `K6_SCHEDULE_ID` defaults to `prod-target.json.scheduleId`
- `K6_REGISTER_URL` can be set to a student registration link like `/student/<scheduleId>/register`; the scripts derive both base URL and schedule ID from it
- `K6_AUTO_REGISTER=true` enables a pre-registration bootstrap step before the load test starts
- `K6_TARGET_PATH` defaults to `e2e/prod-data/prod-target.json`
- `K6_CREDS_PATH` defaults to `e2e/prod-data/prod-creds.json`
- `K6_STUDENTS` controls the student count for each run
- `K6_STUDENT_OFFSET` slices into the student list for smaller shards
- `K6_RUN_ID` labels the run in logs and request reasons
- `K6_DEBUG=true` enables extra logging

## Typical runs

Start exam:

```bash
K6_CONFIRM_PROD=true \
K6_STUDENTS=200 \
K6_CHECKED_IN_THRESHOLD=200 \
k6 run k6/prod-start-exam-200.js
```

Section transition:

```bash
K6_CONFIRM_PROD=true \
K6_STUDENTS=200 \
K6_CHECKED_IN_THRESHOLD=200 \
k6 run k6/prod-section-transition-200.js
```

Submit storm:

```bash
K6_CONFIRM_PROD=true \
K6_STUDENTS=200 \
K6_CHECKED_IN_THRESHOLD=200 \
k6 run k6/prod-submit-storm-200.js
```

Resume after browser close:

```bash
K6_CONFIRM_PROD=true \
K6_STUDENTS=100 \
K6_CHECKED_IN_THRESHOLD=100 \
k6 run k6/prod-resume-100.js
```

Auto-submit:

```bash
K6_CONFIRM_PROD=true \
K6_STUDENTS=200 \
K6_CHECKED_IN_THRESHOLD=200 \
k6 run k6/prod-auto-submit-200.js
```

Run with Playwright live runner together:

```bash
K6_CONFIRM_PROD=true \
K6_SCRIPT=k6/prod-start-exam-200.js \
REGISTER_URL="https://your-host/student/<scheduleId>/register" \
USERS_FILE="e2e/prod-load/live-users.500.csv" \
USER_COUNT=100 \
npm run e2e:live-with-k6
```

Notes:
- `e2e:live-with-k6` starts k6 in background, then runs Playwright live runner.
- Override k6 scenario with `K6_SCRIPT=...` (default `k6/prod-start-exam-200.js`).
- Logs are written automatically:
  - k6: `e2e/.generated/live-runner/k6-<timestamp>.log`
  - live runner events: `e2e/.generated/live-runner/live-runner-<timestamp>.log`

## Notes

- The scripts assume the schedule is assigned to at least one proctor/editor account in `prod-creds.json`.
- If you reuse the same schedule for multiple scenarios, later runs will not be meaningful because the earlier run mutates runtime state.
- The section-transition scenario intentionally relies on `end-section-now`; if the backend returns a validation error about IELTS authentic mode, use a schedule that allows section overrides.
