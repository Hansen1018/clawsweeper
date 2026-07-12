import fs from "node:fs";

export type GitcrawlDirectorySyncOptions = {
  platform?: NodeJS.Platform;
  openDirectory?: (directory: string) => number;
  fsync?: (descriptor: number) => void;
  close?: (descriptor: number) => void;
};

export function fsyncGitcrawlDirectory(
  directory: string,
  options: GitcrawlDirectorySyncOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const openDirectory =
    options.openDirectory ?? ((candidate: string) => fs.openSync(candidate, fs.constants.O_RDONLY));
  const fsync = options.fsync ?? fs.fsyncSync;
  const close = options.close ?? fs.closeSync;
  let descriptor: number;
  try {
    descriptor = openDirectory(directory);
  } catch (error) {
    if (directorySyncUnsupported(error, platform, true)) return;
    throw error;
  }
  try {
    fsync(descriptor);
  } catch (error) {
    if (!directorySyncUnsupported(error, platform, false)) throw error;
  } finally {
    close(descriptor);
  }
}

function directorySyncUnsupported(
  error: unknown,
  platform: NodeJS.Platform,
  opening: boolean,
): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS") return true;
  return (
    opening && platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES")
  );
}
