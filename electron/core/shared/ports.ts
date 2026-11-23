// Ports every core feature may use. Filled once per process by electron/app (wiring, worker and CLI entries) and by
// tests (fakes); nothing else calls provide*/resetCorePorts (enforced by tests/architecture/import-boundaries.test.ts).
export interface Hasher { /** sha256 of UTF-8 text as 64 lowercase hex characters. */ sha256(text: string): string }

let hasher: Hasher | undefined;
const missing = (port: string) => new Error(`${port} port not provided; wire it in electron/app.`);
export function provideHasher(value: Hasher) { hasher = value; }
export function sha256(text: string): string { if (!hasher) throw missing('Hasher'); return hasher.sha256(text); }
/** Tests only: forget every provided port. */
export function resetCorePorts() { hasher = undefined; }

/** Key/value rows of the app database's settings table (synchronous: read on every graph open). */
export interface SettingsRepository { get(key: string): string | undefined; set(key: string, value: string): void }
