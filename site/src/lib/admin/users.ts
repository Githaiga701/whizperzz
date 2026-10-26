import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { docsFor, type DocStore } from '@/lib/storage/docs';

export interface AdminUser {
  username: string;
  /** scrypt$N$r$p$salt$hash */
  passwordHash: string;
  createdAt: string;
}

interface UsersFile {
  users: AdminUser[];
}

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminError';
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A short fingerprint of the password hash. Changing a password changes it, which logs out old sessions. */
export function passwordVersion(user: AdminUser): string {
  return createHash('sha256').update(user.passwordHash).digest('base64url').slice(0, 12);
}

export function validateUsername(username: string): string {
  const u = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new AdminError('Usernames are 3 to 32 characters: letters, numbers, dots, dashes or underscores.');
  return u;
}

export function validatePassword(password: string): void {
  if (password.length < 10) throw new AdminError('Use a password of at least 10 characters.');
  if (password.length > 200) throw new AdminError('That password is too long.');
}

// Used when a username doesn't exist, so a wrong username takes as long to check as a wrong password.
const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

export class UserStore {
  readonly file: string;
  private readonly docs: DocStore;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'users.json');
    this.docs = docsFor(dataDir);
  }

  private load(): UsersFile {
    return this.docs.read<UsersFile>('users.json') ?? { users: [] };
  }

  private save(next: UsersFile): void {
    this.docs.write('users.json', next, { private: true });
  }

  hasUsers(): boolean {
    return this.load().users.length > 0;
  }

  list(): { username: string; createdAt: string }[] {
    return this.load().users.map(({ username, createdAt }) => ({ username, createdAt }));
  }

  get(username: string): AdminUser | undefined {
    return this.load().users.find((u) => u.username === username.trim().toLowerCase());
  }

  create(username: string, password: string, now = new Date()): AdminUser {
    const u = validateUsername(username);
    validatePassword(password);
    const data = this.load();
    if (data.users.some((x) => x.username === u)) throw new AdminError(`There is already a user called ${u}.`);
    const user: AdminUser = { username: u, passwordHash: hashPassword(password), createdAt: now.toISOString() };
    this.save({ users: [...data.users, user] });
    return user;
  }

  /** Returns the user when the password is right, otherwise undefined. */
  verify(username: string, password: string): AdminUser | undefined {
    const user = this.get(username);
    const ok = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    return ok && user ? user : undefined;
  }

  changePassword(username: string, current: string, next: string): void {
    const user = this.verify(username, current);
    if (!user) throw new AdminError('Your current password is wrong.');
    validatePassword(next);
    const data = this.load();
    this.save({ users: data.users.map((u) => (u.username === user.username ? { ...u, passwordHash: hashPassword(next) } : u)) });
  }

  /** Sets a new password without the old one. Only used by the protected recovery page. */
  resetPassword(username: string, password: string): AdminUser {
    validatePassword(password);
    const user = this.get(username);
    if (!user) throw new AdminError(`There is no user called ${username}.`);
    const updated = { ...user, passwordHash: hashPassword(password) };
    this.save({ users: this.load().users.map((u) => (u.username === user.username ? updated : u)) });
    return updated;
  }

  remove(username: string, by: string): void {
    const u = username.trim().toLowerCase();
    if (u === by) throw new AdminError('You can’t remove yourself. Ask another admin to do it.');
    const data = this.load();
    if (!data.users.some((x) => x.username === u)) throw new AdminError(`There is no user called ${u}.`);
    if (data.users.length <= 1) throw new AdminError('There must always be at least one admin.');
    this.save({ users: data.users.filter((x) => x.username !== u) });
  }
}
