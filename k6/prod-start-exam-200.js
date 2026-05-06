import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  buildStudentSlice,
  bootstrapStudentSession,
  clampInt,
  csrfHeader,
  ensureProdRunAllowed,
  ensureStudentRegistrations,
  getStudentSession,
  jsonHeaders,
  loginControlStaff,
  readJson,
  resolveBaseUrl,
  resolveScheduleId,
  shouldAutoRegisterStudents,
  uuidV4,
} from './prod-load-helpers.js';

const EXPECT_2XX_OR_409 = http.expectedStatuses({ min: 200, max: 299 }, 409);
const DEBUG = __ENV.K6_DEBUG === 'true';
const bodyPreview = (resp) => String((resp && resp.body) || '').slice(0, 200);

const startExamPropagationMs = new Trend('start_exam_propagation_ms', true);
const startExamLatencyFailures = new Counter('start_exam_latency_failures');
const startExamSeenLive = new Rate('start_exam_seen_live');
const startExamMissingData = new Counter('start_exam_missing_data');

const targetPath = __ENV.K6_TARGET_PATH || '../e2e/prod-data/prod-target.json';
const credsPath = __ENV.K6_CREDS_PATH || '../e2e/prod-data/prod-creds.json';
const target = readJson(targetPath);
const creds = readJson(credsPath);
const baseUrl = resolveBaseUrl(target);
const scheduleId = resolveScheduleId(target);
const runId = __ENV.K6_RUN_ID || `k6-${Date.now()}`;
const { students, studentCount } = buildStudentSlice(target, __ENV.K6_STUDENTS || '200', __ENV.K6_STUDENT_OFFSET || '0');
const waitForCheckedInTimeoutSeconds = clampInt(__ENV.K6_CHECKED_IN_TIMEOUT_SECONDS || '900', 30, 7200);
const liveWaitTimeoutSeconds = clampInt(__ENV.K6_WAIT_FOR_LIVE_TIMEOUT_SECONDS || '1200', 30, 7200);
const startOffsetSeconds = clampInt(__ENV.K6_START_AT_OFFSET_SECONDS || '45', 5, 3600);
const pollSeconds = Number(__ENV.K6_STUDENT_POLL_SECONDS || '0.5');
const controlWarmupSeconds = clampInt(__ENV.K6_CONTROL_WARMUP_SECONDS || '5', 0, 300);

export const options = {
  scenarios: {
    control: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      exec: 'controlFlow',
      maxDuration: '30m',
    },
    students: {
      executor: 'per-vu-iterations',
      vus: studentCount,
      iterations: 1,
      exec: 'studentFlow',
      maxDuration: '30m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    start_exam_propagation_ms: ['max<2000'],
    start_exam_latency_failures: ['count==0'],
    start_exam_missing_data: ['count==0'],
  },
};

export function setup() {
  ensureProdRunAllowed();
  if (shouldAutoRegisterStudents()) {
    ensureStudentRegistrations(baseUrl, scheduleId, creds, students, true);
  }
  return {
    baseUrl,
    scheduleId,
    runId,
    students,
    studentCount,
    startAtMs: Date.now() + startOffsetSeconds * 1000,
  };
}

export function controlFlow(data) {
  const { jar, selectedStaffEmail } = loginControlStaff(data.baseUrl, data.scheduleId, creds, true);
  if (DEBUG) console.log(`[control] staff=${selectedStaffEmail || 'unknown'} scheduleId=${data.scheduleId} runId=${data.runId}`);

  const joinResp = http.post(
    `${data.baseUrl}/api/v1/proctor/sessions/${data.scheduleId}/presence`,
    JSON.stringify({ action: 'join' }),
    {
      jar,
      headers: jsonHeaders(csrfHeader(jar, data.baseUrl)),
      tags: { name: 'proctor_presence_join' },
    },
  );
  check(joinResp, { 'proctor presence join 200': (r) => r.status === 200 }) ||
    fail(
      `Presence join failed (staff=${selectedStaffEmail || 'unknown'}): status=${joinResp.status} body=${bodyPreview(joinResp)}`,
    );

  const expectedEmails = new Set(data.students.map((s) => s.email));
  const threshold = clampInt(__ENV.K6_CHECKED_IN_THRESHOLD || `${data.studentCount}`, 0, data.studentCount);
  const checkedInStartedAt = Date.now();
  while (Date.now() - checkedInStartedAt < waitForCheckedInTimeoutSeconds * 1000) {
    const detail = http.get(`${data.baseUrl}/api/v1/proctor/sessions/${data.scheduleId}`, {
      jar,
      headers: jsonHeaders(csrfHeader(jar, data.baseUrl)),
      tags: { name: 'proctor_session_detail' },
    });
    if (detail.status !== 200) {
      sleep(2);
      continue;
    }
    const json = detail.json();
    const sessions = ((json || {}).data || {}).sessions || [];
    if (!Array.isArray(sessions)) {
      sleep(2);
      continue;
    }
    const matched = sessions.filter((s) => expectedEmails.has(String(s.studentEmail || '')));
    if (DEBUG) console.log(`[control] roster matched=${matched.length}/${threshold} total=${sessions.length}`);
    if (matched.length >= threshold) break;
    sleep(2);
  }

  while (Date.now() < data.startAtMs) {
    sleep(1);
  }
  if (controlWarmupSeconds > 0) sleep(controlWarmupSeconds);

  const startResp = http.post(
    `${data.baseUrl}/api/v1/schedules/${data.scheduleId}/runtime/commands`,
    JSON.stringify({ action: 'start_runtime', reason: `k6 ${data.runId}` }),
    {
      jar,
      headers: jsonHeaders(csrfHeader(jar, data.baseUrl)),
      responseCallback: EXPECT_2XX_OR_409,
      tags: { name: 'start_runtime' },
    },
  );
  check(startResp, {
    'runtime start 200/409 ok': (r) => r.status === 200 || r.status === 409,
  }) || fail(`Start runtime failed: status=${startResp.status} body=${bodyPreview(startResp)}`);

  const liveStartedAt = Date.now();
  while (Date.now() - liveStartedAt < liveWaitTimeoutSeconds * 1000) {
    const runtime = http.get(`${data.baseUrl}/api/v1/schedules/${data.scheduleId}/runtime`, {
      jar,
      headers: jsonHeaders(csrfHeader(jar, data.baseUrl)),
      tags: { name: 'runtime_snapshot' },
    });
    if (runtime.status !== 200) {
      sleep(2);
      continue;
    }
    const json = runtime.json();
    const status = (((json || {}).data || {}).status || '').toString();
    if (status === 'live') break;
    if (status === 'completed' || status === 'cancelled') {
      fail(
        `Schedule runtime is already ${status} for scheduleId=${data.scheduleId}. Use a fresh schedule for each perf run.`,
      );
    }
    sleep(2);
  }
}

export function studentFlow(data) {
  const vuIndex = (__VU - 1) % data.students.length;
  const student = data.students[vuIndex];
  const jar = http.cookieJar();
  const clientSessionId = uuidV4();
  const jitterSeconds = clampInt(__ENV.K6_STUDENT_JITTER_MAX_SECONDS || '3', 0, 30);
  const jitter = (jitterSeconds > 0 && student.wcode) ? (Math.abs(student.wcode.charCodeAt(student.wcode.length - 1)) % jitterSeconds) : 0;
  sleep(jitter);

  const bootstrap = bootstrapStudentSession(data.baseUrl, data.scheduleId, student, jar, clientSessionId);
  const firstAttemptId = bootstrap.attemptId;
  let attemptToken = bootstrap.attemptToken;

  const pollResult = (() => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < liveWaitTimeoutSeconds * 1000) {
      const sessionResp = getStudentSession(data.baseUrl, data.scheduleId, jar, '', { name: 'student_session_wait' });
      if (sessionResp.status !== 200) {
        sleep(pollSeconds);
        continue;
      }
      const json = sessionResp.json();
      const session = (json && json.data) || {};
      const runtime = session.runtime || {};
      if (runtime.status === 'live') {
        return { session, json, runtime };
      }
      if (runtime.status === 'completed' || runtime.status === 'cancelled') {
        fail(`Student ${student.wcode} cannot start: runtime already ${runtime.status}.`);
      }
      sleep(pollSeconds);
    }
    fail(`Timed out waiting for live runtime for student ${student.wcode}`);
  })();

  const actualStartAt = Date.parse(String(pollResult.runtime.actualStartAt || '')) || 0;
  if (!actualStartAt) {
    startExamMissingData.add(1);
    fail(`Student ${student.wcode} saw live runtime without actualStartAt.`);
  }
  const latencyMs = Date.now() - actualStartAt;
  startExamPropagationMs.add(latencyMs);
  startExamSeenLive.add(true);
  if (latencyMs > 2000) {
    startExamLatencyFailures.add(1);
    fail(`Student ${student.wcode} saw live after ${latencyMs}ms, over the 2s limit.`);
  }

  const currentSectionKey = String(pollResult.runtime.currentSectionKey || '');
  if (!currentSectionKey) {
    startExamMissingData.add(1);
    fail(`Student ${student.wcode} missing currentSectionKey after runtime became live.`);
  }

  // Keep the attempt alive long enough to prove the waiting room transition did not corrupt state.
  const heartbeatResp = http.post(
    `${data.baseUrl}/api/v1/student/sessions/${data.scheduleId}/heartbeat`,
    JSON.stringify({
      attemptId: firstAttemptId,
      studentKey: '',
      clientSessionId,
      eventType: 'heartbeat',
      payload: null,
      clientTimestamp: new Date().toISOString(),
    }),
    {
      jar,
      headers: jsonHeaders({
        authorization: `Bearer ${attemptToken}`,
      }),
      tags: { name: 'heartbeat' },
    },
  );
  check(heartbeatResp, { 'post-live heartbeat ok': (r) => r.status === 200 }) || fail(`Heartbeat failed for ${student.wcode}`);
}
