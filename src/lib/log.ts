/**
 * Unified front-end logger.
 *
 * - `debug`/`info` only emit in development. Vite also strips all
 *   `console.*` calls in production builds (see `vite.config.ts`), so the
 *   guard is belt-and-braces.
 * - `warn`/`error` always emit (they can be useful in shipped builds when
 *   the user opens DevTools) but should never contain passwords or other
 *   secrets.
 *
 * Prefer this over raw `console.*` everywhere in `src/`. Use a short
 * uppercase tag for the first argument to make filtering easier:
 *
 *     log.debug('Sidebar', 'Loading schema', connectionId);
 */
const DEV = import.meta.env.DEV;

function emit(level: 'debug' | 'info' | 'warn' | 'error', tag: string, args: unknown[]): void {
  // Avoid `console[level]` for esbuild's drop-console transform to recognise.
  const prefix = `[${tag}]`;
  switch (level) {
    case 'debug':
      if (DEV) console.debug(prefix, ...args);
      break;
    case 'info':
      if (DEV) console.info(prefix, ...args);
      break;
    case 'warn':
      console.warn(prefix, ...args);
      break;
    case 'error':
      console.error(prefix, ...args);
      break;
  }
}

export const log = {
  debug: (tag: string, ...args: unknown[]) => emit('debug', tag, args),
  info: (tag: string, ...args: unknown[]) => emit('info', tag, args),
  warn: (tag: string, ...args: unknown[]) => emit('warn', tag, args),
  error: (tag: string, ...args: unknown[]) => emit('error', tag, args),
  /** Drop-in replacement for console.error in catch blocks. */
  err: (...args: unknown[]) => emit('error', 'App', args),
};

export default log;
