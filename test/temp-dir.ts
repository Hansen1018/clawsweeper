import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RegisterCleanup = (cleanup: () => void) => unknown;

interface AutoCleanupTempDirTracker {
  readonly dirs: ReadonlySet<string>;
  make(prefix: string, root?: string): string;
}

export function useAutoCleanupTempDirTracker(
  registerCleanup: RegisterCleanup,
): AutoCleanupTempDirTracker {
  const dirs = new Set<string>();
  registerCleanup(() => {
    const tracked = [...dirs];
    dirs.clear();
    for (const dir of tracked) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
  return {
    dirs,
    make(prefix: string, root = os.tmpdir()): string {
      const dir = fs.mkdtempSync(path.join(root, prefix));
      dirs.add(dir);
      return dir;
    },
  };
}
