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
  sendMutationBatch,
  shouldAutoRegisterStudents,
  uuidV4,
} from './prod-load-helpers.js';

const EXPECT_2XX_OR_409 = http.expectedStatuses({ min: 200, max: 299 }, 409);
const DEBUG = __ENV.K6_DEBUG === 'true';

const sectionTransitionMs = new Trend('transition_reconcile_section_ms', true);
const transitionReconcileMissingAnswers = new Counter('transition_reconcile_missing_answers');
const transitionReconcileFailures = new Counter('transition_reconcile_failures');
const transitionTypingBatchesSent = new Counter('transition_typing_batches_sent');
const transitionTypingBatchesAccepted = new Counter('transition_typing_batches_accepted');

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
const transitionWaitTimeoutSeconds = clampInt(__ENV.K6_SECTION_TRANSITION_TIMEOUT_SECONDS || '900', 30, 7200);
const sectionDelaySeconds = clampInt(__ENV.K6_SECTION_TRANSITION_DELAY_SECONDS || '15', 5, 600);
const typingCadenceMinMs = clampInt(__ENV.K6_TYPING_CADENCE_MIN_MS || '90', 10, 5000);
const typingCadenceMaxMs = clampInt(__ENV.K6_TYPING_CADENCE_MAX_MS || '240', typingCadenceMinMs, 5000);
const postTransitionTypingSeconds = clampInt(__ENV.K6_POST_TRANSITION_TYPING_SECONDS || '15', 1, 300);
const pollSeconds = Number(__ENV.K6_STUDENT_POLL_SECONDS || '0.5');

export const options = {
  scenarios: {
    control: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      exec: 'controlFlow',
      maxDuration: '40m',
    },
    students: {
      executor: 'per-vu-iterations',
      vus: studentCount,
      iterations: 1,
      exec: 'studentFlow',
      maxDuration: '40m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.03'],
    transition_reconcile_section_ms: ['max<5000'],
    transition_reconcile_missing_answers: ['count==0'],
    transition_reconcile_failures: ['count==0'],
  },
};

function randomCadenceSeconds() {
  const spread = typingCadenceMaxMs - typingCadenceMinMs;
  const ms = typingCadenceMinMs + Math.floor(Math.random() * (spread + 1));
  return ms / 1000;
}

function findFirstQuestionIdInBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  for (const block of blocks) {
    if (Array.isArray(block?.questions)) {
      for (const q of block.questions) {
        if (q && typeof q.id === 'string' && q.id.length > 0) return q.id;
      }
    }
    if (typeof block?.id === 'string' && block.id.length > 0 && String(block?.type || '').includes('MCQ')) {
      return block.id;
    }
  }
  return '';
}

function pickObjectiveQuestionIdForSection(contentSnapshot, sectionKey) {
  if (!contentSnapshot || typeof contentSnapshot !== 'object') return '';
  if (sectionKey === 'reading') {
    const passages = (((contentSnapshot.reading || {}).passages) || []);
    for (const passage of passages) {
      const found = findFirstQuestionIdInBlocks(passage?.blocks || []);
      if (found) return found;
    }
  }
  if (sectionKey === 'listening') {
    const parts = (((contentSnapshot.listening || {}).parts) || []);
    for (const part of parts) {
      const found = findFirstQuestionIdInBlocks(part?.blocks || []);
      if (found) return found;
    }
  }
  return '';
}

function pickWritingTaskId(contentSnapshot) {
  const tasks = (((contentSnapshot || {}).writing || {}).tasks) || [];
  for (const task of tasks) {
    const id = task?.id || task?.taskId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'task1';
}

function buildTarget(contentSnapshot, sectionKey) {
  if (sectionKey === 'writing') {
    return { kind: 'writing', id: pickWritingTaskId(contentSnapshot) };
  }
  const questionId = pickObjectiveQuestionIdForSection(contentSnapshot, sectionKey);
  if (!questionId) return null;
  return { kind: 'objective', id: questionId };
}

function readAttemptValue(attempt, targetRef) {
  if (!targetRef || !attempt) return null;
  if (targetRef.kind === 'writing') {
    const writingAnswers = attempt.writingAnswers || {};
    return writingAnswers[targetRef.id] ?? null;
  }
  const answers = attempt.answers || {};
  return answers[targetRef.id] ?? null;
}

function buildMutationCommand(targetRef, value) {
  if (targetRef.kind === 'writing') {
    return { type: 'SetEssayText', taskId: targetRef.id, value };
  }
  return { type: 'SetScalar', questionId: targetRef.id, value };
}

function sendTypingMutation(data, jar, attemptId, attemptToken, clientSessionId, revision, targetRef, value, tagSuffix) {
  const mutation = {
    mutationId: `${data.runId}-${targetRef.kind}-${targetRef.id}-${uuidV4()}`,
    baseRevision: Number(revision || 0),
    ...buildMutationCommand(targetRef, value),
  };
  transitionTypingBatchesSent.add(1);
  const resp = sendMutationBatch(
    data.baseUrl,
    data.scheduleId,
    jar,
    attemptId,
    attemptToken,
    clientSessionId,
    [mutation],
    { name: `typing_mutation_${tagSuffix}` },
  );
  const ok = resp.status === 200 || resp.status === 409;
  if (!ok) {
    transitionReconcileFailures.add(1);
    fail(`Mutation request failed: status=${resp.status} body=${String(resp.body || '').slice(0, 200)}`);
  }
  if (resp.status === 200) {
    transitionTypingBatchesAccepted.add(1);
  }
  return resp;
}

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
    fail(`Presence join failed: status=${joinResp.status} body=${String(joinResp.body || '').slice(0, 200)}`);

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
    fail(`Start runtime failed: status=${startResp.status} body=${String(startResp.body || '').slice(0, 200)}`);

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
      fail(`Schedule runtime is already ${status}; use a fresh schedule for the canary test.`);
    }
    sleep(2);
  }

  if (sectionDelaySeconds > 0) sleep(sectionDelaySeconds);

  const commandResp = http.post(
    `${data.baseUrl}/api/v1/proctor/sessions/${data.scheduleId}/control/end-section-now`,
    JSON.stringify({
      reason: `k6 ${data.runId} canary forced transition`,
    }),
    {
      jar,
      headers: jsonHeaders(csrfHeader(jar, data.baseUrl)),
      responseCallback: EXPECT_2XX_OR_409,
      tags: { name: 'end_section_now' },
    },
  );
  check(commandResp, { 'end section now ok': (r) => r.status === 200 || r.status === 409 }) ||
    fail(`end-section-now failed: status=${commandResp.status} body=${String(commandResp.body || '').slice(0, 200)}`);
}

export function studentFlow(data) {
  const student = data.students[(__VU - 1) % data.students.length];
  const jar = http.cookieJar();
  const clientSessionId = uuidV4();
  const bootstrap = bootstrapStudentSession(data.baseUrl, data.scheduleId, student, jar, clientSessionId);
  const attemptId = bootstrap.attemptId;
  const attemptToken = bootstrap.attemptToken;
  const contentSnapshot = bootstrap.contentSnapshot;

  const waitStartedAt = Date.now();
  let liveSession = null;
  while (Date.now() - waitStartedAt < liveWaitTimeoutSeconds * 1000) {
    const sessionResp = getStudentSession(data.baseUrl, data.scheduleId, jar, '', { name: 'student_session_wait' });
    if (sessionResp.status !== 200) {
      sleep(pollSeconds);
      continue;
    }
    const json = sessionResp.json();
    const session = (json && json.data) || {};
    if (String((session.runtime || {}).status || '') === 'live') {
      liveSession = session;
      break;
    }
    sleep(pollSeconds);
  }
  if (!liveSession) {
    fail(`Timed out waiting for live runtime for student ${student.wcode}`);
  }

  const initialSectionKey = String((liveSession.runtime || {}).currentSectionKey || '');
  if (!initialSectionKey) {
    transitionReconcileFailures.add(1);
    fail(`Missing initial currentSectionKey for ${student.wcode}`);
  }
  const initialTarget = buildTarget(contentSnapshot, initialSectionKey);
  if (!initialTarget) {
    transitionReconcileFailures.add(1);
    fail(`No mutation target found for initial section ${initialSectionKey} (${student.wcode})`);
  }

  let lastAcceptedInitialValue = null;
  let currentRevision = Number((liveSession.attempt || {}).revision || 0);
  const transitionStartedAt = Date.now();
  let transitionedSession = null;
  while (Date.now() - transitionStartedAt < transitionWaitTimeoutSeconds * 1000) {
    const value = `k6-${data.runId}-${student.wcode}-initial-${Date.now()}`;
    const mutationResp = sendTypingMutation(
      data,
      jar,
      attemptId,
      attemptToken,
      clientSessionId,
      currentRevision,
      initialTarget,
      value,
      'pre_transition',
    );
    if (mutationResp.status === 200) {
      lastAcceptedInitialValue = value;
      try {
        const parsed = mutationResp.json();
        currentRevision = Number((((parsed || {}).data || {}).revision) || currentRevision);
      } catch (_) {}
    }

    const sessionResp = getStudentSession(data.baseUrl, data.scheduleId, jar, '', { name: 'student_session_transition_poll' });
    if (sessionResp.status === 200) {
      const session = ((sessionResp.json() || {}).data) || {};
      const runtime = session.runtime || {};
      const currentSectionKey = String(runtime.currentSectionKey || '');
      if (currentSectionKey && currentSectionKey !== initialSectionKey) {
        transitionedSession = session;
        const updatedAt = Date.parse(String(runtime.updatedAt || '')) || 0;
        if (updatedAt > 0) {
          sectionTransitionMs.add(Date.now() - updatedAt);
        }
        break;
      }
      if (runtime.status === 'completed' || runtime.status === 'cancelled') {
        transitionReconcileFailures.add(1);
        fail(`Runtime became terminal before transition for ${student.wcode}`);
      }
      currentRevision = Number((session.attempt || {}).revision || currentRevision);
    }

    sleep(randomCadenceSeconds());
  }

  if (!transitionedSession) {
    transitionReconcileFailures.add(1);
    fail(`Timed out waiting for section transition for ${student.wcode}`);
  }

  const nextSectionKey = String((transitionedSession.runtime || {}).currentSectionKey || '');
  const nextTarget = buildTarget(contentSnapshot, nextSectionKey);
  let lastAcceptedNextValue = null;
  if (nextTarget) {
    const postTransitionDeadline = Date.now() + postTransitionTypingSeconds * 1000;
    while (Date.now() < postTransitionDeadline) {
      const value = `k6-${data.runId}-${student.wcode}-next-${Date.now()}`;
      const mutationResp = sendTypingMutation(
        data,
        jar,
        attemptId,
        attemptToken,
        clientSessionId,
        currentRevision,
        nextTarget,
        value,
        'post_transition',
      );
      if (mutationResp.status === 200) {
        lastAcceptedNextValue = value;
        try {
          const parsed = mutationResp.json();
          currentRevision = Number((((parsed || {}).data || {}).revision) || currentRevision);
        } catch (_) {}
      }
      sleep(randomCadenceSeconds());
    }
  }

  const finalSessionResp = getStudentSession(data.baseUrl, data.scheduleId, jar, '', { name: 'student_session_final_verify' });
  if (finalSessionResp.status !== 200) {
    transitionReconcileFailures.add(1);
    fail(`Final session fetch failed (${student.wcode}): status=${finalSessionResp.status}`);
  }
  const finalSession = ((finalSessionResp.json() || {}).data) || {};
  const finalAttempt = finalSession.attempt || {};

  if (lastAcceptedInitialValue !== null) {
    const stored = readAttemptValue(finalAttempt, initialTarget);
    if (stored !== lastAcceptedInitialValue) {
      transitionReconcileMissingAnswers.add(1);
      fail(`Initial section answer missing for ${student.wcode}: expected=${lastAcceptedInitialValue} got=${stored}`);
    }
  }
  if (nextTarget && lastAcceptedNextValue !== null) {
    const stored = readAttemptValue(finalAttempt, nextTarget);
    if (stored !== lastAcceptedNextValue) {
      transitionReconcileMissingAnswers.add(1);
      fail(`Next section answer missing for ${student.wcode}: expected=${lastAcceptedNextValue} got=${stored}`);
    }
  }
}
