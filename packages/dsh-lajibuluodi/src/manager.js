import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { SnapshotCapture } from './snapshot.js'
import { PackageStore } from './packages.js'
import { buildPackage, removeStaging, extractZip } from './archive.js'
import { sendToRecycleBin, restoreZipFromRecycle } from './recycle.js'
import { buildPackageName, sanitizeComponent, shortHash } from './naming.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function keyOf(session, turn) {
  return String(session.id) + ':' + turn
}

function formatBytes(value) {
  const number = Number(value) || 0
  if (number < 1024) return number + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = number / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[index]
}

function extractPrompt(data) {
  if (data === null || typeof data !== 'object') return ''
  const sourceKind = data.source !== null && typeof data.source === 'object' ? data.source.kind : undefined
  if (sourceKind !== undefined && sourceKind !== 'user') return ''
  if (!Array.isArray(data.content)) return ''
  const text = data.content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 200)
}

/**
 * Owns turn capture, per-turn packaging, the outbox log, and the human command.
 */
export class LajibuluodiManager {
  /**
   * @param {{ctx: object, options: object, logger?: object}} input
   */
  constructor(input) {
    this.ctx = input.ctx
    this.options = input.options
    this.logger = input.logger ?? input.ctx?.logger
    this.captures = new Map()
    this.activeBySession = new Map()
    this.finishChains = new Map()
    this.sessionMeta = new Map()
    this.dataRoots = new Map()
    this.stores = new Map()
    this.disposed = false
  }

  isEligible(session) {
    if (session === null || typeof session !== 'object') return false
    const header = session.header
    if (header === null || typeof header !== 'object') return false
    if (typeof header.cwd !== 'string' || header.cwd.trim() === '') return false
    if (header.origin === 'subagent') return false
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
    return true
  }

  metaFor(session) {
    let meta = this.sessionMeta.get(session.id)
    if (meta === undefined) {
      meta = { title: '', prompt: '' }
      this.sessionMeta.set(session.id, meta)
    }
    return meta
  }

  /**
   * @param {object} session
   * @param {{type: string, data: object}} event
   */
  onSessionEvent(session, event) {
    if (this.disposed || session === null || event === null) return
    const meta = this.metaFor(session)
    if (event.type === 'session/title') {
      const title = event.data !== null && typeof event.data === 'object' ? event.data.title : undefined
      if (typeof title === 'string' && title.trim() !== '') meta.title = title.trim()
      return
    }
    if (event.type === 'user/message') {
      if (meta.prompt === '') {
        const prompt = extractPrompt(event.data)
        if (prompt !== '') meta.prompt = prompt
      }
      return
    }
    if (event.type === 'turn/start') {
      const turn = event.data !== null && typeof event.data === 'object' ? event.data.turn : undefined
      if (Number.isSafeInteger(turn)) void this.startCapture(session, turn).catch(error => this.warn('cannot start turn capture: ' + error.message))
      return
    }
    if (event.type === 'turn/end') {
      const turn = event.data !== null && typeof event.data === 'object' ? event.data.turn : undefined
      if (Number.isSafeInteger(turn)) {
        void this.finishTurn(session, turn).catch(error => this.warn('turn packaging failed: ' + (error && error.message ? error.message : String(error))))
      }
      return
    }
    if (event.type === 'session/disposed') {
      void this.onSessionDisposed(session)
    }
  }

  async startCapture(session, turn) {
    if (this.disposed || !this.options.enabled || !this.isEligible(session)) return
    const key = keyOf(session, turn)
    if (this.captures.has(key)) return
    const cwd = path.resolve(session.header.cwd)
    let stat
    try {
      stat = await fsp.stat(cwd)
    } catch {
      this.warn('workspace is not accessible: ' + cwd)
      return
    }
    if (!stat.isDirectory()) return
    const location = await this.resolveDataRoot(cwd)
    const store = await this.storeFor(location, cwd)
    const meta = this.metaFor(session)
    const workspaceHash = shortHash(cwd.toLowerCase())
    const turnDir = path.join(
      location.root,
      workspaceHash,
      sanitizeComponent(String(session.id), 48),
      'turn-' + turn + '-' + Date.now(),
    )
    const excludes = [...this.options.exclude]
    const relativeDataRoot = path.relative(cwd, location.root)
    if (relativeDataRoot !== '' && !relativeDataRoot.startsWith('..') && !path.isAbsolute(relativeDataRoot)) {
      excludes.push(relativeDataRoot.replace(/\\/g, '/'))
    }
    const capture = new SnapshotCapture({
      workspace: cwd,
      turnDir,
      sessionId: String(session.id),
      sessionTitle: meta.title,
      prompt: meta.prompt,
      turn,
      exclude: excludes,
      copyMode: location.copyMode,
      maxFiles: this.options.maxFiles,
      maxCopyBytes: this.options.maxCopyBytes,
      scanIntervalMs: this.options.scanIntervalMs,
      beforeToolBudgetMs: this.options.beforeToolBudgetMs,
      keepSnapshots: this.options.keepSnapshots,
      logger: this.logger,
    })
    this.captures.set(key, capture)
    this.activeBySession.set(session.id, capture)
    this.info('capture started for ' + session.id + ' turn ' + turn + ' at ' + cwd)
    await capture.start()
  }

  /**
   * @param {string} cwd
   * @returns {Promise<{root: string, copyMode: boolean}>}
   */
  async resolveDataRoot(cwd) {
    const resolved = path.resolve(cwd)
    const cached = this.dataRoots.get(resolved)
    if (cached !== undefined) return cached
    const volumeRoot = path.parse(resolved).root
    let root = this.options.dataDir.trim() === ''
      ? path.join(volumeRoot, '.dsh-lajibuluodi')
      : path.resolve(path.isAbsolute(this.options.dataDir) ? this.options.dataDir : path.join(resolved, this.options.dataDir))
    let copyMode = path.parse(root).root.toLowerCase() !== volumeRoot.toLowerCase()
    try {
      await fsp.mkdir(root, { recursive: true })
    } catch (error) {
      this.warn('cannot use data directory ' + root + ': ' + error.message + '; falling back to the home directory')
      root = path.join(os.homedir(), '.dsh-lajibuluodi')
      copyMode = true
      await fsp.mkdir(root, { recursive: true })
    }
    const result = { root, copyMode }
    this.dataRoots.set(resolved, result)
    return result
  }

  async storeFor(location, cwd) {
    const resolved = path.resolve(cwd)
    const workspaceHash = shortHash(resolved.toLowerCase())
    const cacheKey = location.root + '|' + workspaceHash
    const cached = this.stores.get(cacheKey)
    if (cached !== undefined) return cached
    const store = new PackageStore({ dataRoot: location.root, workspaceHash, logger: this.logger })
    await store.init()
    this.stores.set(cacheKey, store)
    return store
  }

  captureFor(session, turn) {
    return this.captures.get(keyOf(session, turn))
  }

  async beforeStep(payload) {
    if (this.disposed || payload === null || typeof payload !== 'object') return
    const session = payload.agent?.session
    if (session === undefined) return
    const capture = this.captureFor(session, payload.turn)
    if (capture === undefined) return
    try {
      await Promise.race([capture.ensureReady(), sleep(5_000)])
    } catch (error) {
      this.warn('snapshot readiness failed: ' + error.message)
    }
  }

  async beforeTool(exec) {
    if (this.disposed || exec === null || typeof exec !== 'object') return
    const session = exec.agent?.session
    if (session === undefined) return
    const capture = this.activeBySession.get(session.id)
    if (capture === undefined) return
    try {
      await Promise.race([capture.beforeTool(), sleep(this.options.beforeToolBudgetMs + 500)])
    } catch (error) {
      this.warn('pre-tool snapshot failed: ' + error.message)
    }
  }

  afterTool(exec) {
    if (this.disposed || exec === null || typeof exec !== 'object') return
    const session = exec.agent?.session
    if (session === undefined) return
    const capture = this.activeBySession.get(session.id)
    if (capture !== undefined) capture.scheduleScan()
  }

  async finishTurn(session, turn) {
    const key = keyOf(session, turn)
    const capture = this.captures.get(key)
    if (capture === undefined) return
    this.captures.delete(key)
    if (this.activeBySession.get(session.id) === capture) this.activeBySession.delete(session.id)
    const previous = this.finishChains.get(session.id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => this.finalizeCapture(capture, session, turn))
    this.finishChains.set(session.id, current)
    try {
      await current
    } finally {
      if (this.finishChains.get(session.id) === current) this.finishChains.delete(session.id)
    }
  }

  async finalizeCapture(capture, session, turn) {
    try {
      const result = await capture.finalize()
      if (result.deletions.length === 0) {
        this.info('turn ' + turn + ' deleted nothing; drop capture')
        await capture.dispose()
        return
      }
      const cwd = path.resolve(session.header.cwd)
      const location = await this.resolveDataRoot(cwd)
      const store = await this.storeFor(location, cwd)
      const meta = this.metaFor(session)
      const title = meta.title !== '' ? meta.title : meta.prompt
      const name = buildPackageName({
        prefix: this.options.packagePrefix,
        title,
        turn,
        sessionId: String(session.id),
        maxLength: this.options.packageNameMaxLength,
      })
      const zipPath = await store.allocatePath(name)
      const packageId = randomUUID().slice(0, 12)
      const createdAt = new Date().toISOString()
      const manifest = {
        schema: 1,
        plugin: 'dsh-lajibuluodi',
        packageId,
        createdAt,
        workspace: cwd,
        sessionId: String(session.id),
        sessionTitle: meta.title,
        prompt: meta.prompt,
        turn,
        deletedCount: result.deletions.length,
        movedCount: result.moved.length,
        truncated: result.truncated,
      }
      const built = await buildPackage({
        turnDir: capture.turnDir,
        zipPath,
        deletions: result.deletions,
        manifest,
        maxFiles: this.options.maxPackageFiles,
        maxBytes: this.options.maxPackageBytes,
        logger: this.logger,
      })
      if (built.included.length === 0) {
        this.warn('turn ' + turn + ' has only oversized or unreadable deletions; keeping the snapshot')
        await store.add({
          id: packageId,
          name: path.basename(zipPath),
          zipPath,
          workspace: cwd,
          sessionId: String(session.id),
          sessionTitle: meta.title,
          prompt: meta.prompt,
          turn,
          createdAt,
          fileCount: 0,
          totalBytes: 0,
          skipped: built.skipped.length,
          recycle: 'skipped',
          error: 'no packageable files',
        })
        await removeStaging(built.packageDir)
        await capture.dispose({ remove: false })
        return
      }
      let recycle = this.options.recycle ? 'failed' : 'kept'
      let recycleError
      if (this.options.recycle) {
        try {
          await sendToRecycleBin(zipPath, 60_000)
          recycle = 'sent'
        } catch (error) {
          recycle = 'failed'
          recycleError = error.message
          this.warn('cannot send package to Recycle Bin: ' + error.message)
        }
      }
      await store.add({
        id: packageId,
        name: path.basename(zipPath),
        zipPath,
        workspace: cwd,
        sessionId: String(session.id),
        sessionTitle: meta.title,
        prompt: meta.prompt,
        turn,
        createdAt,
        fileCount: built.included.length,
        totalBytes: built.bytes,
        skipped: built.skipped.length,
        truncated: result.truncated,
        recycle,
        ...recycleError === undefined ? {} : { error: recycleError },
      })
      await removeStaging(built.packageDir)
      if (recycle === 'sent') {
        this.info('packaged turn ' + turn + ' into ' + path.basename(zipPath) + ' (' + built.included.length + ' files, ' + formatBytes(built.bytes) + ')')
        await capture.dispose()
      } else if (recycle === 'kept') {
        this.info('package kept in outbox for review: ' + zipPath)
        await capture.dispose()
      } else {
        this.warn('package kept in outbox: ' + zipPath)
        await capture.dispose({ remove: false })
      }
    } catch (error) {
      this.warn('packaging turn ' + turn + ' failed: ' + (error && error.message ? error.message : String(error)))
      try {
        await capture.dispose({ remove: false })
      } catch {
        // ignore
      }
    }
  }

  async onSessionDisposed(session) {
    for (const [key, capture] of [...this.captures]) {
      if (key.startsWith(String(session.id) + ':')) {
        this.captures.delete(key)
        try {
          await this.finalizeCapture(capture, session, capture.turn)
        } catch (error) {
          this.warn('session disposal packaging failed: ' + error.message)
        }
      }
    }
    if (this.activeBySession.get(session.id) !== undefined) this.activeBySession.delete(session.id)
    this.sessionMeta.delete(session.id)
  }

  async runCommand(rawInput, session) {
    const input = String(rawInput ?? '').trim()
    if (input === '' || input === 'help') return this.helpText()
    const parts = input.split(/\s+/)
    const action = parts[0].toLowerCase()
    if (action === 'status') return this.statusText(session)
    if (action === 'list') return this.listText(session, Number(parts[1]) || 10)
    if (action === 'restore') return this.restoreText(session, parts[1], parts.includes('--overwrite'))
    if (action === 'package') return this.packageNow(session)
    return this.helpText()
  }

  helpText() {
    return [
      'DSH-lajibuluodi - 每轮任务丢弃的文件打包成一条回收站记录',
      '',
      '/lajibuluodi status           当前轮捕获状态',
      '/lajibuluodi list [n]         最近 n 个任务包',
      '/lajibuluodi restore <id|名>  从回收站恢复任务包（默认不覆盖）',
      '/lajibuluodi restore <id|名> --overwrite  覆盖现有文件',
      '/lajibuluodi package          立即结束当前轮并打包',
    ].join('\n')
  }

  async statusText(session) {
    const capture = this.activeBySession.get(session.id)
    const cwd = session?.header?.cwd
    const lines = ['DSH-lajibuluodi', 'enabled: ' + (this.options.enabled ? 'yes' : 'no')]
    if (typeof cwd === 'string' && cwd !== '') {
      try {
        const location = await this.resolveDataRoot(path.resolve(cwd))
        const store = await this.storeFor(location, path.resolve(cwd))
        lines.push('data: ' + store.root)
        lines.push('outbox: ' + store.outbox)
      } catch (error) {
        lines.push('data: unavailable (' + error.message + ')')
      }
    }
    if (capture === undefined) {
      lines.push('active: none')
    } else {
      lines.push('active: turn ' + capture.turn + ' (' + capture.status + ')')
      lines.push('  files watched: ' + capture.seen.size + ' / live ' + capture.live.size)
      lines.push('  truncated: ' + (capture.truncated ? 'yes' : 'no'))
      lines.push('  snapshot: ' + capture.snapshotDir)
    }
    if (typeof cwd === 'string' && cwd !== '') {
      try {
        const location = await this.resolveDataRoot(path.resolve(cwd))
        const store = await this.storeFor(location, path.resolve(cwd))
        const records = await store.list(1)
        lines.push('last package: ' + (records[0] ? records[0].name + ' (' + records[0].recycle + ')' : 'none'))
      } catch {
        // ignore
      }
    }
    return lines.join('\n')
  }

  async listText(session, limit) {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string') return 'no workspace'
    const location = await this.resolveDataRoot(path.resolve(cwd))
    const store = await this.storeFor(location, path.resolve(cwd))
    const records = await store.list(limit)
    if (records.length === 0) return '还没有任务包。'
    const lines = ['最近 ' + records.length + ' 个任务包：']
    for (const record of records) {
      lines.push(
        '- ' + record.name
        + ' | ' + (record.fileCount ?? 0) + ' files '
        + formatBytes(record.totalBytes)
        + ' | ' + (record.recycle ?? 'unknown')
        + ' | ' + (record.createdAt ?? ''),
      )
      lines.push('  id: ' + record.id)
    }
    return lines.join('\n')
  }

  async restoreText(session, query, overwrite) {
    if (!query) return '用法: /lajibuluodi restore <id 或包名> [--overwrite]'
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string') return 'no workspace'
    const location = await this.resolveDataRoot(path.resolve(cwd))
    const store = await this.storeFor(location, path.resolve(cwd))
    const record = await store.find(query)
    if (record === undefined) return '找不到任务包: ' + query
    return this.restorePackage(record, store, overwrite)
  }

  async restorePackage(record, store, overwrite) {
    let zipPath = record.zipPath
    let exists = false
    try {
      await fsp.access(zipPath)
      exists = true
    } catch {
      exists = false
    }
    if (!exists) {
      const cacheZip = path.join(store.restoreCache, record.id + '.zip')
      const found = await restoreZipFromRecycle(record.zipPath, cacheZip)
      if (!found) return '任务包已不在回收站，且 outbox 中也没有: ' + record.name
      zipPath = cacheZip
    }
    const extractDir = path.join(store.restoreCache, record.id + '-extract')
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {})
    await extractZip(zipPath, extractDir)
    let manifest
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(extractDir, 'manifest.json'), 'utf8'))
    } catch (error) {
      return '任务包清单损坏: ' + error.message
    }
    const workspace = typeof manifest.workspace === 'string' ? manifest.workspace : record.workspace
    if (typeof workspace !== 'string' || workspace === '') return '任务包没有记录原始工作目录'
    let restored = 0
    let skipped = 0
    const files = Array.isArray(manifest.files) ? manifest.files : []
    for (const file of files) {
      if (file === null || typeof file !== 'object') {
        skipped += 1
        continue
      }
      const relative = String(file.path ?? '').replace(/\\/g, '/')
      if (relative === '' || relative.startsWith('/') || relative.split('/').includes('..')) {
        skipped += 1
        continue
      }
      const source = path.join(extractDir, 'files', ...relative.split('/'))
      const target = path.join(workspace, ...relative.split('/'))
      const relativeTarget = path.relative(workspace, target)
      if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
        skipped += 1
        continue
      }
      try {
        await fsp.access(target)
        if (!overwrite) {
          skipped += 1
          continue
        }
      } catch {
        // target does not exist
      }
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.copyFile(source, target)
        if (Number.isFinite(file.mtimeMs)) {
          const stamp = new Date(file.mtimeMs)
          await fsp.utimes(target, stamp, stamp).catch(() => {})
        }
        restored += 1
      } catch {
        skipped += 1
      }
    }
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {})
    return '恢复完成: ' + restored + ' 个文件，跳过 ' + skipped + ' 个。\n包: ' + record.name
  }

  async packageNow(session) {
    const capture = this.activeBySession.get(session.id)
    if (capture === undefined) return '当前没有进行中的任务轮次。'
    const turn = capture.turn
    await this.finishTurn(session, turn)
    return '已结束第 ' + turn + ' 轮并完成打包；用 /lajibuluodi list 查看。'
  }

  async dispose() {
    this.disposed = true
    const captures = [...this.captures.values()]
    this.captures.clear()
    this.activeBySession.clear()
    await Promise.allSettled(captures.map(capture => capture.dispose({ remove: false })))
  }

  info(message) {
    if (this.logger && typeof this.logger.info === 'function') this.logger.info('[lajibuluodi] ' + message)
  }

  warn(message) {
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('[lajibuluodi] ' + message)
  }
}
