import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createExcludeMatcher } from './excludes.js'

const DEBOUNCE_MS = 500

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function sameFileContent(left, right) {
  const [leftStat, rightStat] = await Promise.all([fsp.stat(left), fsp.stat(right)])
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false
  if (leftStat.size <= 4 * 1024 * 1024) {
    const [leftBytes, rightBytes] = await Promise.all([fsp.readFile(left), fsp.readFile(right)])
    return leftBytes.equals(rightBytes)
  }
  const digest = file => new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    fs.createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
  return (await digest(left)) === (await digest(right))
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/')
}

function relativeSegments(relativePath) {
  return relativePath.split('/').filter(Boolean)
}

/**
 * A per-turn hard-link mirror of the workspace. Files that disappear from the
 * live tree while their mirrored inode still exists are recoverable trash;
 * files whose inode reappears elsewhere are treated as renames.
 */
export class SnapshotCapture {
  /**
   * @param {object} options
   * @param {string} options.workspace
   * @param {string} options.turnDir
   * @param {string} options.sessionId
   * @param {number} options.turn
   * @param {string} [options.sessionTitle]
   * @param {string} [options.prompt]
   * @param {readonly string[]} options.exclude
   * @param {boolean} [options.copyMode]
   * @param {number} options.maxFiles
   * @param {number} options.maxCopyBytes
   * @param {number} options.scanIntervalMs
   * @param {number} options.beforeToolBudgetMs
   * @param {boolean} [options.keepSnapshots]
   * @param {object} [options.logger]
   */
  constructor(options) {
    this.workspace = path.resolve(options.workspace)
    this.turnDir = options.turnDir
    this.snapshotDir = path.join(this.turnDir, 'snapshot')
    this.metaPath = path.join(this.turnDir, 'meta.json')
    this.sessionId = options.sessionId
    this.sessionTitle = options.sessionTitle ?? ''
    this.prompt = options.prompt ?? ''
    this.turn = options.turn
    this.copyMode = Boolean(options.copyMode)
    this.exclude = createExcludeMatcher(options.exclude ?? [])
    this.maxFiles = options.maxFiles
    this.maxCopyBytes = options.maxCopyBytes
    this.scanIntervalMs = options.scanIntervalMs
    this.beforeToolBudgetMs = options.beforeToolBudgetMs
    this.keepSnapshots = Boolean(options.keepSnapshots)
    this.logger = options.logger
    this.seen = new Map()
    this.live = new Map()
    this.truncated = false
    this.status = 'new'
    this.startedAt = Date.now()
    this.updatedAt = this.startedAt
    this.lastScanAt = 0
    this.watcher = null
    this.interval = null
    this.debounceTimer = null
    this.metaTimer = null
    this.scanChain = Promise.resolve()
    this.scanQueued = false
    this.stopped = false
    this.startPromise = null
    this.finalizePromise = null
    this.result = null
  }

  async start() {
    if (this.startPromise === null) this.startPromise = this.startInternal()
    return this.startPromise
  }

  async startInternal() {
    await fsp.mkdir(this.snapshotDir, { recursive: true })
    this.status = 'active'
    await this.scanNow()
    this.startWatcher()
    this.startInterval()
    this.scheduleMeta()
  }

  async ensureReady() {
    if (this.startPromise === null) await this.start()
    else await this.startPromise
  }

  scanNow() {
    this.scanChain = this.scanChain.then(() => this.scanInternal(), () => this.scanInternal())
    return this.scanChain
  }

  async scanInternal() {
    if (this.stopped) return this.live
    const live = new Map()
    let truncated = false
    const stack = [{ abs: this.workspace, rel: '' }]
    while (stack.length > 0) {
      const directory = stack.pop()
      let entries
      try {
        entries = await fsp.readdir(directory.abs, { withFileTypes: true })
      } catch (error) {
        this.warn('cannot list ' + directory.abs + ': ' + error.message)
        continue
      }
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const rel = directory.rel === '' ? entry.name : directory.rel + '/' + entry.name
        if (this.exclude(rel)) continue
        const abs = path.join(directory.abs, entry.name)
        let stat
        try {
          stat = await fsp.lstat(abs)
        } catch {
          continue
        }
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          stack.push({ abs, rel })
          continue
        }
        if (!stat.isFile()) continue
        if (live.size >= this.maxFiles) {
          truncated = true
          continue
        }
        live.set(rel, { ino: stat.ino.toString(), size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs })
        try {
          await this.captureFile(abs, rel, stat)
        } catch (error) {
          this.warn('cannot snapshot ' + rel + ': ' + error.message)
        }
      }
    }
    this.live = live
    this.truncated = this.truncated || truncated
    this.lastScanAt = Date.now()
    this.updatedAt = this.lastScanAt
    if (truncated) this.warn('workspace has more than ' + this.maxFiles + ' files; snapshot is truncated')
    return live
  }

  async capturePath(relativePath) {
    const rel = toPosix(relativePath).replace(/^\/+/, '')
    if (rel === '' || this.exclude(rel)) return
    const abs = path.join(this.workspace, ...relativeSegments(rel))
    let stat
    try {
      stat = await fsp.lstat(abs)
    } catch {
      return
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return
    this.live.set(rel, { ino: stat.ino.toString(), size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs })
    await this.captureFile(abs, rel, stat)
  }

  async captureFile(abs, rel, stat) {
    const prior = this.seen.get(rel)
    const ino = stat.ino.toString()
    if (prior !== undefined && prior.ino === ino) {
      prior.size = stat.size
      prior.mtimeMs = stat.mtimeMs
      if (this.copyMode && (prior.copiedSize !== stat.size || prior.copiedMtimeMs !== stat.mtimeMs)) {
        await this.copyIntoSnapshot(abs, rel, stat)
      }
      return
    }
    const destination = path.join(this.snapshotDir, ...relativeSegments(rel))
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    let existing
    try {
      existing = await fsp.lstat(destination)
    } catch {
      existing = undefined
    }
    if (existing !== undefined) {
      if (existing.ino.toString() === ino) {
        this.seen.set(rel, { ino, size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, copied: false })
        return
      }
      await fsp.rm(destination, { force: true }).catch(() => {})
    }
    if (this.copyMode) {
      await this.copyIntoSnapshot(abs, rel, stat)
      return
    }
    try {
      await fsp.link(abs, destination)
      this.seen.set(rel, { ino, size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, copied: false })
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        try {
          const existingStat = await fsp.lstat(destination)
          if (existingStat.ino.toString() === ino) {
            this.seen.set(rel, { ino, size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, copied: false })
            return
          }
          await fsp.rm(destination, { force: true })
          await fsp.link(abs, destination)
          this.seen.set(rel, { ino, size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, copied: false })
          return
        } catch (retryError) {
          error = retryError
        }
      }
      if (this.isLinkUnsupported(error) && stat.size <= this.maxCopyBytes) {
        await this.copyIntoSnapshot(abs, rel, stat)
        return
      }
      throw error
    }
  }

  async copyIntoSnapshot(abs, rel, stat) {
    if (stat.size > this.maxCopyBytes) {
      this.warn('skipping ' + rel + ': too large to copy (' + stat.size + ' bytes)')
      this.seen.set(rel, { ino: stat.ino.toString(), size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, copied: true, skipped: true })
      return
    }
    const destination = path.join(this.snapshotDir, ...relativeSegments(rel))
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    try {
      await fsp.copyFile(abs, destination)
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        await sleep(30)
        await fsp.copyFile(abs, destination)
      } else {
        throw error
      }
    }
    this.seen.set(rel, {
      ino: stat.ino.toString(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      copied: true,
      copiedSize: stat.size,
      copiedMtimeMs: stat.mtimeMs,
    })
  }

  isLinkUnsupported(error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    return code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EMLINK' || code === 'ENOSYS' || code === 'EBUSY'
  }

  startWatcher() {
    try {
      this.watcher = fs.watch(this.workspace, { recursive: true, persistent: false }, (event, filename) => {
        if (this.stopped) return
        if (filename !== null && filename !== undefined) {
          const rel = toPosix(filename).replace(/^\/+/, '')
          if (rel !== '' && !this.exclude(rel)) {
            void this.capturePath(rel).catch(error => this.warn('watch capture failed: ' + error.message))
          }
        }
        this.scheduleScan()
      })
      this.watcher.on('error', error => {
        this.warn('workspace watcher failed: ' + error.message)
        this.closeWatcher()
      })
    } catch (error) {
      this.warn('workspace watcher unavailable: ' + error.message)
    }
  }

  startInterval() {
    if (this.interval !== null) return
    this.interval = setInterval(() => {
      if (this.stopped) return
      void this.scanNow().catch(error => this.warn('periodic scan failed: ' + error.message))
    }, this.scanIntervalMs)
    this.interval.unref?.()
  }

  scheduleScan() {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      if (this.stopped) return
      if (this.scanQueued) return
      this.scanQueued = true
      void this.scanNow()
        .catch(error => this.warn('debounced scan failed: ' + error.message))
        .finally(() => {
          this.scanQueued = false
        })
    }, DEBOUNCE_MS)
    this.debounceTimer.unref?.()
  }

  async beforeTool() {
    await this.ensureReady()
    const scan = this.scanNow()
    await Promise.race([scan, sleep(this.beforeToolBudgetMs)])
  }

  async finalize() {
    if (this.finalizePromise === null) this.finalizePromise = this.finalizeInternal()
    return this.finalizePromise
  }

  async finalizeInternal() {
    await this.ensureReady()
    this.stopTimers()
    await this.scanNow()
    this.stopped = true
    this.status = 'finalized'
    const liveByIno = new Map()
    for (const [rel, value] of this.live) {
      let candidates = liveByIno.get(value.ino)
      if (candidates === undefined) {
        candidates = []
        liveByIno.set(value.ino, candidates)
      }
      candidates.push({ relative: rel, ...value })
    }
    const deletions = []
    const moved = []
    const files = await this.walkSnapshot()
    const listed = new Set()
    for (const file of files) {
      listed.add(file.relative)
      if (this.live.has(file.relative)) continue
      const info = this.seen.get(file.relative)
      if (info === undefined || info.copied === true) {
        deletions.push(this.deletionOf(file))
        continue
      }
      const candidates = liveByIno.get(info.ino)
      if (candidates !== undefined) {
        const movedCandidate = await this.findMovedCandidate(file, info, candidates)
        if (movedCandidate !== undefined) {
          moved.push(file.relative)
          continue
        }
      }
      deletions.push(this.deletionOf(file))
    }
    for (const [rel, info] of this.seen) {
      if (listed.has(rel) || this.live.has(rel) || info.skipped === true) continue
      const absolute = path.join(this.snapshotDir, ...relativeSegments(rel))
      try {
        const stat = await fsp.stat(absolute)
        if (stat.isFile()) {
          deletions.push(this.deletionOf({ relative: rel, absolute, size: stat.size, mtimeMs: stat.mtimeMs }))
        }
      } catch {
        // the snapshot link is gone; nothing to package
      }
    }
    deletions.sort((left, right) => left.relative.localeCompare(right.relative))
    this.result = {
      deletions,
      moved,
      truncated: this.truncated,
      scanned: this.live.size,
      startedAt: this.startedAt,
      finishedAt: Date.now(),
    }
    this.updatedAt = Date.now()
    await this.saveMeta()
    return this.result
  }

  async findMovedCandidate(file, info, candidates) {
    for (const candidate of candidates) {
      if (String(candidate.birthtimeMs ?? 0) !== String(info.birthtimeMs ?? 0)) continue
      if (candidate.size !== info.size) continue
      const candidatePath = path.join(this.workspace, ...relativeSegments(candidate.relative))
      try {
        if (await sameFileContent(file.absolute, candidatePath)) return candidate
      } catch {
        // an unreadable candidate is not a rename
      }
    }
    return undefined
  }

  deletionOf(file) {
    return {
      relative: file.relative,
      snapshotPath: file.absolute,
      originalPath: path.join(this.workspace, ...relativeSegments(file.relative)),
      size: file.size,
      mtimeMs: file.mtimeMs,
    }
  }

  async walkSnapshot() {
    const files = []
    const stack = [{ abs: this.snapshotDir, rel: '' }]
    while (stack.length > 0) {
      const directory = stack.pop()
      let entries
      try {
        entries = await fsp.readdir(directory.abs, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const rel = directory.rel === '' ? entry.name : directory.rel + '/' + entry.name
        const abs = path.join(directory.abs, entry.name)
        if (entry.isDirectory()) {
          stack.push({ abs, rel })
          continue
        }
        if (!entry.isFile()) continue
        let stat
        try {
          stat = await fsp.lstat(abs)
        } catch {
          continue
        }
        files.push({ relative: toPosix(rel), absolute: abs, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
    return files
  }

  stopTimers() {
    if (this.interval !== null) {
      clearInterval(this.interval)
      this.interval = null
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.metaTimer !== null) {
      clearTimeout(this.metaTimer)
      this.metaTimer = null
    }
    this.closeWatcher()
  }

  closeWatcher() {
    if (this.watcher !== null) {
      try {
        this.watcher.close()
      } catch {
        // already closed
      }
      this.watcher = null
    }
  }

  scheduleMeta() {
    if (this.metaTimer !== null) return
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null
      void this.saveMeta().catch(error => this.warn('meta save failed: ' + error.message))
    }, 300)
    this.metaTimer.unref?.()
  }

  async saveMeta() {
    const seen = {}
    for (const [key, value] of this.seen) seen[key] = value
    const meta = {
      schema: 1,
      workspace: this.workspace,
      sessionId: this.sessionId,
      sessionTitle: this.sessionTitle,
      prompt: this.prompt,
      turn: this.turn,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      status: this.status,
      truncated: this.truncated,
      seen,
    }
    await fsp.mkdir(this.turnDir, { recursive: true })
    const temporary = this.metaPath + '.tmp'
    await fsp.writeFile(temporary, JSON.stringify(meta), 'utf8')
    await fsp.rename(temporary, this.metaPath)
  }

  async dispose(options = {}) {
    this.stopTimers()
    this.stopped = true
    await this.scanChain.catch(() => {})
    this.status = 'disposed'
    if (options.remove !== false && !this.keepSnapshots) {
      await fsp.rm(this.turnDir, { recursive: true, force: true }).catch(() => {})
      await fsp.rmdir(path.dirname(this.turnDir)).catch(() => {})
    }
  }

  warn(message) {
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('[lajibuluodi] ' + message)
  }
}