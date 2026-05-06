export interface ParsedExamRegisterUrl {
  origin: string;
  registerUrl: string;
  scheduleId: string;
}

export function parseExamRegisterUrl(input: string): ParsedExamRegisterUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('REGISTER_URL is required.');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid REGISTER_URL: ${input}`);
  }

  const parts = url.pathname.split('/').filter(Boolean);
  // /student/:scheduleId/register
  if (parts.length < 3 || parts[0] !== 'student' || parts[2] !== 'register') {
    throw new Error(`REGISTER_URL must match /student/{scheduleId}/register. Received: ${url.pathname}`);
  }

  const scheduleId = parts[1];
  if (!scheduleId) {
    throw new Error('Missing scheduleId in REGISTER_URL.');
  }

  return {
    origin: url.origin,
    registerUrl: url.toString(),
    scheduleId,
  };
}
