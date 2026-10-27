// Watch the manifest's directory (an atomic save replaces the file's inode, so watching the file itself misses it).
// A watcher must never take the host down: creation can throw and the watcher can emit `error` later (EMFILE,
// directory removed). Either way we degrade to "no auto-reload" and say so; the policy in force is unaffected.
import fs from 'node:fs';
import path from 'node:path';

export function watchManifest(file, onChange, { watch = fs.watch, logger = console, delayMs = 150 } = {}) {
  let timer;
  let watcher;
  const stop = () => { clearTimeout(timer); try { watcher?.close(); } catch { /* already closed */ } watcher = undefined; };
  try {
    watcher = watch(path.dirname(file), (_event, changed) => {
      if (changed && changed !== path.basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, delayMs);
    });
    watcher.on('error', (e) => {
      logger.warn?.(`preset-manager: manifest watcher stopped (${e?.code ?? e?.message}); automatic reload is off`);
      stop();
    });
  } catch (e) {
    logger.warn?.(`preset-manager: cannot watch manifest directory (${e?.code ?? e?.message}); automatic reload is off`);
    watcher = undefined;
  }
  return stop;
}
