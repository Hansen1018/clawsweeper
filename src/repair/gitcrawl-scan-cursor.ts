import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  GitcrawlClusterOrderKey,
  GitcrawlEvidenceResumeCursor,
  GitcrawlThreadOrderKey,
} from "./gitcrawl-evidence-contract.js";
import {
  assertGitcrawlProviderCursor,
  assertSha256,
  assertSnapshotId,
  parseRfc3339Timestamp,
} from "./gitcrawl-evidence-contract.js";
import { fsyncGitcrawlDirectory } from "./gitcrawl-filesystem.js";

const SCHEMA = "clawsweeper-gitcrawl-scan-cursors-v4";
const LEGACY_SCHEMA_V3 = "clawsweeper-gitcrawl-scan-cursors-v3";
const LEGACY_SCHEMA_V2 = "clawsweeper-gitcrawl-scan-cursors-v2";
const FILE_NAME = ".gitcrawl-scan-cursors.json";
const LEGACY_LOCK_FILE_NAME = ".gitcrawl-scan-cursors.lock";
const LOCK_DIRECTORY_NAME = ".gitcrawl-scan-cursors.lock-v2";
const LOCK_MIGRATION_NAME = ".gitcrawl-scan-cursors.lock-migration";
const LOCK_MIGRATION_DATABASE_NAME = ".gitcrawl-scan-cursors.lock-migration.sqlite";
const LOCK_DATABASE_NAME = "lock.sqlite";
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_ENTRY_MAX_BYTES = 64 * 1024;

export type GitcrawlCursorLockTestHooks = {
  now?: () => number;
  beforeQuarantineRename?: (input: { entryPath: string; quarantinePath: string }) => void;
  beforeQuarantineRestore?: (input: { entryPath: string; quarantinePath: string }) => void;
  beforeCursorPublish?: (input: { target: string; temporary: string }) => void;
  beforeLockDatabasePublish?: (input: { databasePath: string; temporary: string }) => void;
  beforeLegacyMigrationDatabasePublish?: (input: {
    databasePath: string;
    temporary: string;
  }) => void;
  beforeLegacyMigrationDatabaseLink?: (input: { databasePath: string; temporary: string }) => void;
  beforeLegacyGuardValidate?: (input: { lockPath: string }) => void;
};

let cursorLockTestHooks: GitcrawlCursorLockTestHooks = {};

export function __setGitcrawlCursorLockTestHooks(hooks: GitcrawlCursorLockTestHooks): () => void {
  const previous = cursorLockTestHooks;
  cursorLockTestHooks = { ...hooks };
  return () => {
    cursorLockTestHooks = previous;
  };
}

type CursorEntry = {
  offset: number;
  archive: string;
  snapshot_id: string;
  provider_cursor: string;
  query_sha256: string;
  parity_archive?: string;
  parity_snapshot_id?: string;
  parity_provider_cursor?: string;
  order_key?: {
    updated_at: string;
    number: number;
  };
  cluster_order_key?: {
    member_count: number;
    updated_at: string;
    id: number;
  };
  updated_at: string;
};

type CursorFile = {
  schema: typeof SCHEMA;
  cursors: Record<string, CursorEntry>;
};

type LegacyV3CursorEntry = Omit<CursorEntry, "archive" | "parity_archive">;
type LegacyV2CursorEntry = Omit<LegacyV3CursorEntry, "query_sha256">;

type PinnedEntry = {
  children?: Map<string, PinnedEntry>;
  contents?: Buffer;
  descriptor?: number;
  stat: fs.Stats;
};

export function readGitcrawlScanCursor(
  directory: string,
  key: string,
): GitcrawlEvidenceResumeCursor | undefined {
  const entry = readCursorFile(directory).cursors[key];
  if (entry === undefined) return undefined;
  assertCursorEntry(entry, key);
  return {
    offset: entry.offset,
    archive: entry.archive,
    snapshotId: entry.snapshot_id,
    providerCursor: entry.provider_cursor,
    querySha256: entry.query_sha256,
    ...(entry.parity_archive === undefined ? {} : { parityArchive: entry.parity_archive }),
    ...(entry.parity_snapshot_id === undefined
      ? {}
      : { paritySnapshotId: entry.parity_snapshot_id }),
    ...(entry.parity_provider_cursor === undefined
      ? {}
      : { parityProviderCursor: entry.parity_provider_cursor }),
    ...(entry.order_key === undefined
      ? {}
      : {
          orderKey: {
            updatedAt: entry.order_key.updated_at,
            number: entry.order_key.number,
          },
        }),
    ...(entry.cluster_order_key === undefined
      ? {}
      : {
          clusterOrderKey: {
            memberCount: entry.cluster_order_key.member_count,
            updatedAt: entry.cluster_order_key.updated_at,
            id: entry.cluster_order_key.id,
          },
        }),
  };
}

export function readGitcrawlScanOffset(directory: string, key: string): number {
  return readGitcrawlScanCursor(directory, key)?.offset ?? 0;
}

export function compatibleGitcrawlScanCursor(
  cursor: GitcrawlEvidenceResumeCursor | undefined,
  archive: string,
  snapshotId: string,
  parityArchive?: string,
  paritySnapshotId?: string,
): GitcrawlEvidenceResumeCursor | undefined {
  if (cursor === undefined || cursor.offset === 0) return undefined;
  if (
    cursor.archive === archive &&
    cursor.snapshotId === snapshotId &&
    cursor.parityArchive === parityArchive &&
    cursor.paritySnapshotId === paritySnapshotId
  ) {
    return cursor;
  }
  return undefined;
}

export function writeGitcrawlScanOffset(input: {
  directory: string;
  key: string;
  offset: number;
  archive: string;
  snapshotId: string;
  providerCursor: string;
  querySha256: string;
  parityArchive?: string;
  paritySnapshotId?: string;
  parityProviderCursor?: string;
  orderKey?: GitcrawlThreadOrderKey;
  clusterOrderKey?: GitcrawlClusterOrderKey;
  updatedAt?: string;
  expected?: GitcrawlEvidenceResumeCursor;
}): void {
  assertOffset(input.offset, input.key);
  assertArchiveIdentity(input.archive, `Gitcrawl scan cursor archive for ${input.key}`);
  assertSnapshotId(input.snapshotId);
  assertSha256(input.querySha256, `Gitcrawl scan cursor query digest for ${input.key}`);
  assertProviderCursor(input.providerCursor, input.offset, input.key);
  assertParityState(input);
  if (input.orderKey !== undefined) assertOrderKey(input.orderKey, input.key);
  if (input.clusterOrderKey !== undefined) {
    assertClusterOrderKey(input.clusterOrderKey, input.key);
  }
  if (input.orderKey !== undefined && input.clusterOrderKey !== undefined) {
    throw new Error(`malformed Gitcrawl scan cursor order key: ${input.key}`);
  }
  if (input.offset === 0 && (input.orderKey !== undefined || input.clusterOrderKey !== undefined)) {
    throw new Error(`malformed Gitcrawl scan cursor order key: ${input.key}`);
  }
  if (input.updatedAt !== undefined) {
    parseRfc3339Timestamp(input.updatedAt, `Gitcrawl scan cursor updated_at for ${input.key}`);
  }
  fs.mkdirSync(input.directory, { recursive: true });
  withCursorFileLock(input.directory, () => {
    const file = readCursorFile(input.directory);
    const previous = file.cursors[input.key];
    if (input.expected !== undefined && !cursorEntryMatches(previous, input.expected)) {
      throw new Error(`Gitcrawl scan cursor changed before update: ${input.key}`);
    }
    const next: CursorEntry = {
      offset: input.offset,
      archive: input.archive,
      snapshot_id: input.snapshotId,
      provider_cursor: input.providerCursor,
      query_sha256: input.querySha256,
      ...(input.parityArchive === undefined ? {} : { parity_archive: input.parityArchive }),
      ...(input.paritySnapshotId === undefined
        ? {}
        : { parity_snapshot_id: input.paritySnapshotId }),
      ...(input.parityProviderCursor === undefined
        ? {}
        : { parity_provider_cursor: input.parityProviderCursor }),
      ...(input.orderKey === undefined
        ? {}
        : {
            order_key: {
              updated_at: input.orderKey.updatedAt,
              number: input.orderKey.number,
            },
          }),
      ...(input.clusterOrderKey === undefined
        ? {}
        : {
            cluster_order_key: {
              member_count: input.clusterOrderKey.memberCount,
              updated_at: input.clusterOrderKey.updatedAt,
              id: input.clusterOrderKey.id,
            },
          }),
      updated_at: input.updatedAt ?? new Date().toISOString(),
    };
    if (!acceptMonotonicCursorUpdate(previous, next, input.key, input.expected !== undefined)) {
      return;
    }
    file.cursors[input.key] = next;
    const sorted: CursorFile = {
      schema: SCHEMA,
      cursors: Object.fromEntries(
        Object.entries(file.cursors).sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    writeCursorFileAtomic(cursorPath(input.directory), `${JSON.stringify(sorted, null, 2)}\n`);
  });
}

function readCursorFile(directory: string): CursorFile {
  const filePath = cursorPath(directory);
  if (!fs.existsSync(filePath)) return { schema: SCHEMA, cursors: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`malformed Gitcrawl scan cursor file: ${filePath}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    ![SCHEMA, LEGACY_SCHEMA_V3, LEGACY_SCHEMA_V2].includes(
      String((parsed as { schema?: unknown }).schema),
    ) ||
    typeof (parsed as { cursors?: unknown }).cursors !== "object" ||
    (parsed as { cursors?: unknown }).cursors === null ||
    Array.isArray((parsed as { cursors?: unknown }).cursors)
  ) {
    throw new Error(`malformed Gitcrawl scan cursor file: ${filePath}`);
  }
  const schema = (parsed as { schema: string }).schema;
  const cursors = (parsed as { cursors: Record<string, unknown> }).cursors;
  if (schema === LEGACY_SCHEMA_V2) {
    for (const [key, entry] of Object.entries(cursors)) assertLegacyV2CursorEntry(entry, key);
    return { schema: SCHEMA, cursors: {} };
  }
  if (schema === LEGACY_SCHEMA_V3) {
    for (const [key, entry] of Object.entries(cursors)) assertLegacyV3CursorEntry(entry, key);
    return { schema: SCHEMA, cursors: {} };
  }
  for (const [key, entry] of Object.entries(cursors)) assertCursorEntry(entry, key);
  return parsed as CursorFile;
}

function assertCursorEntry(entry: unknown, key: string): asserts entry is CursorEntry {
  assertCursorEntryBase(entry, key, true);
  if (typeof (entry as { query_sha256?: unknown }).query_sha256 !== "string") {
    throw new Error(`malformed Gitcrawl scan cursor entry: ${key}`);
  }
  try {
    assertSha256(
      (entry as { query_sha256: string }).query_sha256,
      `Gitcrawl scan cursor query digest for ${key}`,
    );
  } catch {
    throw new Error(`malformed Gitcrawl scan cursor entry: ${key}`);
  }
}

function assertLegacyV3CursorEntry(
  entry: unknown,
  key: string,
): asserts entry is LegacyV3CursorEntry {
  assertCursorEntryBase(entry, key, false);
  if (typeof (entry as { query_sha256?: unknown }).query_sha256 !== "string") {
    throw new Error(`malformed Gitcrawl scan cursor entry: ${key}`);
  }
  try {
    assertSha256(
      (entry as { query_sha256: string }).query_sha256,
      `Gitcrawl scan cursor query digest for ${key}`,
    );
  } catch {
    throw new Error(`malformed Gitcrawl scan cursor entry: ${key}`);
  }
}

function assertLegacyV2CursorEntry(
  entry: unknown,
  key: string,
): asserts entry is LegacyV2CursorEntry {
  assertCursorEntryBase(entry, key, false);
}

function assertCursorEntryBase(entry: unknown, key: string, archiveRequired: boolean): void {
  const candidate = entry as Partial<CursorEntry>;
  if (
    typeof entry !== "object" ||
    entry === null ||
    (archiveRequired && typeof candidate.archive !== "string") ||
    typeof candidate.snapshot_id !== "string" ||
    typeof candidate.provider_cursor !== "string" ||
    typeof candidate.updated_at !== "string"
  ) {
    throw new Error(`malformed Gitcrawl scan cursor entry: ${key}`);
  }
  try {
    if (archiveRequired) {
      assertArchiveIdentity(candidate.archive!, `Gitcrawl scan cursor archive for ${key}`);
    }
    assertSnapshotId(candidate.snapshot_id);
    assertOffset(candidate.offset!, key);
    assertProviderCursor(candidate.provider_cursor, candidate.offset!, key);
    assertParityState({
      key,
      offset: candidate.offset!,
      ...(candidate.parity_archive === undefined
        ? {}
        : { parityArchive: candidate.parity_archive }),
      ...(candidate.parity_snapshot_id === undefined
        ? {}
        : { paritySnapshotId: candidate.parity_snapshot_id }),
      ...(candidate.parity_provider_cursor === undefined
        ? {}
        : { parityProviderCursor: candidate.parity_provider_cursor }),
    });
    if (candidate.order_key !== undefined) {
      assertOrderKey(
        {
          updatedAt: candidate.order_key.updated_at,
          number: candidate.order_key.number,
        },
        key,
      );
      if (candidate.offset === 0) throw new Error("order key without progress");
    }
    if (candidate.cluster_order_key !== undefined) {
      assertClusterOrderKey(
        {
          memberCount: candidate.cluster_order_key.member_count,
          updatedAt: candidate.cluster_order_key.updated_at,
          id: candidate.cluster_order_key.id,
        },
        key,
      );
      if (candidate.offset === 0) throw new Error("cluster order key without progress");
    }
    if (candidate.order_key !== undefined && candidate.cluster_order_key !== undefined) {
      throw new Error("mixed order keys");
    }
    parseRfc3339Timestamp(candidate.updated_at, `Gitcrawl scan cursor updated_at for ${key}`);
  } catch {
    throw new Error(`malformed Gitcrawl scan cursor entry: ${key}`);
  }
}

function assertParityState(input: {
  key: string;
  offset: number;
  parityArchive?: string;
  paritySnapshotId?: string;
  parityProviderCursor?: string;
}): void {
  const hasArchive = input.parityArchive !== undefined;
  const hasSnapshot = input.paritySnapshotId !== undefined;
  const hasCursor = input.parityProviderCursor !== undefined;
  if (hasArchive !== hasSnapshot || hasSnapshot !== hasCursor) {
    throw new Error(`malformed Gitcrawl parity scan cursor: ${input.key}`);
  }
  if (!hasSnapshot) return;
  assertArchiveIdentity(
    input.parityArchive!,
    `Gitcrawl parity scan cursor archive for ${input.key}`,
  );
  assertSnapshotId(input.paritySnapshotId!);
  assertProviderCursor(input.parityProviderCursor!, input.offset, input.key);
}

function assertOrderKey(orderKey: GitcrawlThreadOrderKey, key: string): void {
  parseRfc3339Timestamp(orderKey.updatedAt, `Gitcrawl scan cursor order key for ${key}`);
  if (!Number.isSafeInteger(orderKey.number) || orderKey.number <= 0) {
    throw new Error(`malformed Gitcrawl scan cursor order key: ${key}`);
  }
}

function assertClusterOrderKey(orderKey: GitcrawlClusterOrderKey, key: string): void {
  parseRfc3339Timestamp(orderKey.updatedAt, `Gitcrawl cluster scan cursor order key for ${key}`);
  if (
    !Number.isSafeInteger(orderKey.memberCount) ||
    orderKey.memberCount < 0 ||
    !Number.isSafeInteger(orderKey.id) ||
    orderKey.id <= 0
  ) {
    throw new Error(`malformed Gitcrawl cluster scan cursor order key: ${key}`);
  }
}

function assertProviderCursor(cursor: string, offset: number, key: string): void {
  try {
    assertGitcrawlProviderCursor(cursor, `Gitcrawl provider cursor for ${key}`, offset === 0);
  } catch {
    throw new Error(`malformed Gitcrawl provider cursor: ${key}`);
  }
  if (offset === 0 && cursor !== "") throw new Error(`malformed Gitcrawl provider cursor: ${key}`);
}

function assertOffset(offset: number, key: string): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`malformed Gitcrawl scan cursor offset: ${key}`);
  }
}

function assertArchiveIdentity(archive: string, label: string): void {
  if (
    archive !== archive.trim() ||
    archive.length === 0 ||
    archive.length > 2_048 ||
    [...archive].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error(`${label} is malformed`);
  }
}

function cursorPath(directory: string): string {
  return path.join(directory, FILE_NAME);
}

function cursorEntryMatches(
  entry: CursorEntry | undefined,
  expected: GitcrawlEvidenceResumeCursor,
): boolean {
  if (entry === undefined) return false;
  return (
    entry.offset === expected.offset &&
    entry.archive === expected.archive &&
    entry.snapshot_id === expected.snapshotId &&
    entry.provider_cursor === expected.providerCursor &&
    entry.query_sha256 === expected.querySha256 &&
    entry.parity_archive === expected.parityArchive &&
    entry.parity_snapshot_id === expected.paritySnapshotId &&
    entry.parity_provider_cursor === expected.parityProviderCursor &&
    entry.order_key?.updated_at === expected.orderKey?.updatedAt &&
    entry.order_key?.number === expected.orderKey?.number &&
    entry.cluster_order_key?.member_count === expected.clusterOrderKey?.memberCount &&
    entry.cluster_order_key?.updated_at === expected.clusterOrderKey?.updatedAt &&
    entry.cluster_order_key?.id === expected.clusterOrderKey?.id
  );
}

function acceptMonotonicCursorUpdate(
  previous: CursorEntry | undefined,
  next: CursorEntry,
  key: string,
  expectedPrevious: boolean,
): boolean {
  if (previous === undefined) return true;
  if (previous.query_sha256 !== next.query_sha256) {
    throw new Error(`Gitcrawl scan cursor query changed for existing key: ${key}`);
  }
  const sameGeneration =
    previous.archive === next.archive &&
    previous.snapshot_id === next.snapshot_id &&
    previous.parity_archive === next.parity_archive &&
    previous.parity_snapshot_id === next.parity_snapshot_id;
  if (!sameGeneration) {
    if (!expectedPrevious) {
      throw new Error(`Gitcrawl scan cursor generation changed without compare-and-swap: ${key}`);
    }
    return true;
  }
  if (next.offset === 0 && previous.offset > 0) return false;
  if (next.offset < previous.offset) {
    throw new Error(`Gitcrawl scan cursor update is regressive: ${key}`);
  }
  if (next.offset > previous.offset) return true;
  const previousComparable = { ...previous, updated_at: "" };
  const nextComparable = { ...next, updated_at: "" };
  if (JSON.stringify(previousComparable) !== JSON.stringify(nextComparable)) {
    throw new Error(`Gitcrawl scan cursor conflicts at offset ${next.offset}: ${key}`);
  }
  return false;
}

function writeCursorFileAtomic(target: string, contents: string): void {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target).replace(/^\./, "")}.write-${crypto.randomUUID()}`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const bytes = Buffer.from(contents);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("Gitcrawl cursor write made no progress");
      offset += written;
    }
    fs.fsyncSync(descriptor);
    cursorLockTestHooks.beforeCursorPublish?.({ target, temporary });
    const pinned = fs.fstatSync(descriptor);
    const current = fs.lstatSync(temporary, { throwIfNoEntry: false });
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameInodeIdentity(pinned, current) ||
      current.size !== bytes.length
    ) {
      throw new Error("Gitcrawl cursor temporary changed before publication");
    }
    fs.renameSync(temporary, target);
    const published = fs.lstatSync(target);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      !sameInodeIdentity(pinned, published)
    ) {
      throw new Error("Gitcrawl cursor file changed during publication");
    }
    fsyncGitcrawlDirectory(path.dirname(target));
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function withCursorFileLock<T>(directory: string, action: () => T): T {
  const lockPath = path.join(directory, LOCK_DIRECTORY_NAME);
  const deadline = cursorLockNow() + LOCK_WAIT_MS;
  while (!ensureSqliteLockDirectory(lockPath)) {
    if (cursorLockNow() >= deadline) {
      throw new Error(`timed out waiting for Gitcrawl scan cursor lock: ${lockPath}`);
    }
    sleep(LOCK_RETRY_MS);
  }
  const lock = openPinnedSqliteDatabase(path.join(lockPath, LOCK_DATABASE_NAME));
  let legacyGuard: LegacyGuard | undefined;
  let transaction = false;
  try {
    lock.database.exec(`pragma busy_timeout = ${LOCK_WAIT_MS}`);
    lock.database.exec("begin immediate");
    transaction = true;
    legacyGuard = acquireLegacyGuard(directory, deadline);
    const result = action();
    releaseLegacyGuard(legacyGuard);
    legacyGuard = undefined;
    lock.database.exec("commit");
    transaction = false;
    return result;
  } catch (error) {
    if (legacyGuard !== undefined) {
      try {
        releaseLegacyGuard(legacyGuard);
      } catch {}
    }
    if (transaction) {
      try {
        lock.database.exec("rollback");
      } catch {}
    }
    if (sqliteBusy(error)) {
      throw new Error(`timed out waiting for Gitcrawl scan cursor lock: ${lockPath}`);
    }
    throw error;
  } finally {
    closePinnedSqliteDatabase(lock);
  }
}

type PinnedSqliteDatabase = {
  database: DatabaseSync;
  descriptor: number;
  path: string;
};

type LegacyBridgeGuard =
  | { kind: "file"; descriptor: number; lockPath: string; stat: fs.Stats }
  | { kind: "sqlite"; lock: PinnedSqliteDatabase; transaction: boolean };

type LegacyGuard = {
  bridge: LegacyBridgeGuard;
  migration: PinnedSqliteDatabase;
};

function ensureSqliteLockDirectory(lockPath: string): boolean {
  const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (stat !== undefined) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Gitcrawl cursor lock namespace must be a real directory: ${lockPath}`);
    }
    if (sqliteLockReady(lockPath)) return true;
    if (
      cursorLockNow() - stat.mtimeMs >= LOCK_STALE_MS &&
      reclaimInterruptedSqliteLockInitialization(lockPath, stat)
    ) {
      return false;
    }
    if (cursorLockNow() - stat.mtimeMs < LOCK_STALE_MS) return false;
    throw new Error(`Gitcrawl cursor lock database failed identity validation: ${lockPath}`);
  }
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
  try {
    initializeSqliteLockDatabase(path.join(lockPath, LOCK_DATABASE_NAME));
    return true;
  } catch (error) {
    try {
      fs.rmdirSync(lockPath);
    } catch {}
    throw error;
  }
}

function initializeSqliteLockDatabase(databasePath: string): void {
  const temporary = path.join(
    path.dirname(databasePath),
    `.${path.basename(databasePath).replace(/^\./, "")}.init-${crypto.randomUUID()}`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const initial = fs.fstatSync(descriptor);
    if (!initial.isFile()) throw new Error("Gitcrawl cursor lock temporary is not a regular file");
    const database = new DatabaseSync(temporary, { timeout: LOCK_WAIT_MS });
    try {
      database.exec("pragma journal_mode = delete");
      database.exec("create table lock_guard (id integer primary key check (id = 1))");
    } finally {
      database.close();
    }
    fs.fsyncSync(descriptor);
    cursorLockTestHooks.beforeLockDatabasePublish?.({ databasePath, temporary });
    const completed = fs.fstatSync(descriptor);
    const current = fs.lstatSync(temporary, { throwIfNoEntry: false });
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameInodeIdentity(completed, current)
    ) {
      throw new Error("Gitcrawl cursor lock database changed before publication");
    }
    fs.linkSync(temporary, databasePath);
    const linkedSource = fs.lstatSync(temporary);
    const published = fs.lstatSync(databasePath);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      !sameInodeIdentity(completed, published)
    ) {
      if (sameInodeIdentity(linkedSource, published)) {
        removePublishedPathByIdentity(databasePath, linkedSource);
      }
      throw new Error("Gitcrawl cursor lock database changed during publication");
    }
    fsyncGitcrawlDirectory(path.dirname(databasePath));
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function sqliteLockReady(lockPath: string): boolean {
  const databasePath = path.join(lockPath, LOCK_DATABASE_NAME);
  const stat = fs.lstatSync(databasePath, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Gitcrawl cursor lock database must be a regular file: ${databasePath}`);
  }
  let lock: PinnedSqliteDatabase | undefined;
  try {
    lock = openPinnedSqliteDatabase(databasePath, true);
    return (
      String(
        lock.database
          .prepare("select name from sqlite_master where type = 'table' and name = 'lock_guard'")
          .get()?.name ?? "",
      ) === "lock_guard"
    );
  } finally {
    if (lock !== undefined) closePinnedSqliteDatabase(lock);
  }
}

function reclaimInterruptedSqliteLockInitialization(lockPath: string, stat: fs.Stats): boolean {
  const entries = fs.readdirSync(lockPath);
  if (
    entries.some(
      (entry) =>
        !/^\.lock\.sqlite\.init-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          entry,
        ),
    )
  ) {
    return false;
  }
  const pinned = pinUnchangedEntry(lockPath, stat);
  if (pinned === undefined) return false;
  let quarantinePath: string | undefined;
  try {
    quarantinePath = quarantineUnchangedEntry(lockPath, pinned);
  } finally {
    releasePinnedEntry(pinned);
  }
  if (quarantinePath === undefined) return false;
  fs.rmSync(quarantinePath, { force: true, recursive: true });
  return true;
}

function openPinnedSqliteDatabase(databasePath: string, readOnly = false): PinnedSqliteDatabase {
  const before = fs.lstatSync(databasePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Gitcrawl cursor lock database must be a regular file: ${databasePath}`);
  }
  const descriptor = fs.openSync(
    databasePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const pinned = fs.fstatSync(descriptor);
    if (!sameInodeIdentity(before, pinned)) {
      throw new Error(`Gitcrawl cursor lock database changed before open: ${databasePath}`);
    }
    const database = new DatabaseSync(databasePath, { readOnly, timeout: LOCK_WAIT_MS });
    const after = fs.lstatSync(databasePath, { throwIfNoEntry: false });
    if (
      after === undefined ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      !sameInodeIdentity(pinned, after)
    ) {
      database.close();
      throw new Error(`Gitcrawl cursor lock database changed during open: ${databasePath}`);
    }
    return { database, descriptor, path: databasePath };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function closePinnedSqliteDatabase(lock: PinnedSqliteDatabase): void {
  lock.database.close();
  fs.closeSync(lock.descriptor);
}

function acquireLegacyGuard(directory: string, deadline: number): LegacyGuard {
  const lockPath = path.join(directory, LEGACY_LOCK_FILE_NAME);
  const migrationPath = path.join(directory, LOCK_MIGRATION_NAME);
  const migrationDatabasePath = path.join(directory, LOCK_MIGRATION_DATABASE_NAME);
  for (;;) {
    const migration = tryAcquireLegacyMigrationGuard(migrationDatabasePath);
    if (migration !== undefined) {
      let keepMigration = false;
      try {
        if (removeAbandonedLegacyMigration(migrationPath)) {
          const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
          if (stat === undefined) {
            const bridge = tryCreateLegacyFileGuard(lockPath);
            if (bridge !== undefined) {
              keepMigration = true;
              return { bridge, migration };
            }
          } else if (stat.isDirectory()) {
            const bridge = tryAcquireLegacySqliteGuard(lockPath);
            if (bridge.status === "acquired") {
              keepMigration = true;
              return { bridge: bridge.guard, migration };
            }
            if (bridge.status === "not_sqlite") reclaimLegacyLock(lockPath, stat);
          } else {
            reclaimLegacyLock(lockPath, stat);
          }
        }
      } finally {
        if (!keepMigration) releaseLegacyMigrationGuard(migration);
      }
    }
    if (cursorLockNow() >= deadline) {
      throw new Error(`timed out waiting for Gitcrawl scan cursor lock: ${lockPath}`);
    }
    sleep(LOCK_RETRY_MS);
  }
}

function tryCreateLegacyFileGuard(lockPath: string): LegacyBridgeGuard | undefined {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (isAlreadyExists(error)) return undefined;
    throw error;
  }
  let pinned: fs.Stats | undefined;
  try {
    pinned = fs.fstatSync(descriptor);
    if (!pinned.isFile()) {
      throw new Error(`Gitcrawl legacy cursor guard is not a regular file: ${lockPath}`);
    }
    const contents = `${JSON.stringify({
      pid: process.pid,
      token: crypto.randomUUID(),
      acquired_at: new Date(cursorLockNow()).toISOString(),
    })}\n`;
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    cursorLockTestHooks.beforeLegacyGuardValidate?.({ lockPath });
    const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameInodeIdentity(pinned, current)
    ) {
      throw new Error(`Gitcrawl legacy cursor guard changed during acquisition: ${lockPath}`);
    }
    return { kind: "file", descriptor, lockPath, stat: pinned };
  } catch (error) {
    fs.closeSync(descriptor);
    const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      current !== undefined &&
      pinned !== undefined &&
      !current.isSymbolicLink() &&
      current.isFile() &&
      sameInodeIdentity(pinned, current)
    ) {
      fs.unlinkSync(lockPath);
    }
    throw error;
  }
}

function tryAcquireLegacySqliteGuard(
  lockPath: string,
):
  | { status: "acquired"; guard: LegacyBridgeGuard }
  | { status: "busy" }
  | { status: "not_sqlite" } {
  const databasePath = path.join(lockPath, LOCK_DATABASE_NAME);
  const stat = fs.lstatSync(databasePath, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
    return { status: "not_sqlite" };
  }
  let lock: PinnedSqliteDatabase;
  try {
    lock = openPinnedSqliteDatabase(databasePath);
  } catch {
    return { status: "not_sqlite" };
  }
  try {
    const table = String(
      lock.database
        .prepare("select name from sqlite_master where type = 'table' and name = 'lock_guard'")
        .get()?.name ?? "",
    );
    if (table !== "lock_guard") {
      closePinnedSqliteDatabase(lock);
      return { status: "not_sqlite" };
    }
    lock.database.exec(`pragma busy_timeout = ${LOCK_WAIT_MS}`);
    lock.database.exec("begin immediate");
    fs.utimesSync(databasePath, new Date(), new Date());
    return { status: "acquired", guard: { kind: "sqlite", lock, transaction: true } };
  } catch (error) {
    closePinnedSqliteDatabase(lock);
    if (sqliteBusy(error)) return { status: "busy" };
    return { status: "not_sqlite" };
  }
}

function reclaimLegacyLock(lockPath: string, stat: fs.Stats): void {
  const staleLock = pinStaleLegacyLock(lockPath, stat);
  if (staleLock === undefined) return;
  let quarantinePath: string | undefined;
  try {
    quarantinePath = quarantineUnchangedEntry(lockPath, staleLock);
  } finally {
    releasePinnedEntry(staleLock);
  }
  if (quarantinePath !== undefined) {
    fs.rmSync(quarantinePath, { force: true, recursive: true });
  }
}

function releaseLegacyGuard(guard: LegacyGuard): void {
  try {
    releaseLegacyBridgeGuard(guard.bridge);
  } finally {
    releaseLegacyMigrationGuard(guard.migration);
  }
}

function releaseLegacyBridgeGuard(guard: LegacyBridgeGuard): void {
  if (guard.kind === "sqlite") {
    if (guard.transaction) guard.lock.database.exec("commit");
    closePinnedSqliteDatabase(guard.lock);
    return;
  }
  try {
    const current = fs.lstatSync(guard.lockPath, { throwIfNoEntry: false });
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameInodeIdentity(guard.stat, current)
    ) {
      throw new Error(`Gitcrawl legacy cursor guard changed before release: ${guard.lockPath}`);
    }
    fs.unlinkSync(guard.lockPath);
  } finally {
    fs.closeSync(guard.descriptor);
  }
}

function tryAcquireLegacyMigrationGuard(databasePath: string): PinnedSqliteDatabase | undefined {
  ensureLegacyMigrationDatabase(databasePath);
  let lock: PinnedSqliteDatabase;
  try {
    lock = openPinnedSqliteDatabase(databasePath);
  } catch (error) {
    if (sqliteBusy(error)) return undefined;
    throw error;
  }
  try {
    lock.database.exec(`pragma busy_timeout = ${LOCK_WAIT_MS}`);
    lock.database.exec(
      "create table if not exists migration_guard (id integer primary key check (id = 1))",
    );
    lock.database.exec("begin immediate");
    return lock;
  } catch (error) {
    closePinnedSqliteDatabase(lock);
    if (sqliteBusy(error)) return undefined;
    throw error;
  }
}

function releaseLegacyMigrationGuard(lock: PinnedSqliteDatabase): void {
  try {
    lock.database.exec("commit");
  } finally {
    closePinnedSqliteDatabase(lock);
  }
}

function ensureLegacyMigrationDatabase(databasePath: string): void {
  const stat = fs.lstatSync(databasePath, { throwIfNoEntry: false });
  if (stat !== undefined) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Gitcrawl cursor migration database must be a regular file: ${databasePath}`);
    }
    return;
  }
  const temporary = path.join(
    path.dirname(databasePath),
    `.${path.basename(databasePath).replace(/^\./, "")}.init-${crypto.randomUUID()}`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const initial = fs.fstatSync(descriptor);
    if (!initial.isFile()) {
      throw new Error("Gitcrawl cursor migration database temporary is not a regular file");
    }
    const database = new DatabaseSync(temporary, { timeout: LOCK_WAIT_MS });
    try {
      database.exec("pragma journal_mode = delete");
      database.exec("create table migration_guard (id integer primary key check (id = 1))");
    } finally {
      database.close();
    }
    fs.fsyncSync(descriptor);
    cursorLockTestHooks.beforeLegacyMigrationDatabasePublish?.({
      databasePath,
      temporary,
    });
    const completed = fs.fstatSync(descriptor);
    const current = fs.lstatSync(temporary, { throwIfNoEntry: false });
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameInodeIdentity(completed, current)
    ) {
      throw new Error("Gitcrawl cursor migration database changed before publication");
    }
    try {
      cursorLockTestHooks.beforeLegacyMigrationDatabaseLink?.({
        databasePath,
        temporary,
      });
      fs.linkSync(temporary, databasePath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return;
    }
    const linkedSource = fs.lstatSync(temporary);
    const published = fs.lstatSync(databasePath);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      !sameInodeIdentity(completed, published)
    ) {
      if (sameInodeIdentity(linkedSource, published)) {
        removePublishedPathByIdentity(databasePath, linkedSource);
      }
      throw new Error("Gitcrawl cursor migration database changed during publication");
    }
    fsyncGitcrawlDirectory(path.dirname(databasePath));
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function removePublishedPathByIdentity(entryPath: string, expected: fs.Stats): void {
  const quarantinePath = `${entryPath}.cleanup-${crypto.randomUUID()}`;
  fs.renameSync(entryPath, quarantinePath);
  const moved = fs.lstatSync(quarantinePath, { throwIfNoEntry: false });
  if (moved !== undefined && sameInodeIdentity(expected, moved)) {
    fs.unlinkSync(quarantinePath);
    fsyncGitcrawlDirectory(path.dirname(entryPath));
    return;
  }
  if (moved !== undefined) {
    fs.linkSync(quarantinePath, entryPath);
    fs.unlinkSync(quarantinePath);
  }
  throw new Error(`Gitcrawl cursor publication changed during cleanup: ${entryPath}`);
}

function removeAbandonedLegacyMigration(migrationPath: string): boolean {
  const stat = fs.lstatSync(migrationPath, { throwIfNoEntry: false });
  if (stat === undefined) return true;
  if (cursorLockNow() - stat.mtimeMs < LOCK_STALE_MS) return false;
  const pinned = pinUnchangedEntry(migrationPath, stat);
  if (pinned === undefined) return false;
  let quarantinePath: string | undefined;
  try {
    quarantinePath = quarantineUnchangedEntry(migrationPath, pinned);
  } finally {
    releasePinnedEntry(pinned);
  }
  if (quarantinePath === undefined) return false;
  fs.rmSync(quarantinePath, { force: true, recursive: true });
  return true;
}

function quarantineUnchangedEntry(entryPath: string, expected: PinnedEntry): string | undefined {
  const quarantinePath = `${entryPath}.stale-${crypto.randomUUID()}`;
  cursorLockTestHooks.beforeQuarantineRename?.({ entryPath, quarantinePath });
  try {
    fs.renameSync(entryPath, quarantinePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const quarantined = fs.lstatSync(quarantinePath, { throwIfNoEntry: false });
  if (quarantined !== undefined && pinnedEntryMatches(expected, quarantined, quarantinePath)) {
    return quarantinePath;
  }
  restoreQuarantinedEntry(entryPath, quarantinePath);
  return undefined;
}

function restoreQuarantinedEntry(entryPath: string, quarantinePath: string): void {
  cursorLockTestHooks.beforeQuarantineRestore?.({ entryPath, quarantinePath });
  try {
    const stat = fs.lstatSync(quarantinePath);
    if (stat.isDirectory()) {
      restoreQuarantinedDirectory(entryPath, quarantinePath, stat.mode);
    } else {
      fs.linkSync(quarantinePath, entryPath);
      fs.unlinkSync(quarantinePath);
    }
  } catch (error) {
    throw new Error(
      `Gitcrawl cursor lock changed during stale reclamation; preserved both lock entries: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function restoreQuarantinedDirectory(
  entryPath: string,
  quarantinePath: string,
  mode: number,
): void {
  fs.mkdirSync(entryPath, { mode: mode & 0o777 });
  restoreDirectoryEntriesNoClobber(quarantinePath, entryPath);
  fs.rmSync(quarantinePath, { recursive: true });
}

function restoreDirectoryEntriesNoClobber(source: string, destination: string): void {
  for (const name of fs.readdirSync(source)) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isDirectory()) {
      fs.mkdirSync(destinationPath, { mode: stat.mode & 0o777 });
      restoreDirectoryEntriesNoClobber(sourcePath, destinationPath);
    } else {
      fs.linkSync(sourcePath, destinationPath);
    }
  }
}

function sameFileIdentity(expected: fs.Stats, actual: fs.Stats): boolean {
  const hasFileIdentity =
    expected.dev !== 0 || expected.ino !== 0 || actual.dev !== 0 || actual.ino !== 0;
  return (
    (!hasFileIdentity || (expected.dev === actual.dev && expected.ino === actual.ino)) &&
    expected.mode === actual.mode &&
    expected.size === actual.size &&
    expected.birthtimeMs === actual.birthtimeMs &&
    expected.mtimeMs === actual.mtimeMs
  );
}

function sameInodeIdentity(expected: fs.Stats, actual: fs.Stats): boolean {
  return (
    expected.dev === actual.dev && expected.ino === actual.ino && expected.mode === actual.mode
  );
}

function pinUnchangedEntry(entryPath: string, expected: fs.Stats): PinnedEntry | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(entryPath, fs.constants.O_RDONLY);
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (!expected.isDirectory()) throw error;
    const actual = fs.lstatSync(entryPath, { throwIfNoEntry: false });
    if (actual === undefined || !sameFileIdentity(expected, actual)) return undefined;
    const children = pinDirectoryChildren(entryPath);
    if (children === undefined) return undefined;
    const pinned = { children, stat: actual };
    const current = fs.lstatSync(entryPath, { throwIfNoEntry: false });
    if (current !== undefined && pinnedEntryMatches(pinned, current, entryPath)) return pinned;
    releasePinnedEntry(pinned);
    return undefined;
  }
  try {
    const actual = fs.fstatSync(descriptor);
    if (!sameFileIdentity(expected, actual)) {
      fs.closeSync(descriptor);
      return undefined;
    }
    if (actual.isDirectory()) {
      const children = pinDirectoryChildren(entryPath);
      if (children === undefined) {
        fs.closeSync(descriptor);
        return undefined;
      }
      const pinned = { children, descriptor, stat: actual };
      const current = fs.lstatSync(entryPath, { throwIfNoEntry: false });
      if (current !== undefined && pinnedEntryMatches(pinned, current, entryPath)) return pinned;
      releasePinnedEntry(pinned);
      return undefined;
    }
    const contents = actual.isFile() ? readPinnedFile(descriptor, actual) : undefined;
    if (actual.isFile() && contents === undefined) {
      fs.closeSync(descriptor);
      return undefined;
    }
    return contents === undefined
      ? { descriptor, stat: actual }
      : { contents, descriptor, stat: actual };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function pinDirectoryChildren(directoryPath: string): Map<string, PinnedEntry> | undefined {
  const children = new Map<string, PinnedEntry>();
  try {
    for (const name of fs.readdirSync(directoryPath).sort(comparePathNames)) {
      const childPath = path.join(directoryPath, name);
      const stat = fs.lstatSync(childPath, { throwIfNoEntry: false });
      if (stat === undefined) {
        releasePinnedChildren(children);
        return undefined;
      }
      const pinned = pinUnchangedEntry(childPath, stat);
      if (pinned === undefined) {
        releasePinnedChildren(children);
        return undefined;
      }
      children.set(name, pinned);
    }
    return children;
  } catch (error) {
    releasePinnedChildren(children);
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function releasePinnedEntry(entry: PinnedEntry): void {
  if (entry.children !== undefined) releasePinnedChildren(entry.children);
  if (entry.descriptor !== undefined) fs.closeSync(entry.descriptor);
}

function releasePinnedChildren(children: Map<string, PinnedEntry>): void {
  for (const child of children.values()) releasePinnedEntry(child);
}

function pinnedEntryMatches(expected: PinnedEntry, actual: fs.Stats, entryPath?: string): boolean {
  const pinned =
    expected.descriptor === undefined ? expected.stat : fs.fstatSync(expected.descriptor);
  if (!sameFileIdentity(pinned, actual)) return false;
  if (
    expected.contents !== undefined &&
    (expected.descriptor === undefined ||
      readPinnedFile(expected.descriptor, pinned)?.equals(expected.contents) !== true)
  ) {
    return false;
  }
  const children = expected.children;
  if (children === undefined) return true;
  if (entryPath === undefined || !actual.isDirectory()) return false;
  let names: string[];
  try {
    names = fs.readdirSync(entryPath).sort(comparePathNames);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (
    names.length !== children.size ||
    names.some((name, index) => name !== [...children.keys()][index])
  ) {
    return false;
  }
  for (const name of names) {
    const child = children.get(name)!;
    const childPath = path.join(entryPath, name);
    const childStat = fs.lstatSync(childPath, { throwIfNoEntry: false });
    if (childStat === undefined || !pinnedEntryMatches(child, childStat, childPath)) return false;
  }
  return true;
}

function comparePathNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readPinnedFile(descriptor: number, expected: fs.Stats): Buffer | undefined {
  if (
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    expected.size > LOCK_ENTRY_MAX_BYTES
  ) {
    return undefined;
  }
  const contents = Buffer.alloc(expected.size);
  let offset = 0;
  while (offset < contents.length) {
    const read = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
    if (read === 0) return undefined;
    offset += read;
  }
  return sameFileIdentity(expected, fs.fstatSync(descriptor)) ? contents : undefined;
}

function pinStaleLegacyLock(lockPath: string, stat: fs.Stats): PinnedEntry | undefined {
  const pinned = pinUnchangedEntry(lockPath, stat);
  if (pinned === undefined) return undefined;
  let keepPinned = false;
  try {
    const owners = pinned.stat.isDirectory() ? [...(pinned.children?.values() ?? [])] : [pinned];
    if (owners.length === 0) {
      const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
      if (
        current !== undefined &&
        cursorLockNow() - pinned.stat.mtimeMs >= LOCK_STALE_MS &&
        pinnedEntryMatches(pinned, current, lockPath)
      ) {
        keepPinned = true;
        return pinned;
      }
      return undefined;
    }
    for (const owner of owners) {
      const ownerStat =
        owner.descriptor === undefined ? owner.stat : fs.fstatSync(owner.descriptor);
      if (cursorLockNow() - ownerStat.mtimeMs < LOCK_STALE_MS) {
        return undefined;
      }
      let pid = 0;
      try {
        const contents = owner.contents?.toString("utf8") ?? "";
        const parsed = JSON.parse(contents) as { pid?: unknown };
        pid = Number(parsed.pid);
      } catch {}
      if (Number.isSafeInteger(pid) && pid > 0 && processExists(pid)) return undefined;
    }
    const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (current === undefined || !pinnedEntryMatches(pinned, current, lockPath)) return undefined;
    keepPinned = true;
    return pinned;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  } finally {
    if (!keepPinned) releasePinnedEntry(pinned);
  }
}

function cursorLockNow(): number {
  return cursorLockTestHooks.now?.() ?? Date.now();
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionDenied(error);
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function isPermissionDenied(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EPERM";
}

function sqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ERR_SQLITE_ERROR" && /\b(?:busy|locked)\b/i.test(String(error));
}
