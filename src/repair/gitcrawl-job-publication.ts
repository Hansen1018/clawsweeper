import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fsyncGitcrawlDirectory } from "./gitcrawl-filesystem.js";

export type GitcrawlJobPublicationTestHooks = {
  beforePublish?: (input: { destination: string; temporary: string }) => void;
  beforeLink?: (input: { destination: string; temporary: string }) => void;
  afterLink?: (input: { destination: string; temporary: string }) => void;
};

let publicationTestHooks: GitcrawlJobPublicationTestHooks = {};

export function __setGitcrawlJobPublicationTestHooks(
  hooks: GitcrawlJobPublicationTestHooks,
): () => void {
  const previous = publicationTestHooks;
  publicationTestHooks = { ...hooks };
  return () => {
    publicationTestHooks = previous;
  };
}

export function publishGitcrawlGeneratedJob(destination: string, contents: string): void {
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.publish-${crypto.randomUUID()}`,
  );
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(temporary, flags, 0o666);
  try {
    const bytes = Buffer.from(contents);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("Gitcrawl generated job write made no progress");
      offset += written;
    }
    fs.fsyncSync(descriptor);
    const temporaryStat = fs.fstatSync(descriptor);
    if (!temporaryStat.isFile() || temporaryStat.size !== bytes.length) {
      throw new Error("Gitcrawl generated job temporary failed identity validation");
    }
    publicationTestHooks.beforePublish?.({ destination, temporary });
    assertTemporaryIdentity(temporary, temporaryStat, bytes.length);
    publicationTestHooks.beforeLink?.({ destination, temporary });
    fs.linkSync(temporary, destination);
    publicationTestHooks.afterLink?.({ destination, temporary });
    const linkedSourceStat = fs.lstatSync(temporary);
    const publishedStat = fs.lstatSync(destination);
    if (
      publishedStat.isSymbolicLink() ||
      !publishedStat.isFile() ||
      !sameFileIdentity(temporaryStat, publishedStat)
    ) {
      if (sameInodeIdentity(linkedSourceStat, publishedStat)) {
        removePublishedPathByIdentity(destination, linkedSourceStat);
      }
      throw new Error("Gitcrawl generated job publication changed identity");
    }
    fsyncGitcrawlDirectory(directory);
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function assertTemporaryIdentity(temporary: string, pinned: fs.Stats, size: number): void {
  const current = fs.lstatSync(temporary, { throwIfNoEntry: false });
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.size !== size ||
    !sameInodeIdentity(pinned, current)
  ) {
    throw new Error("Gitcrawl generated job temporary changed before publication");
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
  throw new Error("Gitcrawl generated job destination changed during failed publication cleanup");
}

function sameInodeIdentity(expected: fs.Stats, actual: fs.Stats): boolean {
  return (
    expected.dev === actual.dev && expected.ino === actual.ino && expected.mode === actual.mode
  );
}

function sameFileIdentity(expected: fs.Stats, actual: fs.Stats): boolean {
  return sameInodeIdentity(expected, actual) && expected.size === actual.size;
}
