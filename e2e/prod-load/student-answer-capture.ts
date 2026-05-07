import type { Page, Request, Response } from 'playwright';

export interface ExpectedAnswerSnapshot {
  answers: Record<string, unknown>;
  writingAnswers: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function setArraySlot(target: unknown, index: number, value: string): unknown {
  const existing = Array.isArray(target) ? [...target] : [];
  while (existing.length <= index) existing.push(null);
  existing[index] = value;
  return existing;
}

function parseMutations(payload: unknown, sink: ExpectedAnswerSnapshot): void {
  if (!isRecord(payload)) return;
  const mutations = payload['mutations'];
  if (!Array.isArray(mutations)) return;

  for (const mutation of mutations) {
    if (!isRecord(mutation)) continue;
    const type = mutation['type'];
    if (typeof type !== 'string') continue;

    if (type === 'SetEssayText') {
      const taskId = mutation['taskId'];
      const value = mutation['value'];
      if (typeof taskId === 'string' && typeof value === 'string') {
        sink.writingAnswers[taskId] = value;
      }
      continue;
    }

    if (type === 'ClearEssayText') {
      const taskId = mutation['taskId'];
      if (typeof taskId === 'string') {
        delete sink.writingAnswers[taskId];
      }
      continue;
    }

    const questionId = mutation['questionId'];
    if (typeof questionId !== 'string') continue;

    if (type === 'SetScalar') {
      const value = mutation['value'];
      if (typeof value === 'string') {
        sink.answers[questionId] = value;
      }
      continue;
    }

    if (type === 'ClearScalar') {
      delete sink.answers[questionId];
      continue;
    }

    if (type === 'SetChoice') {
      sink.answers[questionId] = mutation['value'];
      continue;
    }

    if (type === 'ClearChoice') {
      delete sink.answers[questionId];
      continue;
    }

    if (type === 'SetSlot') {
      const slotIndex = asInt(mutation['slotIndex']);
      const value = mutation['value'];
      if (slotIndex !== null && slotIndex >= 0 && typeof value === 'string') {
        sink.answers[questionId] = setArraySlot(sink.answers[questionId], slotIndex, value);
      }
      continue;
    }

    if (type === 'ClearSlot') {
      const slotIndex = asInt(mutation['slotIndex']);
      if (slotIndex !== null && slotIndex >= 0) {
        const existing = sink.answers[questionId];
        if (Array.isArray(existing)) {
          const copy = [...existing];
          if (slotIndex < copy.length) copy[slotIndex] = null;
          sink.answers[questionId] = copy;
        }
      }
      continue;
    }
  }
}

export function installStudentAnswerCapture(page: Page): {
  expected: ExpectedAnswerSnapshot;
  getSubmissionId: () => string | null;
  dispose: () => void;
} {
  const expected: ExpectedAnswerSnapshot = { answers: {}, writingAnswers: {} };
  let submissionId: string | null = null;

  const isMutationBatchUrl = (url: string) => /\/api\/v1\/student\/sessions\/[^/]+\/mutations:batch/.test(url);
  const isSubmitUrl = (url: string) => /\/api\/v1\/student\/sessions\/[^/]+\/submit/.test(url);

  const onRequest = (req: Request) => {
    if (req.method() !== 'POST') return;
    const url = req.url();
    if (!isMutationBatchUrl(url)) return;
    const payload = req.postDataJSON?.() as unknown;
    parseMutations(payload, expected);
  };

  const onResponse = async (res: Response) => {
    if (submissionId) return;
    const req = res.request();
    if (req.method() !== 'POST') return;
    const url = res.url();
    if (!isSubmitUrl(url)) return;
    try {
      const body = (await res.json()) as unknown;
      if (!isRecord(body)) return;
      const data = body['data'];
      if (!isRecord(data)) return;
      const id = data['submissionId'];
      if (typeof id === 'string' && id.length > 0) {
        submissionId = id;
      }
    } catch {
      // ignore parse errors
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  return {
    expected,
    getSubmissionId: () => submissionId,
    dispose: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  };
}

