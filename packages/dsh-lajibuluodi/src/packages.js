import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Persistent outbox and JSONL record of packages sent (or kept) by the plugin.
 */
export class PackageStore {
  /**
   * @param {{dataRoot: string, workspaceHash: string, logger?: object}} options
   */
  constructor(options) {
    this.dataRoot = options.dataRoot
    this.workspaceHash = options.workspaceHash
    this.root = path.join(this.dataRoot, this.workspaceHash)
    this.outbox = path.join(this.root, 'outbox')
    this.logPath = path.join(this.root, 'packages.jsonl')
    this.restoreCache = path.join(this.root, 'restore-cache')
    this.logger = options.logger
  }

  async init() {
    await fsp.mkdir(this.outbox, { recursive: true })
    await fsp.mkdir(this.restoreCache, { recursive: true })
  }

  /**
   * Allocate a non-colliding ZIP path in the outbox.
   * @param {string} fileName
   * @returns {Promise<string>}
   */
  async allocatePath(fileName) {
    const safe = fileName.toLowerCase().endsWith('.zip') ? fileName : fileName + '.zip'
    let candidate = path.join(this.outbox, safe)
    let counter = 2
    while (true) {
      try {
        await fsp.access(candidate)
      } catch {
        return candidate
      }
      const stem = safe.slice(0, -4)
      candidate = path.join(this.outbox, stem + '-' + counter + '.zip')
      counter += 1
    }
  }

  /**
   * @param {object} record
   * @returns {Promise<object>}
   */
  async add(record) {
    const complete = {
      id: record.id ?? randomUUID().slice(0, 12),
      createdAt: record.createdAt ?? new Date().toISOString(),
      ...record,
    }
    await fsp.mkdir(this.root, { recursive: true })
    await fsp.appendFile(this.logPath, JSON.stringify(complete) + '\n', 'utf8')
    return complete
  }

  /**
   * Read the newest records first.
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async list(limit = 20) {
    let text
    try {
      text = await fsp.readFile(this.logPath, 'utf8')
    } catch {
      return []
    }
    const lines = text.split(/\r?\n/).filter(Boolean)
    const records = []
    for (let index = lines.length - 1; index >= 0 && records.length < limit; index -= 1) {
      try {
        records.push(JSON.parse(lines[index]))
      } catch {
        // ignore a torn trailing line
      }
    }
    return records
  }

  /**
   * Find by package id, display name, or zip file name.
   * @param {string} query
   * @returns {Promise<object | undefined>}
   */
  async find(query) {
    const needle = String(query ?? '').trim().toLowerCase()
    if (needle === '') return undefined
    const records = await this.list(500)
    return records.find(record =>
      String(record.id ?? '').toLowerCase() === needle
      || String(record.name ?? '').toLowerCase() === needle
      || path.basename(String(record.zipPath ?? '')).toLowerCase() === needle,
    )
  }

  warn(message) {
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('[lajibuluodi] ' + message)
  }
}
