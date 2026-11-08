/** Characters Windows rejects in a file name, plus control characters. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/**
 * Make one path component safe on Windows without destroying readable text.
 * @param {unknown} input
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeComponent(input, maxLength = 80) {
  let value = String(input ?? '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/u, '')
  if (value === '') value = 'task'
  if (RESERVED.has(value.toUpperCase())) value = `_${value}`
  if (value.length > maxLength) {
    value = value.slice(0, maxLength).trim().replace(/[. ]+$/u, '')
  }
  return value || 'task'
}

/**
 * Keep a .zip suffix while truncating the stem.
 * @param {string} name
 * @param {number} maxLength
 * @returns {string}
 */
export function truncateFileName(name, maxLength) {
  if (name.length <= maxLength) return name
  const suffix = '.zip'
  const stem = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name
  return stem.slice(0, Math.max(1, maxLength - suffix.length)).trim().replace(/[. ]+$/u, '') + suffix
}

/**
 * Local-time component like 20261109-001234.
 * @param {Date} date
 * @returns {string}
 */
export function formatTimestamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

/**
 * Human-readable, per-turn Recycle Bin name.
 * @param {{prefix?: string, date?: Date, title?: string, turn: number, sessionId?: string, maxLength?: number}} input
 * @returns {string}
 */
export function buildPackageName(input) {
  const prefix = sanitizeComponent(input.prefix ?? 'DSH', 24)
  const timestamp = formatTimestamp(input.date ?? new Date())
  const title = sanitizeComponent(input.title ?? '', 56)
  const turn = Number.isSafeInteger(input.turn) ? input.turn : 1
  const session = input.sessionId ? `-${sanitizeComponent(String(input.sessionId).slice(-6), 6)}` : ''
  const raw = `${prefix}-${timestamp}-${title}${session}-T${turn}.zip`
  return truncateFileName(raw, input.maxLength ?? 120)
}

/**
 * Stable short hash for a path, used as a data-directory key.
 * @param {string} value
 * @returns {string}
 */
export function shortHash(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
