/**
 * CLI name/version. Kept in one place so `--version`, reports and the
 * `ToolInfo` payload always agree.
 */
export const CLI_NAME = 'apiforge';

/** Replaced at build time by tsup (`define`). */
declare const __APIFORGE_VERSION__: string | undefined;

function readVersionFromPackage(): string {
  // The bundle does not ship package.json, so the version is injected at build
  // time. During development (tsx/vitest) the define is absent; fall back to a
  // development marker rather than lying about a release version.
  try {
    if (typeof __APIFORGE_VERSION__ === 'string' && __APIFORGE_VERSION__.length > 0) {
      return __APIFORGE_VERSION__;
    }
  } catch {
    /* define not present */
  }
  return '0.0.0-dev';
}

export const CLI_VERSION = readVersionFromPackage();
export const TOOL_INFO = { name: CLI_NAME, version: CLI_VERSION };
