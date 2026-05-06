import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parseExamRegisterUrl } from './exam-url';
import { loadUsersFromFile, type VirtualUser } from './user-source';
import { startLiveDashboardServer, type DashboardEvent } from './live-dashboard-server';

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
  deleteArtifactsOnFinish: boolean;
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
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
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
    await continueButton.click();
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
      await proceedButton.click().catch(() => {});
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
      await retryButton.click().catch(() => {});
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
        await proceedButton.click().catch(() => {});
      }
    }

    if (/exam|question|time remaining|submit module|next/i.test(text)) {
      return;
    }

    const runtime = await page.evaluate(async ({ origin, scheduleId }) => {
      try {
        const res = await fetch(`${origin}/api/v1/schedules/${scheduleId}/runtime`, { credentials: 'include' });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    }, { origin: ctx.origin, scheduleId: ctx.scheduleId }).catch(() => null);

    const status = runtime && typeof runtime === 'object' ? (runtime as { status?: string }).status : null;
    if (status === 'live') {
      return;
    }

    await page.waitForTimeout(ctx.config.startPollIntervalMs);
  }

  throw new Error('Timed out waiting for runtime to become live.');
}

async function defaultRunExamActions(page: Page, user: VirtualUser, ctx: ScenarioContext): Promise<void> {
  const started = Date.now();
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

    const finishButton = page.getByRole('button', { name: 'Finish' }).first();
    if (await finishButton.isVisible().catch(() => false)) {
      await finishButton.click().catch(() => finishButton.click({ force: true }));
      await page.waitForTimeout(500);
      continue;
    }

    const reviewSubmit = page.getByRole('button', { name: 'Review & Submit' }).first();
    if (await reviewSubmit.isVisible().catch(() => false)) {
      await reviewSubmit.click().catch(() => reviewSubmit.click({ force: true }));
      await page.waitForTimeout(500);
      continue;
    }

    const submitSection = page.getByRole('button', { name: 'Submit Section' }).first();
    if (await submitSection.isVisible().catch(() => false)) {
      await submitSection.click().catch(() => submitSection.click({ force: true }));
      await page.waitForTimeout(500);
      continue;
    }

    const confirmSubmit = page.getByRole('button', { name: 'Confirm Submission' }).first();
    if (await confirmSubmit.isVisible().catch(() => false)) {
      await confirmSubmit.click().catch(() => confirmSubmit.click({ force: true }));
      await page.waitForTimeout(700);
      continue;
    }

    const answerBox = page.getByLabel(/Answer for question/i).first();
    if (await answerBox.isVisible().catch(() => false)) {
      await answerBox.fill(`auto-answer-${user.userId}-${Math.floor(Math.random() * 1000)}`).catch(() => {});
      await page.waitForTimeout(350);
      continue;
    }

    const writingEditor = page.locator('[contenteditable="true"]').first();
    if (await writingEditor.isVisible().catch(() => false)) {
      await writingEditor.click().catch(() => {});
      await writingEditor.type(`auto-writing-${user.userId} `, { delay: 10 }).catch(() => {});
      await page.waitForTimeout(350);
      continue;
    }

    const choice = page.locator('input[type="radio"], input[type="checkbox"]').first();
    if (await choice.isVisible().catch(() => false)) {
      await choice.check().catch(() => {});
      await page.waitForTimeout(250);
      continue;
    }

    const nextButton = page.getByRole('button', { name: /next|continue|save and next/i }).first();
    if (await nextButton.isVisible().catch(() => false)) {
      await nextButton.click().catch(() => {});
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
  let config: RunnerConfig = {
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
    deleteArtifactsOnFinish: bool('DELETE_ARTIFACTS_ON_FINISH', false),
  };
  const hasDisplay = Boolean(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']);
  if (!hasDisplay && (!config.headless || config.headedUsers > 0)) {
    console.warn('[live-runner] no DISPLAY/WAYLAND_DISPLAY detected; forcing headless mode');
    config = {
      ...config,
      headless: true,
      headedUsers: 0,
    };
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
  appendLog(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'live_runner_start',
      scheduleId: parsed.scheduleId,
      userOffset: config.userOffset,
      userCount: config.userCount,
    }),
  );
  console.log(`[live-runner] events: ${liveLogFile}`);

  const dashboard = createMirroredBroadcaster(startLiveDashboardServer(config.dashboardPort));
  const headlessBrowser =
    config.headless || config.headedUsers < users.length ? await chromium.launch({ headless: true }) : null;
  const headedBrowser =
    !config.headless || config.headedUsers > 0 ? await chromium.launch({ headless: false }) : null;
  const results: UserResult[] = [];

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
    let frameInFlight = false;
    let stopCapture = false;

    const setPhase = (next: Phase, status = next, error?: string) => {
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
    } finally {
      stopCapture = true;
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
