import { request, type APIRequestContext } from 'playwright';

export interface ExpectedAnswerSnapshot {
  answers: Record<string, unknown>;
  writingAnswers: Record<string, string>;
}

export interface GradingVerifyConfig {
  origin: string;
  adminEmail: string;
  adminPassword: string;
  strict: boolean;
}

export interface GradingVerifyResult {
  ok: boolean;
  mismatches: Array<{ kind: 'objective' | 'writing'; id: string; expected: unknown; actual: unknown }>;
  writingComparisons: Array<{
    taskId: string;
    expected: string | null;
    actual: string;
    match: boolean;
  }>;
}

function normalizeAnswer(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item.trim() : item));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function findUuidDeep(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (isUuid(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUuidDeep(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['submissionId', 'id', 'uuid', 'submissionUuid', 'gradingSubmissionId']) {
    const direct = record[key];
    if (isUuid(direct)) return direct;
  }
  for (const nested of Object.values(record)) {
    const found = findUuidDeep(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

export async function createGradingVerifier(config: GradingVerifyConfig): Promise<{
  verifySubmission: (submissionId: string, expected: ExpectedAnswerSnapshot) => Promise<GradingVerifyResult>;
  findLatestSubmissionIdForStudent: (scheduleId: string, candidates: string[]) => Promise<string | null>;
  dispose: () => Promise<void>;
}> {
  const api: APIRequestContext = await request.newContext({
    baseURL: config.origin,
    ignoreHTTPSErrors: true,
  });

  const loginRes = await api.post('/api/v1/auth/login', {
    data: { email: config.adminEmail, password: config.adminPassword },
  });
  if (!loginRes.ok()) {
    throw new Error(`GRADING_VERIFY_LOGIN_FAILED: status=${loginRes.status()} body=${await loginRes.text().catch(() => '')}`);
  }

  const findLatestSubmissionIdForStudent = async (scheduleId: string, candidates: string[]): Promise<string | null> => {
    const normalized = candidates.map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (normalized.length === 0) return null;
    const detailRes = await api.get(`/api/v1/grading/sessions/${scheduleId}?page=1&pageSize=500`);
    if (!detailRes.ok()) {
      throw new Error(
        `GRADING_VERIFY_SESSION_DETAIL_FAILED: status=${detailRes.status()} body=${await detailRes.text().catch(() => '')}`,
      );
    }
    const detailJson = (await detailRes.json().catch(() => null)) as unknown;
    const data = isRecord(detailJson) ? detailJson['data'] : null;
    const submissionsValue = isRecord(data) ? data['submissions'] : null;
    const submissions = Array.isArray(submissionsValue) ? submissionsValue : [];

    const score = (submission: Record<string, unknown>): number => {
      let points = 0;
      const studentId = typeof submission['studentId'] === 'string' ? submission['studentId'].trim().toLowerCase() : '';
      const studentEmail = typeof submission['studentEmail'] === 'string' ? submission['studentEmail'].trim().toLowerCase() : '';
      const studentName = typeof submission['studentName'] === 'string' ? submission['studentName'].trim().toLowerCase() : '';
      const attemptId = typeof submission['attemptId'] === 'string' ? submission['attemptId'].trim().toLowerCase() : '';
      for (const candidate of normalized) {
        if (candidate === studentId) points += 6;
        if (candidate === studentEmail) points += 6;
        if (candidate === studentName) points += 4;
        if (candidate === attemptId) points += 3;
      }
      return points;
    };

    let bestId: string | null = null;
    let bestScore = 0;
    let bestSubmittedAt = 0;
    for (const item of submissions) {
      if (!isRecord(item)) continue;
      const uuid = findUuidDeep(item);
      if (!uuid) continue;
      const points = score(item);
      if (points <= 0) continue;
      const submittedAtRaw = item['submittedAt'];
      const submittedAtMs =
        typeof submittedAtRaw === 'string'
          ? Date.parse(submittedAtRaw)
          : typeof submittedAtRaw === 'number'
            ? submittedAtRaw
            : 0;
      if (points > bestScore || (points === bestScore && submittedAtMs > bestSubmittedAt)) {
        bestScore = points;
        bestSubmittedAt = submittedAtMs;
        bestId = uuid;
      }
    }
    return bestId;
  };

  const verifySubmission = async (
    submissionId: string,
    expected: ExpectedAnswerSnapshot,
  ): Promise<GradingVerifyResult> => {
    const mismatches: GradingVerifyResult['mismatches'] = [];
    const writingComparisons: GradingVerifyResult['writingComparisons'] = [];

    const sectionsRes = await api.get(`/api/v1/grading/submissions/${submissionId}/sections`);
    if (!sectionsRes.ok()) {
      throw new Error(
        `GRADING_VERIFY_SECTIONS_FAILED: status=${sectionsRes.status()} body=${await sectionsRes.text().catch(() => '')}`,
      );
    }
    const sectionsJson = (await sectionsRes.json().catch(() => null)) as unknown;
    const sectionsData = isRecord(sectionsJson) ? sectionsJson['data'] : null;
    const sections = Array.isArray(sectionsData) ? sectionsData : [];

    for (const section of sections) {
      if (!isRecord(section)) continue;
      const answers = section['answers'];
      if (!isRecord(answers)) continue;
      const type = answers['type'];
      if (type !== 'reading' && type !== 'listening') continue;

      const parts = answers['parts'];
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!isRecord(part)) continue;
        const questions = part['questions'];
        if (!Array.isArray(questions)) continue;
        for (const question of questions) {
          if (!isRecord(question)) continue;
          const questionId = question['questionId'];
          if (typeof questionId !== 'string' || questionId.length === 0) continue;
          const actual = normalizeAnswer(question['studentAnswer']);
          const exp = normalizeAnswer(expected.answers[questionId]);
          if (actual === undefined) continue;
          if (exp === undefined) {
            mismatches.push({ kind: 'objective', id: questionId, expected: undefined, actual });
            continue;
          }
          if (JSON.stringify(actual) !== JSON.stringify(exp)) {
            mismatches.push({ kind: 'objective', id: questionId, expected: exp, actual });
          }
        }
      }
    }

    const writingRes = await api.get(`/api/v1/grading/submissions/${submissionId}/writing-tasks`);
    if (!writingRes.ok()) {
      throw new Error(
        `GRADING_VERIFY_WRITING_FAILED: status=${writingRes.status()} body=${await writingRes.text().catch(() => '')}`,
      );
    }
    const writingJson = (await writingRes.json().catch(() => null)) as unknown;
    const writingData = isRecord(writingJson) ? writingJson['data'] : null;
    const tasks = Array.isArray(writingData) ? writingData : [];
    for (const task of tasks) {
      if (!isRecord(task)) continue;
      const taskId = task['taskId'];
      if (typeof taskId !== 'string' || taskId.length === 0) continue;
      const actual = typeof task['studentText'] === 'string' ? task['studentText'] : '';
      const exp = expected.writingAnswers[taskId];
      const hasExpected = exp !== undefined;
      writingComparisons.push({
        taskId,
        expected: hasExpected ? exp : null,
        actual,
        match: hasExpected ? actual === exp : false,
      });
      if (exp === undefined) {
        mismatches.push({ kind: 'writing', id: taskId, expected: undefined, actual });
        continue;
      }
      if (actual !== exp) {
        mismatches.push({ kind: 'writing', id: taskId, expected: exp, actual });
      }
    }

    const ok = mismatches.length === 0;
    if (!ok && config.strict) {
      return { ok: false, mismatches, writingComparisons };
    }
    return { ok, mismatches, writingComparisons };
  };

  return {
    verifySubmission,
    findLatestSubmissionIdForStudent,
    dispose: async () => {
      await api.dispose();
    },
  };
}
