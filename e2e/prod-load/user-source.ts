import fs from 'node:fs';
import path from 'node:path';

export interface VirtualUser {
  userId: string;
  email: string;
  password: string;
  candidateId?: string;
}

function parseCsv(content: string): VirtualUser[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(',').map((h) => h.trim());
  const index = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const userIdIdx = index('userId');
  const emailIdx = index('email');
  const passwordIdx = index('password');
  const candidateIdIdx = index('candidateId');

  if (userIdIdx < 0 || emailIdx < 0 || passwordIdx < 0) {
    throw new Error('CSV must include headers: userId,email,password (candidateId optional).');
  }

  return lines.slice(1).map((line, rowIdx) => {
    const cells = line.split(',').map((c) => c.trim());
    const userId = cells[userIdIdx] ?? '';
    const email = cells[emailIdx] ?? '';
    const password = cells[passwordIdx] ?? '';
    const candidateId = candidateIdIdx >= 0 ? (cells[candidateIdIdx] ?? '') : '';

    if (!userId || !email || !password) {
      throw new Error(`Invalid CSV row ${rowIdx + 2}: userId,email,password are required.`);
    }

    return {
      userId,
      email,
      password,
      ...(candidateId ? { candidateId } : {}),
    };
  });
}

function parseJson(content: string): VirtualUser[] {
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('USERS_FILE JSON must be an array of users.');
  }

  return parsed.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid JSON user at index ${idx}.`);
    }
    const record = item as Partial<VirtualUser>;
    if (!record.userId || !record.email || !record.password) {
      throw new Error(`Invalid JSON user at index ${idx}: userId,email,password are required.`);
    }
    return {
      userId: String(record.userId),
      email: String(record.email),
      password: String(record.password),
      ...(record.candidateId ? { candidateId: String(record.candidateId) } : {}),
    };
  });
}

export function loadUsersFromFile(filePath: string, requiredCount: number, userOffset = 0): VirtualUser[] {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`USERS_FILE not found: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf8');
  const users = filePath.toLowerCase().endsWith('.csv') ? parseCsv(content) : parseJson(content);

  const safeOffset = Math.max(0, Math.trunc(userOffset));
  if (users.length < safeOffset + requiredCount) {
    throw new Error(
      `USERS_FILE has ${users.length} users but USER_OFFSET=${safeOffset} and USER_COUNT=${requiredCount} require ${
        safeOffset + requiredCount
      }.`,
    );
  }

  const emailSet = new Set<string>();
  const userIdSet = new Set<string>();
  for (const user of users) {
    const normalizedEmail = user.email.trim().toLowerCase();
    if (emailSet.has(normalizedEmail)) {
      throw new Error(`Duplicate email in USERS_FILE: ${user.email}`);
    }
    if (userIdSet.has(user.userId)) {
      throw new Error(`Duplicate userId in USERS_FILE: ${user.userId}`);
    }
    emailSet.add(normalizedEmail);
    userIdSet.add(user.userId);
  }

  return users.slice(safeOffset, safeOffset + requiredCount);
}
