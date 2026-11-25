// True when the module is the script node was started with. Compares real paths, so starting a script through a
// symlinked folder (macOS /tmp -> /private/tmp, a linked skill folder) still runs it instead of exiting 0 silently.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1)); } catch { return false; }
}
