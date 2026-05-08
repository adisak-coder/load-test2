import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parseExamRegisterUrl } from './exam-url';
import { loadUsersFromFile, type VirtualUser } from './user-source';
import { startLiveDashboardServer, type DashboardEvent } from './live-dashboard-server';
import { installStudentAnswerCapture } from './student-answer-capture';
import { createGradingVerifier } from './grading-verifier';

export interface RunnerConfig {
  registerUrl: string;
  userCount: number;
  usersFile: string;
  dashboardPort: number;
  screenshotIntervalMs: number;
  jpegQuality: number;
  headless: boolean;
  outputDir: string;
  navTimeoutMs: number;
  startPollIntervalMs: number;
  startTimeoutMs: number;
  examTimeoutMs: number;
  headedUsers: number;
  maxConcurrentUsers: number;
  logFile: string;
  userOffset: number;
  lastAnswerCsvFile: string;
  deleteArtifactsOnFinish: boolean;
  gradingVerifyEnabled: boolean;
  gradingVerifyStrict: boolean;
  gradingVerifyAdminEmail: string;
  gradingVerifyAdminPassword: string;
}

export interface ScenarioContext {
  origin: string;
  scheduleId: string;
  config: RunnerConfig;
}

export interface ScenarioPlugin {
  prepare: (page: Page, user: VirtualUser, ctx: ScenarioContext) => Promise<void>;
  waitForStart: (page: Page, user: VirtualUser, ctx: ScenarioContext) => Promise<void>;
  execute: (page: Page, user: VirtualUser, ctx: ScenarioContext) => Promise<void>;
  finalize: (page: Page, user: VirtualUser, ctx: ScenarioContext) => Promise<void>;
}

type Phase =
  | 'booting'
  | 'registering'
  | 'waiting_runtime_live'
  | 'in_exam'
  | 'done'
  | 'failed';

interface UserResult {
  userId: string;
  phase: Phase;
  ok: boolean;
  joinMs: number;
  startMs: number;
  error?: string;
}

type LiveMode = 'balanced' | 'fast';

function resolveLiveMode(): LiveMode {
  const raw = (process.env['LIVE_MODE'] ?? 'balanced').toLowerCase();
  return raw === 'fast' ? 'fast' : 'balanced';
}

function modeDefaultNumber(mode: LiveMode, name: 'SCREENSHOT_INTERVAL_MS' | 'JPEG_QUALITY'): number {
  if (mode === 'fast') {
    return name === 'SCREENSHOT_INTERVAL_MS' ? 250 : 30;
  }
  return name === 'SCREENSHOT_INTERVAL_MS' ? 1000 : 45;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1] ?? 0;
    const right = sorted[mid] ?? left;
    return Math.round((left + right) / 2);
  }
  return sorted[mid] ?? 0;
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function findSubmissionIdDeep(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    return /^sub[-_]/i.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSubmissionIdDeep(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const direct = record['submissionId'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const finalSubmission = record['finalSubmission'];
  if (finalSubmission && typeof finalSubmission === 'object') {
    const nested = (finalSubmission as Record<string, unknown>)['submissionId'];
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  for (const nestedValue of Object.values(record)) {
    const found = findSubmissionIdDeep(nestedValue, depth + 1);
    if (found) return found;
  }
  return null;
}

function isSubmissionId(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: string | null): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function defaultLoginOrRegister(page: Page, user: VirtualUser, registerUrl: string): Promise<void> {
  const entryUrl = registerUrl.replace(/\/register\/?$/i, '');
  await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
  await page
    .waitForSelector('input#wcode, input#email, input#studentName', {
      timeout: 10000,
      state: 'visible',
    })
    .catch(() => {});

  const fillFirst = async (selectors: string[], value: string): Promise<boolean> => {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.fill(value).catch(() => {});
        const current = await locator.inputValue().catch(() => '');
        if (current.trim().length > 0) {
          return true;
        }
      }
    }
    return false;
  };
  const fillByLabel = async (label: RegExp, value: string): Promise<boolean> => {
    const locator = page.getByLabel(label).first();
    if (!(await locator.count())) return false;
    await locator.fill(value).catch(() => {});
    const current = await locator.inputValue().catch(() => '');
    return current.trim().length > 0;
  };

  const candidateCode = (() => {
    const raw = (user.candidateId ?? user.userId).trim();
    if (/^W\d{6}$/i.test(raw)) {
      return raw.toUpperCase();
    }
    const digits = raw.replace(/\D/g, '').slice(-6).padStart(6, '0');
    return `W${digits}`;
  })();

  const wcodeFilled =
    (await fillByLabel(/wcode/i, candidateCode)) ||
    (await fillFirst(
    [
      'input#wcode',
      'input[aria-label=\"Wcode\"]',
      'input[placeholder*=\"W\" i]',
      'input[name=\"candidateId\"]',
      'input[name=\"candidate_id\"]',
      'input[placeholder*=\"Candidate\" i]',
      'input[placeholder*=\"ID\" i]',
    ],
    candidateCode,
  ));

  const fullNameFilled =
    (await fillByLabel(/full name|name/i, user.userId)) ||
    (await fillFirst(
    [
      'input#studentName',
      'input[aria-label=\"Full Name\"]',
      'input[name=\"candidateName\"]',
      'input[name=\"name\"]',
      'input[placeholder*=\"Name\" i]',
      'input[autocomplete=\"name\"]',
    ],
    user.userId,
  ));

  const emailFilled =
    (await fillByLabel(/email/i, user.email)) ||
    (await fillFirst(
    [
      'input#email',
      'input[name=\"email\"]',
      'input[type=\"email\"]',
      'input[autocomplete=\"email\"]',
      'input[placeholder*=\"Email\" i]',
    ],
    user.email,
  ));

  if (!wcodeFilled || !fullNameFilled || !emailFilled) {
    throw new Error(
      `CHECKIN_FIELDS_NOT_FOUND: wcode=${String(wcodeFilled)} fullName=${String(fullNameFilled)} email=${String(emailFilled)}`,
    );
  }

  // Some deployments do not require a password at student check-in.
  await fillFirst(
    [
      'input[name=\"password\"]',
      'input[type=\"password\"]',
      'input[autocomplete=\"current-password\"]',
      'input[placeholder*=\"Password\" i]',
    ],
    user.password,
  ).catch(() => {});

  const continueButton = page.getByRole('button', { name: /continue|register|start|enter|join|sign in|login/i }).first();
  if (await continueButton.count()) {
    await continueButton.click({ noWaitAfter: true, timeout: 5000 }).catch(() => {});
  } else {
    await page.keyboard.press('Enter').catch(() => {});
  }

  // Handle system-check/pre-check gate if present.
  for (let step = 0; step < 8; step += 1) {
    const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    const looksLikePrecheck =
      bodyText.includes('system check') ||
      bodyText.includes('pre-check') ||
      bodyText.includes('precheck') ||
      bodyText.includes('browser check');
    if (!looksLikePrecheck) {
      break;
    }

    const ackCheckbox = page.getByRole('checkbox').first();
    if (await ackCheckbox.count()) {
      await ackCheckbox.check().catch(() => {});
    }

    const proceedButton = page
      .getByRole('button', {
        name: /continue|next|start exam|start test|enter exam|proceed|i understand|acknowledge/i,
      })
      .first();
    if (await proceedButton.count()) {
      await proceedButton.click({ noWaitAfter: true, timeout: 5000 }).catch(() => {});
    }

    await page.waitForTimeout(500);
  }

  const stillOnCheckIn = async (): Promise<boolean> => {
    const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    return (
      text.includes('exam check-in') ||
      (text.includes('wcode') && text.includes('full name') && text.includes('email'))
    );
  };

  for (let i = 0; i < 5; i += 1) {
    if (!(await stillOnCheckIn())) {
      return;
    }
    const retryButton = page.getByRole('button', { name: /continue|register|start|enter|join|sign in|login/i }).first();
    if (await retryButton.count()) {
      await retryButton.click({ noWaitAfter: true, timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(400);
  }

  if (await stillOnCheckIn()) {
    throw new Error('CHECKIN_NOT_ACCEPTED: still on check-in form after submit (likely invalid or unassigned Wcode/email).');
  }
}

async function defaultWaitForExamLive(page: Page, ctx: ScenarioContext): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ctx.config.startTimeoutMs) {
    const text = await page.locator('body').innerText().catch(() => '');
    const lower = text.toLowerCase();

    const looksLikePrecheck =
      lower.includes('system check') ||
      lower.includes('pre-check') ||
      lower.includes('precheck') ||
      lower.includes('browser check') ||
      lower.includes('device check');
    if (looksLikePrecheck) {
      const ackCheckbox = page.getByRole('checkbox').first();
      if (await ackCheckbox.count()) {
        await ackCheckbox.check().catch(() => {});
      }
      const proceedButton = page
        .getByRole('button', {
          name: /continue|next|start exam|start test|enter exam|proceed|i understand|acknowledge|finish|done/i,
        })
        .first();
      if (await proceedButton.count()) {
        await proceedButton.click({ noWaitAfter: true, timeout: 5000 }).catch(() => {});
      }
    }

    if (/exam|question|time remaining|submit module|next/i.test(text)) {
      return;
    }

    const live = await page.evaluate(async ({ origin, scheduleId }) => {
      try {
        const res = await fetch(`${origin}/api/v1/student/sessions/${scheduleId}/live`, {
          credentials: 'include',
        });
        if (!res.ok) {
          return { ok: false, status: res.status };
        }
        return { ok: true, payload: await res.json() };
      } catch {
        return null;
      }
    }, { origin: ctx.origin, scheduleId: ctx.scheduleId }).catch(() => null);

    const livePayload = live && typeof live === 'object'
      ? (live as { payload?: { data?: { runtime?: { status?: string } } | { status?: string } } }).payload
      : null;
    const runtime = livePayload && typeof livePayload === 'object' && 'data' in livePayload
      ? (livePayload as { data?: { runtime?: { status?: string } } }).data?.runtime
      : (livePayload as { runtime?: { status?: string } } | null)?.runtime;
    const status = runtime && typeof runtime === 'object' ? runtime.status ?? null : null;
    if (status === 'live') {
      return;
    }

    await page.waitForTimeout(ctx.config.startPollIntervalMs);
  }

  throw new Error('Timed out waiting for runtime to become live.');
}

async function defaultRunExamActions(page: Page, user: VirtualUser, ctx: ScenarioContext): Promise<void> {
  const started = Date.now();
  let writes = 0;
  while (Date.now() - started < ctx.config.examTimeoutMs) {
    const completeHeading = page.getByRole('heading', { name: /Examination Complete!/i });
    if (await completeHeading.isVisible().catch(() => false)) {
      return;
    }

    const terminatedCopy = page.getByText(/terminated|exam ended/i).first();
    if (await terminatedCopy.isVisible().catch(() => false)) {
      return;
    }

    const waiting = page.getByRole('heading', { name: /Waiting for start/i }).first();
    if (await waiting.isVisible().catch(() => false)) {
      await page.waitForTimeout(1000);
      continue;
    }

    const textInputs = page.locator('input[aria-label*="Answer for question" i], textarea[aria-label*="Answer for question" i]');
    const textCount = await textInputs.count().catch(() => 0);
    for (let i = 0; i < textCount; i += 1) {
      const input = textInputs.nth(i);
      if (!(await input.isVisible().catch(() => false))) continue;
      await input.fill(`ans-${user.userId}-${writes}`).catch(() => {});
      writes += 1;
    }

    const writeIntoEditor = async (value: string): Promise<boolean> => {
      const writingInput = page
        .locator('textarea[aria-label="Writing response"], textarea[aria-label*="writing response" i], [contenteditable="true"]')
        .first();
      if (!(await writingInput.isVisible().catch(() => false))) return false;
      await writingInput.click().catch(() => {});
      await writingInput.fill(value).catch(() => {});
      await writingInput.press('End').catch(() => {});
      await writingInput.type(' ').catch(() => {});
      await writingInput.press('Backspace').catch(() => {});
      await writingInput
        .evaluate((node, text) => {
          if (!(node instanceof HTMLElement)) return;
          const target = node as HTMLInputElement | HTMLTextAreaElement;
          if ('value' in target) {
            target.value = text;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
          if (node.isContentEditable) {
            node.textContent = text;
            node.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          }
        }, value)
        .catch(() => {});
      return true;
    };

    const writingTaskButtons = page.getByRole('button', { name: /^Task\s*\d+$/i });
    const writingTaskCount = await writingTaskButtons.count().catch(() => 0);
    if (writingTaskCount > 0) {
      for (let i = 0; i < writingTaskCount; i += 1) {
        const taskButton = writingTaskButtons.nth(i);
        if (!(await taskButton.isVisible().catch(() => false))) continue;
        await taskButton.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(120);
        const writingValue = `writing-${user.userId}-task${i + 1}-${writes}`;
        const wrote = await writeIntoEditor(writingValue);
        if (wrote) {
          writes += 1;
        }
      }
    } else {
      const writingValue = `writing-${user.userId}-${writes}`;
      const wrote = await writeIntoEditor(writingValue);
      if (wrote) {
        writes += 1;
      }
    }

    const finishButton = page.getByRole('button', { name: 'Finish' }).first();
    if (await finishButton.isVisible().catch(() => false)) {
      await finishButton
        .click({ noWaitAfter: true, timeout: 5000 })
        .catch(() => finishButton.click({ force: true, noWaitAfter: true, timeout: 5000 }));
      await page.waitForTimeout(500);
      continue;
    }

    const reviewSubmit = page.getByRole('button', { name: 'Review & Submit' }).first();
    if (await reviewSubmit.isVisible().catch(() => false)) {
      await reviewSubmit
        .click({ noWaitAfter: true, timeout: 5000 })
        .catch(() => reviewSubmit.click({ force: true, noWaitAfter: true, timeout: 5000 }));
      await page.waitForTimeout(500);
      continue;
    }

    const submitSection = page.getByRole('button', { name: 'Submit Section' }).first();
    if (await submitSection.isVisible().catch(() => false)) {
      await submitSection
        .click({ noWaitAfter: true, timeout: 5000 })
        .catch(() => submitSection.click({ force: true, noWaitAfter: true, timeout: 5000 }));
      await page.waitForTimeout(500);
      continue;
    }

    const confirmSubmit = page.getByRole('button', { name: 'Confirm Submission' }).first();
    if (await confirmSubmit.isVisible().catch(() => false)) {
      await confirmSubmit
        .click({ noWaitAfter: true, timeout: 5000 })
        .catch(() => confirmSubmit.click({ force: true, noWaitAfter: true, timeout: 5000 }));
      await page.waitForTimeout(700);
      continue;
    }

    const choice = page.locator('input[type="radio"], input[type="checkbox"]').first();
    if (await choice.isVisible().catch(() => false)) {
      await choice.check().catch(() => {});
    }

    const nextButton = page.getByRole('button', { name: /next|continue|save and next/i }).first();
    if (await nextButton.isVisible().catch(() => false)) {
      await nextButton.click({ noWaitAfter: true, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
      continue;
    }

    await page.waitForTimeout(700 + Math.floor(Math.random() * 800));
  }
  throw new Error('EXAM_NOT_FINISHED: timed out before reaching submission complete state.');
}

const defaultScenario: ScenarioPlugin = {
  prepare: async (page, user, ctx) => defaultLoginOrRegister(page, user, ctx.config.registerUrl),
  waitForStart: async (page, _user, ctx) => defaultWaitForExamLive(page, ctx),
  execute: async (page, user, ctx) => defaultRunExamActions(page, user, ctx),
  finalize: async () => {},
};

function eventBase(userId: string, status: string, phase: Phase, error?: string): DashboardEvent {
  return { userId, status, phase, lastSeenAt: new Date().toISOString(), ...(error ? { error } : {}) };
}

function formatWritingProof(
  comparisons: Array<{ taskId: string; expected: string | null; actual: string; match: boolean }>,
): string {
  if (comparisons.length === 0) return 'No writing task rows returned from grading API.';
  return comparisons
    .map((item) => {
      const flag = item.match ? 'OK' : 'DIFF';
      const expected = item.expected ?? '<missing in runner capture>';
      return `[${flag}] ${item.taskId}\nexpected: ${expected}\nactual:   ${item.actual}`;
    })
    .join('\n\n');
}

function formatBotAnswersProof(expected: { answers: Record<string, unknown>; writingAnswers: Record<string, string> }): string {
  const answerRows = Object.entries(expected.answers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => `Q ${id}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  const writingRows = Object.entries(expected.writingAnswers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => `W ${id}: ${value}`);

  const objectiveBlock = answerRows.length > 0 ? answerRows.join('\n') : '<no objective answers captured>';
  const writingBlock = writingRows.length > 0 ? writingRows.join('\n') : '<no writing answers captured>';
  return `Objective Answers:\n${objectiveBlock}\n\nWriting Answers:\n${writingBlock}`;
}

function createMirroredBroadcaster(base: { broadcast: (event: DashboardEvent) => void }): {
  broadcast: (event: DashboardEvent) => void;
} {
  const endpoint = process.env['LIVE_EVENT_ENDPOINT']?.trim();
  const token = process.env['LIVE_EVENT_TOKEN']?.trim();

  if (!endpoint || !token) {
    return base;
  }

  const mirror = (event: DashboardEvent) => {
    void fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-live-event-token': token,
      },
      body: JSON.stringify(event),
    }).catch(() => {});
  };

  return {
    broadcast: (event: DashboardEvent) => {
      base.broadcast(event);
      mirror(event);
    },
  };
}

async function run(): Promise<void> {
  const liveMode = resolveLiveMode();
  const config: RunnerConfig = {
    registerUrl: requireEnv('REGISTER_URL'),
    userCount: num('USER_COUNT', 100),
    usersFile: requireEnv('USERS_FILE'),
    dashboardPort: num('DASHBOARD_PORT', 3333),
    screenshotIntervalMs: num('SCREENSHOT_INTERVAL_MS', modeDefaultNumber(liveMode, 'SCREENSHOT_INTERVAL_MS')),
    jpegQuality: num('JPEG_QUALITY', modeDefaultNumber(liveMode, 'JPEG_QUALITY')),
    headless: bool('HEADLESS', true),
    outputDir: process.env['OUTPUT_DIR'] ?? 'e2e/.generated/live-runner',
    navTimeoutMs: num('NAV_TIMEOUT_MS', 30000),
    startPollIntervalMs: num('START_POLL_INTERVAL_MS', 1500),
    startTimeoutMs: num('START_TIMEOUT_MS', 20 * 60 * 1000),
    examTimeoutMs: num('EXAM_TIMEOUT_MS', 30 * 60 * 1000),
    headedUsers: Math.max(0, num('HEADED_USERS', 0)),
    maxConcurrentUsers: Math.max(1, num('MAX_CONCURRENT_USERS', 20)),
    logFile: process.env['LIVE_RUN_LOG_FILE'] ?? '',
    userOffset: Math.max(0, num('USER_OFFSET', 0)),
    lastAnswerCsvFile: process.env['LAST_ANSWER_CSV_FILE']?.trim() ?? '',
    deleteArtifactsOnFinish: bool('DELETE_ARTIFACTS_ON_FINISH', false),
    gradingVerifyEnabled: bool('GRADING_VERIFY_ENABLED', false),
    gradingVerifyStrict: bool('GRADING_VERIFY_STRICT', true),
    gradingVerifyAdminEmail: process.env['GRADING_VERIFY_ADMIN_EMAIL']?.trim() ?? '',
    gradingVerifyAdminPassword: process.env['GRADING_VERIFY_ADMIN_PASSWORD'] ?? '',
  };
  if (config.gradingVerifyEnabled && (!config.gradingVerifyAdminEmail || !config.gradingVerifyAdminPassword)) {
    throw new Error('GRADING_VERIFY_ADMIN_EMAIL and GRADING_VERIFY_ADMIN_PASSWORD are required when GRADING_VERIFY_ENABLED=true');
  }

  const parsed = parseExamRegisterUrl(config.registerUrl);
  const users = loadUsersFromFile(config.usersFile, config.userCount, config.userOffset);

  fs.mkdirSync(path.resolve(process.cwd(), config.outputDir), { recursive: true });
  const liveLogFile =
    config.logFile.trim().length > 0
      ? path.resolve(process.cwd(), config.logFile)
      : path.resolve(process.cwd(), config.outputDir, `live-run-events-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(liveLogFile), { recursive: true });
  const appendLog = (line: string) => {
    fs.appendFileSync(liveLogFile, `${line}\n`);
  };
  const lastAnswerCsvPath =
    config.lastAnswerCsvFile.length > 0
      ? path.resolve(process.cwd(), config.lastAnswerCsvFile)
      : path.resolve(process.cwd(), config.outputDir, `live-run-last-answers-${Date.now()}.csv`);
  fs.mkdirSync(path.dirname(lastAnswerCsvPath), { recursive: true });
  const csvHeader = 'ts,userId,scheduleId,status,error,answersJson,writingAnswersJson';
  fs.writeFileSync(lastAnswerCsvPath, `${csvHeader}\n`);
  const appendLastAnswerRow = (input: {
    userId: string;
    status: 'done' | 'failed';
    error?: string;
    answersJson: string;
    writingAnswersJson: string;
  }) => {
    const row = [
      new Date().toISOString(),
      input.userId,
      parsed.scheduleId,
      input.status,
      input.error ?? '',
      input.answersJson,
      input.writingAnswersJson,
    ]
      .map(csvEscape)
      .join(',');
    fs.appendFileSync(lastAnswerCsvPath, `${row}\n`);
  };
  appendLog(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'live_runner_start',
      scheduleId: parsed.scheduleId,
      userOffset: config.userOffset,
      userCount: config.userCount,
      lastAnswerCsvPath,
    }),
  );
  console.log(`[live-runner] events: ${liveLogFile}`);
  console.log(`[live-runner] last answers csv: ${lastAnswerCsvPath}`);

  const dashboard = createMirroredBroadcaster(startLiveDashboardServer(config.dashboardPort));
  const headlessBrowser =
    config.headless || config.headedUsers < users.length ? await chromium.launch({ headless: true }) : null;
  const headedBrowser =
    !config.headless || config.headedUsers > 0 ? await chromium.launch({ headless: false }) : null;
  const results: UserResult[] = [];
  const gradingVerifier = config.gradingVerifyEnabled
    ? await createGradingVerifier({
      origin: parsed.origin,
      adminEmail: config.gradingVerifyAdminEmail,
      adminPassword: config.gradingVerifyAdminPassword,
      strict: config.gradingVerifyStrict,
    })
    : null;

  const ctx: ScenarioContext = {
    origin: parsed.origin,
    scheduleId: parsed.scheduleId,
    config,
  };

  // Pre-seed dashboard with every cohort user so large runs (e.g. 500) show all cards immediately.
  for (const user of users) {
    dashboard.broadcast(eventBase(user.userId, 'queued', 'booting'));
  }

  const runner = async (user: VirtualUser, index: number) => {
    const startedAt = Date.now();
    let startedExamAt = 0;
    let phase: Phase = 'booting';
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let answerCapture: ReturnType<typeof installStudentAnswerCapture> | null = null;
    let frameInFlight = false;
    let stopCapture = false;

    const setPhase = (next: Phase, status: string = next, error?: string) => {
      phase = next;
      dashboard.broadcast(eventBase(user.userId, status, phase, error));
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        userId: user.userId,
        scheduleId: ctx.scheduleId,
        phase,
        status,
        ...(error ? { errorCode: error } : {}),
      });
      console.log(line);
      appendLog(line);
    };

    try {
      const useHeaded = !config.headless || index < config.headedUsers;
      const selectedBrowser = useHeaded ? headedBrowser : headlessBrowser;
      if (!selectedBrowser) {
        throw new Error(`BROWSER_MODE_UNAVAILABLE: useHeaded=${String(useHeaded)}`);
      }

      context = await selectedBrowser.newContext({ viewport: { width: 1280, height: 720 } });
      page = await context.newPage();
      page.setDefaultTimeout(config.navTimeoutMs);
      answerCapture = installStudentAnswerCapture(page);

      setPhase('registering', 'starting');
      await defaultScenario.prepare(page, user, ctx);

      setPhase('waiting_runtime_live', 'waiting_start');

      const captureLoop = (async () => {
        while (!stopCapture && page) {
          if (page.isClosed()) {
            break;
          }
          if (!frameInFlight) {
            frameInFlight = true;
            try {
              const image = await page.screenshot({ type: 'jpeg', quality: config.jpegQuality });
              dashboard.broadcast({
                ...eventBase(user.userId, 'running', phase),
                imageBase64: image.toString('base64'),
              });
            } catch {
              dashboard.broadcast(eventBase(user.userId, 'screenshot_failed', phase));
            } finally {
              frameInFlight = false;
            }
          }
          await page.waitForTimeout(config.screenshotIntervalMs).catch(() => {});
        }
      })();

      await defaultScenario.waitForStart(page, user, ctx);
      startedExamAt = Date.now();
      setPhase('in_exam', 'live');

      await defaultScenario.execute(page, user, ctx);
      await defaultScenario.finalize(page, user, ctx);
      const botAnswersProof = formatBotAnswersProof(answerCapture.expected);
      dashboard.broadcast({
        ...eventBase(user.userId, 'answers_captured', phase),
        comparison: { botAnswersProof },
      });

      if (gradingVerifier && answerCapture) {
        let submissionId = answerCapture.getSubmissionId();
        if (!submissionId) {
          const sessionSnapshot = await page.evaluate(async ({ origin, scheduleId }) => {
            try {
              const res = await fetch(`${origin}/api/v1/student/sessions/${scheduleId}`, { credentials: 'include' });
              if (!res.ok) return null;
              return await res.json();
            } catch {
              return null;
            }
          }, { origin: ctx.origin, scheduleId: ctx.scheduleId }).catch(() => null);
          submissionId = findSubmissionIdDeep(sessionSnapshot);
        }
        if (!isUuid(submissionId)) {
          const candidates = [user.candidateId ?? '', user.email, user.userId];
          const deadlineMs = Date.now() + 20_000;
          while (!isUuid(submissionId) && Date.now() < deadlineMs) {
            submissionId = await gradingVerifier.findLatestSubmissionIdForStudent(ctx.scheduleId, candidates);
            if (isUuid(submissionId)) break;
            await page.waitForTimeout(1000).catch(() => {});
          }
        }
        if (!isUuid(submissionId)) {
          throw new Error('GRADING_VERIFY_NO_SUBMISSION_ID: unable to resolve UUID grading submission for student.');
        }
        const verifyResult = await gradingVerifier.verifySubmission(submissionId, answerCapture.expected);
        const writingProof = formatWritingProof(verifyResult.writingComparisons);
        const sameCount = verifyResult.writingComparisons.filter((item) => item.match).length;
        const diffCount = verifyResult.writingComparisons.length - sameCount;
        dashboard.broadcast({
          ...eventBase(user.userId, verifyResult.ok ? 'grading_verified' : 'grading_mismatch', phase),
          comparison: { submissionId, writingProof, botAnswersProof, sameCount, diffCount },
          metrics: { writingComparedTasks: verifyResult.writingComparisons.length, mismatches: verifyResult.mismatches.length },
        });
        appendLog(
          JSON.stringify({
            ts: new Date().toISOString(),
            userId: user.userId,
            scheduleId: ctx.scheduleId,
            event: 'GRADING_VERIFY_COMPARE',
            submissionId,
            writingComparedTasks: verifyResult.writingComparisons.length,
            mismatches: verifyResult.mismatches.length,
            writingComparisons: verifyResult.writingComparisons,
          }),
        );
        if (!verifyResult.ok) {
          const preview = verifyResult.mismatches
            .slice(0, 5)
            .map((item) => `${item.kind}:${item.id}`)
            .join(', ');
          throw new Error(
            `GRADING_VERIFY_MISMATCH: submissionId=${submissionId} mismatches=${verifyResult.mismatches.length} [${preview}]`,
          );
        }
        const verifyOkLine = JSON.stringify({
          ts: new Date().toISOString(),
          userId: user.userId,
          scheduleId: ctx.scheduleId,
          event: 'GRADING_VERIFY_OK',
          submissionId,
          mismatches: verifyResult.mismatches.length,
        });
        console.log(verifyOkLine);
        appendLog(verifyOkLine);
      } else {
        const verifySkippedLine = JSON.stringify({
          ts: new Date().toISOString(),
          userId: user.userId,
          scheduleId: ctx.scheduleId,
          event: 'GRADING_VERIFY_SKIPPED',
        });
        console.log(verifySkippedLine);
        appendLog(verifySkippedLine);
      }

      setPhase('done', 'done');
      stopCapture = true;
      await captureLoop.catch(() => {});

      results.push({
        userId: user.userId,
        phase: 'done',
        ok: true,
        joinMs: Math.max(0, startedExamAt - startedAt),
        startMs: Math.max(0, Date.now() - startedAt),
      });
      appendLastAnswerRow({
        userId: user.userId,
        status: 'done',
        answersJson: JSON.stringify(answerCapture?.expected.answers ?? {}),
        writingAnswersJson: JSON.stringify(answerCapture?.expected.writingAnswers ?? {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPhase('failed', 'failed', message);
      results.push({
        userId: user.userId,
        phase: 'failed',
        ok: false,
        joinMs: Math.max(0, startedExamAt ? startedExamAt - startedAt : 0),
        startMs: Math.max(0, Date.now() - startedAt),
        error: message,
      });
      appendLastAnswerRow({
        userId: user.userId,
        status: 'failed',
        error: message,
        answersJson: JSON.stringify(answerCapture?.expected.answers ?? {}),
        writingAnswersJson: JSON.stringify(answerCapture?.expected.writingAnswers ?? {}),
      });
    } finally {
      stopCapture = true;
      answerCapture?.dispose();
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }
  };

  try {
    const queue = users.map((user, index) => ({ user, index }));
    const workers = Array.from({ length: Math.min(config.maxConcurrentUsers, queue.length) }, async () => {
      while (true) {
        const next = queue.shift();
        if (!next) return;
        await runner(next.user, next.index);
      }
    });
    await Promise.all(workers);
  } finally {
    if (headedBrowser) await headedBrowser.close();
    if (headlessBrowser) await headlessBrowser.close();
    await gradingVerifier?.dispose();
  }

  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const summary = {
    scheduleId: ctx.scheduleId,
    registerUrl: config.registerUrl,
    liveMode,
    userCount: users.length,
    passed: ok.length,
    failed: fail.length,
    submitCount: ok.length,
    medianJoinMs: computeMedian(ok.map((r) => r.joinMs)),
    medianStartMs: computeMedian(ok.map((r) => r.startMs)),
    generatedAt: new Date().toISOString(),
    failures: fail,
  };

  const summaryPath = path.resolve(process.cwd(), config.outputDir, `live-run-summary-${Date.now()}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`[live-runner] summary: ${summaryPath}`);
  console.log(`[live-runner] last answers csv: ${lastAnswerCsvPath}`);
  appendLog(JSON.stringify({ ts: new Date().toISOString(), event: 'live_runner_summary', summaryPath, liveLogFile }));
  if (config.deleteArtifactsOnFinish) {
    try {
      fs.unlinkSync(summaryPath);
    } catch {}
    try {
      fs.unlinkSync(liveLogFile);
    } catch {}
    console.log('[live-runner] artifacts deleted (DELETE_ARTIFACTS_ON_FINISH=true)');
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
