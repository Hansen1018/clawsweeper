#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fsyncGitcrawlDirectory } from "./gitcrawl-filesystem.js";

type GitcrawlEvidenceArchiveMode = "archive" | "rollback";

export type GitcrawlEvidenceArchiveTestHooks = {
  beforeSourceAnchorLink?: (input: { source: string; anchor: string }) => void;
  afterSourceAnchor?: (input: { source: string; destination: string; anchor: string }) => void;
  beforeSourceQuarantine?: (input: { source: string; destination: string }) => void;
  forceCrossFilesystem?: boolean;
};

export type GitcrawlEvidenceArchiveOptions = {
  writerExcluded?: boolean;
};

let archiveTestHooks: GitcrawlEvidenceArchiveTestHooks = {};

export function __setGitcrawlEvidenceArchiveTestHooks(
  hooks: GitcrawlEvidenceArchiveTestHooks,
): () => void {
  const previous = archiveTestHooks;
  archiveTestHooks = { ...hooks };
  return () => {
    archiveTestHooks = previous;
  };
}

export function moveGitcrawlEvidenceNoClobber(
  mode: GitcrawlEvidenceArchiveMode,
  source: string,
  destination: string,
  options: GitcrawlEvidenceArchiveOptions = {},
): void {
  const pinnedSource = createPinnedSourceAnchor(mode, source);
  let destinationDescriptor: number | undefined;
  try {
    archiveTestHooks.afterSourceAnchor?.({
      source,
      destination,
      anchor: pinnedSource.path,
    });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const sameFilesystem = publishSameFilesystemLink(
      pinnedSource.path,
      pinnedSource.stat,
      destination,
    );
    let copiedDigest: string | undefined;
    if (!sameFilesystem) {
      if (!options.writerExcluded) {
        throw new Error(
          `Gitcrawl evidence ${mode} crosses filesystems and requires --writer-excluded`,
        );
      }
      copiedDigest = copyPinnedFileNoClobber(
        pinnedSource.descriptor,
        pinnedSource.stat,
        destination,
      );
    }
    destinationDescriptor = openPinnedDestination(
      destination,
      sameFilesystem ? pinnedSource.stat : undefined,
    );
    verifyPublishedDestination({
      sourceDescriptor: pinnedSource.descriptor,
      pinnedSource: pinnedSource.stat,
      destination,
      destinationDescriptor,
      sameFilesystem,
      ...(copiedDigest === undefined ? {} : { copiedDigest }),
    });
    archiveTestHooks.beforeSourceQuarantine?.({ source, destination });
    quarantineAndRemovePinnedSource({
      mode,
      source,
      destination,
      sourceDescriptor: pinnedSource.descriptor,
      pinnedSource: pinnedSource.stat,
      destinationDescriptor,
      sameFilesystem,
      ...(copiedDigest === undefined ? {} : { copiedDigest }),
    });
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    fs.closeSync(pinnedSource.descriptor);
    removePinnedAnchor(pinnedSource.path, pinnedSource.stat);
  }
}

type PinnedSourceAnchor = {
  path: string;
  descriptor: number;
  stat: fs.Stats;
};

function createPinnedSourceAnchor(
  mode: GitcrawlEvidenceArchiveMode,
  source: string,
): PinnedSourceAnchor {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Gitcrawl evidence ${mode} source must be a regular file: ${source}`);
  }
  const anchor = path.join(
    path.dirname(source),
    `.${path.basename(source)}.archive-${crypto.randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const pinned = fs.fstatSync(descriptor);
    if (!pinned.isFile() || !sameFileIdentity(sourceStat, pinned)) {
      throw new Error(`Gitcrawl evidence ${mode} source changed before anchoring: ${source}`);
    }
    archiveTestHooks.beforeSourceAnchorLink?.({ source, anchor });
    fs.linkSync(source, anchor);
    const anchorStat = fs.lstatSync(anchor);
    if (
      !anchorStat.isFile() ||
      anchorStat.isSymbolicLink() ||
      !sameFileIdentity(pinned, anchorStat)
    ) {
      throw new Error(`Gitcrawl evidence ${mode} source changed before anchoring: ${source}`);
    }
    return { path: anchor, descriptor, stat: pinned };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(anchor, { force: true });
    throw error;
  }
}

function publishSameFilesystemLink(
  sourceAnchor: string,
  pinnedSource: fs.Stats,
  destination: string,
): boolean {
  if (archiveTestHooks.forceCrossFilesystem) return false;
  try {
    assertPinnedPath(sourceAnchor, pinnedSource, "source anchor changed before publication");
    fs.linkSync(sourceAnchor, destination);
    const linkedSource = fs.lstatSync(sourceAnchor);
    const published = fs.lstatSync(destination);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      !sameInodeIdentity(pinnedSource, published)
    ) {
      if (sameInodeIdentity(linkedSource, published)) {
        removePublishedPathByIdentity(destination, linkedSource);
      }
      throw new Error("Gitcrawl evidence linked destination does not preserve source identity");
    }
    fsyncGitcrawlDirectory(path.dirname(destination));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") return false;
    throw error;
  }
}

function assertPinnedPath(entryPath: string, pinned: fs.Stats, message: string): void {
  const current = fs.lstatSync(entryPath, { throwIfNoEntry: false });
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameInodeIdentity(pinned, current)
  ) {
    throw new Error(`Gitcrawl evidence ${message}`);
  }
}

function removePinnedAnchor(anchor: string, pinned: fs.Stats): void {
  const current = fs.lstatSync(anchor, { throwIfNoEntry: false });
  if (current === undefined) return;
  if (current.isSymbolicLink() || !current.isFile() || !sameInodeIdentity(pinned, current)) {
    throw new Error(`Gitcrawl evidence source anchor changed before cleanup: ${anchor}`);
  }
  fs.unlinkSync(anchor);
  fsyncGitcrawlDirectory(path.dirname(anchor));
}

function copyPinnedFileNoClobber(
  sourceDescriptor: number,
  sourceStat: fs.Stats,
  destination: string,
): string {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.copy-${crypto.randomUUID()}`,
  );
  const destinationDescriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    sourceStat.mode & 0o777,
  );
  try {
    const copiedDigest = copyDescriptor(sourceDescriptor, destinationDescriptor, sourceStat.size);
    fs.fsyncSync(destinationDescriptor);
    if (
      !sameFileIdentity(sourceStat, fs.fstatSync(sourceDescriptor)) ||
      copiedDigest !== digestDescriptor(sourceDescriptor, sourceStat.size)
    ) {
      throw new Error("Gitcrawl evidence source changed while it was copied");
    }
    const temporaryStat = fs.fstatSync(destinationDescriptor);
    const current = fs.lstatSync(temporary, { throwIfNoEntry: false });
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameInodeIdentity(temporaryStat, current)
    ) {
      throw new Error("Gitcrawl evidence destination temporary changed before publication");
    }
    fs.linkSync(temporary, destination);
    const linkedSource = fs.lstatSync(temporary);
    const published = fs.lstatSync(destination);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      !sameInodeIdentity(temporaryStat, published)
    ) {
      if (sameInodeIdentity(linkedSource, published)) {
        removePublishedPathByIdentity(destination, linkedSource);
      }
      throw new Error("Gitcrawl evidence destination changed during publication");
    }
    fsyncGitcrawlDirectory(path.dirname(destination));
    return copiedDigest;
  } finally {
    fs.closeSync(destinationDescriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function removePublishedPathByIdentity(destination: string, expected: fs.Stats): void {
  const quarantine = `${destination}.cleanup-${crypto.randomUUID()}`;
  fs.renameSync(destination, quarantine);
  const moved = fs.lstatSync(quarantine, { throwIfNoEntry: false });
  if (moved !== undefined && sameInodeIdentity(expected, moved)) {
    fs.unlinkSync(quarantine);
    fsyncGitcrawlDirectory(path.dirname(destination));
    return;
  }
  if (moved !== undefined) {
    fs.linkSync(quarantine, destination);
    fs.unlinkSync(quarantine);
  }
  throw new Error("Gitcrawl evidence destination changed during failed publication cleanup");
}

function openPinnedDestination(destination: string, sourceStat?: fs.Stats): number {
  const stat = fs.lstatSync(destination);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Gitcrawl evidence destination must be a regular file: ${destination}`);
  }
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const pinned = fs.fstatSync(descriptor);
  if (
    !sameInodeIdentity(stat, pinned) ||
    (sourceStat !== undefined && !sameInodeIdentity(sourceStat, pinned))
  ) {
    fs.closeSync(descriptor);
    throw new Error(`Gitcrawl evidence destination changed before verification: ${destination}`);
  }
  return descriptor;
}

function verifyPublishedDestination(input: {
  sourceDescriptor: number;
  pinnedSource: fs.Stats;
  destination: string;
  destinationDescriptor: number;
  sameFilesystem: boolean;
  copiedDigest?: string;
}): void {
  const sourceCurrent = fs.fstatSync(input.sourceDescriptor);
  const destinationPinned = fs.fstatSync(input.destinationDescriptor);
  const destinationCurrent = fs.lstatSync(input.destination, { throwIfNoEntry: false });
  if (
    destinationCurrent === undefined ||
    destinationCurrent.isSymbolicLink() ||
    !destinationCurrent.isFile() ||
    !sameInodeIdentity(destinationPinned, destinationCurrent)
  ) {
    throw new Error("Gitcrawl evidence destination ownership changed during transfer");
  }
  if (input.sameFilesystem) {
    if (
      !sameInodeIdentity(input.pinnedSource, sourceCurrent) ||
      !sameInodeIdentity(sourceCurrent, destinationPinned)
    ) {
      throw new Error("Gitcrawl evidence linked destination does not preserve source identity");
    }
    return;
  }
  if (
    input.copiedDigest === undefined ||
    !sameFileIdentity(input.pinnedSource, sourceCurrent) ||
    digestDescriptor(input.sourceDescriptor, input.pinnedSource.size) !== input.copiedDigest ||
    digestDescriptor(input.destinationDescriptor, destinationPinned.size) !== input.copiedDigest
  ) {
    throw new Error("Gitcrawl evidence copied destination failed verification");
  }
}

function quarantineAndRemovePinnedSource(input: {
  mode: GitcrawlEvidenceArchiveMode;
  source: string;
  destination: string;
  sourceDescriptor: number;
  pinnedSource: fs.Stats;
  destinationDescriptor: number;
  sameFilesystem: boolean;
  copiedDigest?: string;
}): void {
  const quarantine = `${input.source}.moving-${crypto.randomUUID()}`;
  try {
    fs.renameSync(input.source, quarantine);
  } catch (error) {
    throw new Error(
      `Gitcrawl evidence ${input.mode} published the destination but could not quarantine its source; destination was preserved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const quarantined = fs.lstatSync(quarantine, { throwIfNoEntry: false });
  try {
    if (
      quarantined === undefined ||
      quarantined.isSymbolicLink() ||
      !quarantined.isFile() ||
      !sameInodeIdentity(input.pinnedSource, quarantined) ||
      !sameInodeIdentity(input.pinnedSource, fs.fstatSync(input.sourceDescriptor))
    ) {
      throw new Error("source ownership changed during transfer");
    }
    verifyPublishedDestination(input);
  } catch (error) {
    restoreMovedSourceNoClobber(input.source, quarantine);
    throw new Error(
      `Gitcrawl evidence ${input.mode} source ownership changed during transfer; source and destination were preserved: ${input.source} -> ${input.destination}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.unlinkSync(quarantine);
    fsyncGitcrawlDirectory(path.dirname(input.source));
  } catch (error) {
    throw new Error(
      `Gitcrawl evidence ${input.mode} published the destination but could not remove its pinned quarantine; both files were preserved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function restoreMovedSourceNoClobber(source: string, quarantine: string): void {
  try {
    fs.linkSync(quarantine, source);
    fs.unlinkSync(quarantine);
  } catch (error) {
    throw new Error(
      `Gitcrawl evidence source changed during transfer; preserved the destination and both source entries: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function copyDescriptor(source: number, destination: number, size: number): string {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    const read = fs.readSync(source, buffer, 0, length, offset);
    if (read === 0) throw new Error("Gitcrawl evidence source ended during transfer");
    digest.update(buffer.subarray(0, read));
    let written = 0;
    while (written < read) {
      const count = fs.writeSync(destination, buffer, written, read - written);
      if (count === 0) throw new Error("Gitcrawl evidence destination stopped during transfer");
      written += count;
    }
    offset += read;
  }
  return digest.digest("hex");
}

function digestDescriptor(descriptor: number, size: number): string {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    const read = fs.readSync(descriptor, buffer, 0, length, offset);
    if (read === 0) return "";
    digest.update(buffer.subarray(0, read));
    offset += read;
  }
  return digest.digest("hex");
}

function sameFileIdentity(expected: fs.Stats, actual: fs.Stats): boolean {
  return (
    sameInodeIdentity(expected, actual) &&
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

function runCli(): void {
  const [mode, sourceArg, destinationArg, ...flags] = process.argv.slice(2);
  if (
    (mode !== "archive" && mode !== "rollback") ||
    !sourceArg ||
    !destinationArg ||
    flags.some((flag) => flag !== "--writer-excluded")
  ) {
    console.error(
      "usage: node dist/repair/gitcrawl-evidence-archive.js archive|rollback <source> <destination> [--writer-excluded]",
    );
    process.exitCode = 2;
    return;
  }
  try {
    moveGitcrawlEvidenceNoClobber(mode, path.resolve(sourceArg), path.resolve(destinationArg), {
      writerExcluded: flags.includes("--writer-excluded"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runCli();
}
