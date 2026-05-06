import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  bootstrapStudentSession,
  buildStudentSlice,
  clampInt,
  computeJitterSeconds,
  csrfHeader,
  ensureProdRunAllowed,
  ensureStudentRegistrations,
  getStudentSession,
  jsonHeaders,
  loginControlStaff,
  pickFirstQuestionId,
  pickFirstWritingTaskId,
  readJson,
  resolveBaseUrl,
  resolveScheduleId,
  sendHeartbeat,
  sendMutationBatch,
  shouldAutoRegisterStudents,
  uuidV4,
} from './prod-load-helpers.js';

const EXPECT_2XX_OR_409 = http.expectedStatuses({ min: 200, max: 299 }, 409);
const DEBUG = __ENV.K6_DEBUG === 'true';

const autoSubmitSubmittedAtMs = new Trend('auto_submit_submitted_at_ms', true);
const autoSubmitFailures = new Counter('auto_submit_failures');
const autoSubmitMissingData = new Counter('auto_submit_missing_data');

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
const workSeconds = clampInt(__ENV.K6_WORK_SECONDS || '10', 5, 1800);
const completeDelaySeconds = clampInt(__ENV.K6_COMPLETE_DELAY_SECONDS || '10', 5, 600);
const pollSeconds = Number(__ENV.K6_STUDENT_POLL_SECONDS || '0.5');
const heartbeatEverySeconds = clampInt(__ENV.K6_STUDENT_HEARTBEAT_SECONDS || '5', 3, 120);
const jitterSeconds = clampInt(__ENV.K6_STUDENT_JITTER_MAX_SECONDS || '2', 0, 30);

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
    auto_submit_failures: ['count==0'],
    auto_submit_missing_data: ['count==0'],
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
      fail(`Schedule runtime is already ${status}; use a fresh schedule for the auto-submit test.`);
    }
    sleep(2);
  }

  sleep(completeDelaySeconds);
  const completeResp = http.post(
    `${data.baseUrl}/api/v1/proctor/sessions/${data.scheduleId}/control/complete-exam`,
    JSON.stringify({ reason: `k6 ${data.runId} auto submit` }),
    {
      jar,
      headers: jsonHeaders(csrfHeader(jar, data.baseUrl)),
      responseCallback: EXPECT_2XX_OR_409,
      tags: { name: 'complete_exam' },
    },
  );
  check(completeResp, { 'complete exam ok': (r) => r.status === 200 || r.status === 409 }) ||
    fail(`complete-exam failed: status=${completeResp.status} body=${completeResp.body.slice(0, 200)}`);
}

export function studentFlow(data) {
  const student = data.students[(__VU - 1) % data.students.length];
  const jar = http.cookieJar();
  const clientSessionId = uuidV4();
  const jitter = computeJitterSeconds(runId, student.wcode, jitterSeconds);
  sleep(jitter);

  const bootstrap = bootstrapStudentSession(data.baseUrl, data.scheduleId, student, jar, clientSessionId);
  let attemptToken = bootstrap.attemptToken;
  const attemptId = bootstrap.attemptId;
  const firstQuestionId = pickFirstQuestionId(bootstrap.contentSnapshot);
  const firstWritingTaskId = pickFirstWritingTaskId(bootstrap.contentSnapshot);

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

  const workStartedAt = Date.now();
  let lastHeartbeatAt = 0;
  let mutationSent = false;
  const answerValue = `k6 ${runId} ${student.wcode} auto-submit`;
  const writingValue = `k6 ${runId} ${student.wcode} auto-submit-writing`;
  while (Date.now() - workStartedAt < workSeconds * 1000) {
    const now = Date.now();
    if (!mutationSent) {
      const mutations = [
        {
          id: uuidV4(),
          seq: 1,
          timestamp: new Date().toISOString(),
          mutationType: 'position',
          payload: {
            phase: 'exam',
            currentModule: 'reading',
            currentQuestionId: firstQuestionId || null,
          },
        },
      ];
      if (firstQuestionId) {
        mutations.push({
          id: uuidV4(),
          seq: 2,
          timestamp: new Date().toISOString(),
          mutationType: 'answer',
          payload: { questionId: firstQuestionId, value: answerValue },
        });
      }
      if (firstWritingTaskId) {
        mutations.push({
          id: uuidV4(),
          seq: 3,
          timestamp: new Date().toISOString(),
          mutationType: 'writing_answer',
          payload: { taskId: firstWritingTaskId, value: writingValue },
        });
      }
      const mutationResp = sendMutationBatch(
        data.baseUrl,
        data.scheduleId,
        jar,
        attemptId,
        attemptToken,
        clientSessionId,
        mutations,
        { name: 'mutations_batch' },
      );
      if (mutationResp.status === 200) {
        try {
          const json = mutationResp.json();
          const refreshed = (((json || {}).data || {}).refreshedAttemptCredential || {}).attemptToken;
          if (refreshed) attemptToken = refreshed;
        } catch (_) {}
      }
      mutationSent = true;
    }

    if (now - lastHeartbeatAt > heartbeatEverySeconds * 1000) {
      lastHeartbeatAt = now;
      const hbResp = sendHeartbeat(
        data.baseUrl,
        data.scheduleId,
        jar,
        attemptId,
        attemptToken,
        clientSessionId,
        { name: 'heartbeat' },
      );
      if (hbResp.status === 200) {
        try {
          const json = hbResp.json();
          const refreshed = (((json || {}).data || {}).refreshedAttemptCredential || {}).attemptToken;
          if (refreshed) attemptToken = refreshed;
        } catch (_) {}
      }
    }

    sleep(1);
  }

  const submitWait = (() => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 180 * 1000) {
      const sessionResp = getStudentSession(data.baseUrl, data.scheduleId, jar, '', { name: 'student_session_verify' });
      if (sessionResp.status !== 200) {
        sleep(1);
        continue;
      }
      const json = sessionResp.json();
      const session = (json && json.data) || {};
      const attempt = session.attempt || {};
      if (attempt.submittedAt) return attempt;
      if (String((session.runtime || {}).status || '') === 'completed' && attempt.submittedAt) return attempt;
      sleep(1);
    }
    fail(`Timed out waiting for auto-submit for student ${student.wcode}`);
  })();

  const submittedAt = Date.parse(String(submitWait.submittedAt || '')) || 0;
  if (!submittedAt) {
    autoSubmitMissingData.add(1);
    fail(`Student ${student.wcode} missing submittedAt after complete-exam.`);
  }
  autoSubmitSubmittedAtMs.add(Date.now() - submittedAt);

  const answers = submitWait.answers || {};
  const writingAnswers = submitWait.writingAnswers || {};
  const answerOk = !firstQuestionId || String(answers[firstQuestionId] || '') === answerValue;
  const writingOk = !firstWritingTaskId || String(writingAnswers[firstWritingTaskId] || '') === writingValue;
  const finalSubmissionOk = Boolean(submitWait.finalSubmission);

  if (!answerOk || !writingOk || !finalSubmissionOk) {
    autoSubmitFailures.add(1);
    fail(
      `Auto-submit correctness mismatch for ${student.wcode}: answerOk=${answerOk} writingOk=${writingOk} finalSubmissionOk=${finalSubmissionOk}`,
    );
  }
}
