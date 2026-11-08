/** Default directory names that never belong to an agent task's trash. */
export const DEFAULT_EXCLUDES = Object.freeze([
  '.git',
  'node_modules',
  '.pnpm',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.dsh-lajibuluodi',
  '$RECYCLE.BIN',
  'System Volume Information',
])

/** Resolved defaults used by the host and by unit tests. */
export const DEFAULT_OPTIONS = Object.freeze({
  enabled: true,
  dataDir: '',
  exclude: DEFAULT_EXCLUDES,
  maxFiles: 20_000,
  maxPackageFiles: 5_000,
  maxPackageBytes: 1_500_000_000,
  maxCopyBytes: 64 * 1024 * 1024,
  scanIntervalMs: 5_000,
  beforeToolBudgetMs: 1_500,
  keepSnapshots: false,
  packagePrefix: 'DSH',
  packageNameMaxLength: 120,
})

const POSITIVE_INTS = [
  'maxFiles',
  'maxPackageFiles',
  'maxPackageBytes',
  'maxCopyBytes',
  'scanIntervalMs',
  'beforeToolBudgetMs',
  'packageNameMaxLength',
]

/**
 * Validate and fill a raw plugin config. The Schemastery schema applies the
 * same defaults at load time; this function is the runtime/test boundary.
 * @param {object} [raw]
 * @returns {typeof DEFAULT_OPTIONS}
 */
export function normalizeOptions(raw = {}) {
  const value = { ...DEFAULT_OPTIONS, ...raw }
  for (const key of POSITIVE_INTS) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) {
      throw new TypeError(`dsh-lajibuluodi: option ${key} must be a positive safe integer`)
    }
  }
  if (typeof value.enabled !== 'boolean') throw new TypeError('dsh-lajibuluodi: enabled must be a boolean')
  if (typeof value.dataDir !== 'string') throw new TypeError('dsh-lajibuluodi: dataDir must be a string')
  if (!Array.isArray(value.exclude) || value.exclude.some(item => typeof item !== 'string')) {
    throw new TypeError('dsh-lajibuluodi: exclude must be an array of strings')
  }
  if (typeof value.packagePrefix !== 'string' || value.packagePrefix.trim() === '') {
    throw new TypeError('dsh-lajibuluodi: packagePrefix must be a non-empty string')
  }
  return Object.freeze({
    ...value,
    exclude: Object.freeze([...value.exclude]),
    packagePrefix: value.packagePrefix.trim(),
  })
}
