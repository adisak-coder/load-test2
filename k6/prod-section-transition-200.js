import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
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

const sectionTransitionMs = new Trend('section_transition_ms', true);
const sectionTransitionFailures = new Counter('section_transition_failures');
const sectionTransitionMissingData = new Counter('section_transition_missing_data');

const targetPath = __ENV.K6_TARGET_PATH || '../e2e/prod-data/prod-target.json';
const credsPath = __ENV.K6_CREDS_PATH || '../e2e/prod-data/prod-creds.json';
const target = readJson(targetPath);
const creds = readJson(credsPath);
const baseUrl = resolveBaseUrl(target);
const scheduleId = resolveScheduleId(target);
const runId = __ENV.K6_RUN_ID || `k6-${Date.now()}`;
const { students, studentCount } = (function slice() {
  const allStudents = target.students || [];
  const count = clampInt(__ENV.K6_STUDENTS || '200', 1, allStudents.length || 1);
  const offset = clampInt(__ENV.K6_STUDENT_OFFSET || '0', 0, Math.max(0, (allStudents.length || 1) - 1));
  const sliced = allStudents.slice(offset, offset + count);
  if (sliced.length !== count) {
    throw new Error(`Not enough students for K6_STUDENTS=${count} at K6_STUDENT_OFFSET=${offset}`);
  }
  return { students: sliced, studentCount: count };
})();
const liveWaitTimeoutSeconds = clampInt(__ENV.K6_WAIT_FOR_LIVE_TIMEOUT_SECONDS || '1200', 30, 7200);
const sectionDelaySeconds = clampInt(__ENV.K6_SECTION_TRANSITION_DELAY_SECONDS || '15', 5, 600);
const transitionWaitTimeoutSeconds = clampInt(__ENV.K6_SECTION_TRANSITION_TIMEOUT_SECONDS || '900', 30, 7200);
const pollSeconds = Number(__ENV.K6_STUDENT_POLL_SECONDS || '0.5');

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
    section_transition_ms: ['max<2000'],
    section_transition_failures: ['count==0'],
    section_transition_missing_data: ['count==0'],
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
    fail(`Presence join failed: status=${joinResp.status} body=${joinResp.body.slice(0, 200)}`);

  const threshold = clampInt(__ENV.K6_CHECKED_IN_THRESHOLD || `${data.studentCount}`, 0, data.studentCount);
  const expectedEmails = new Set(data.students.map((s) => s.email));
  const checkedInStartedAt = Date.now();
  while (Date.now() - checkedInStartedAt < liveWaitTimeoutSeconds * 1000) {
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
    const matched = Array.isArray(sessions) ? sessions.filter((s) => expectedEmails.has(String(s.studentEmail || ''))) : [];
    if (matched.length >= threshold) break;
    sleep(2);
  }

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
  check(startResp, { 'start runtime ok': (r) => r.status === 200 || r.status === 409 }) ||
    fail(`Start runtime failed: status=${startResp.status} body=${startResp.body.slice(0, 200)}`);

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
      fail(`Schedule runtime is already ${status}; use a fresh schedule for the section transition test.`);
    }
    sleep(2);
  }

  if (sectionDelaySeconds > 0) sleep(sectionDelaySeconds);

  const commandResp = http.post(
    `${data.baseUrl}/api/v1/proctor/sessions/${data.scheduleId}/control/end-section-now`,
    JSON.stringify({
      reason: `k6 ${data.runId} section transition`,
    }),
    {
      jar,
      headers: jsonHeaders(csrfHeader(jar, data.baseUrl)),
      responseCallback: EXPECT_2XX_OR_409,
      tags: { name: 'end_section_now' },
    },
  );
  check(commandResp, { 'end section now ok': (r) => r.status === 200 || r.status === 409 }) ||
    fail(`end-section-now failed: status=${commandResp.status} body=${commandResp.body.slice(0, 200)}`);
}

export function studentFlow(data) {
  const student = data.students[(__VU - 1) % data.students.length];
  const jar = http.cookieJar();
  const clientSessionId = uuidV4();
  const bootstrap = bootstrapStudentSession(data.baseUrl, data.scheduleId, student, jar, clientSessionId);
  const attemptToken = bootstrap.attemptToken;

  const liveWait = (() => {
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
      if (runtime.status === 'live') return { session, runtime };
      sleep(pollSeconds);
    }
    fail(`Timed out waiting for live runtime for student ${student.wcode}`);
  })();

  const initialSectionKey = String(liveWait.runtime.currentSectionKey || '');
  if (!initialSectionKey) {
    sectionTransitionMissingData.add(1);
    fail(`Student ${student.wcode} missing currentSectionKey before transition.`);
  }

  const transitionWait = (() => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < transitionWaitTimeoutSeconds * 1000) {
      const sessionResp = getStudentSession(data.baseUrl, data.scheduleId, jar, '', { name: 'student_session_wait' });
      if (sessionResp.status !== 200) {
        sleep(pollSeconds);
        continue;
      }
      const json = sessionResp.json();
      const session = (json && json.data) || {};
      const runtime = session.runtime || {};
      const currentSectionKey = String(runtime.currentSectionKey || '');
      if (currentSectionKey && currentSectionKey !== initialSectionKey) {
        return { session, runtime };
      }
      if (runtime.status === 'completed' || runtime.status === 'cancelled') {
        fail(`Student ${student.wcode} saw terminal runtime before section transition.`);
      }
      sleep(pollSeconds);
    }
    fail(`Timed out waiting for section transition for student ${student.wcode}`);
  })();

  const updatedAt = Date.parse(String(transitionWait.runtime.updatedAt || '')) || 0;
  if (!updatedAt) {
    sectionTransitionMissingData.add(1);
    fail(`Student ${student.wcode} saw section change without updatedAt.`);
  }
  const latencyMs = Date.now() - updatedAt;
  sectionTransitionMs.add(latencyMs);
  if (latencyMs > 2000) {
    sectionTransitionFailures.add(1);
    fail(`Student ${student.wcode} saw section transition after ${latencyMs}ms, over the 2s limit.`);
  }
}
