import { Config } from './config.js'
import { LajibuluodiManager } from './manager.js'
import { normalizeOptions } from './options.js'

export { Config }

/** Stable loader identity. */
export const name = 'lajibuluodi'

/**
 * The tools service supplies the pre/post execution waterfalls; commands is
 * optional so the packager still works in a headless profile without a human
 * command registry.
 */
export const inject = ['tools']

/**
 * Mount the per-turn trash packager.
 * @param {object} ctx - Cordis context.
 * @param {object} config - resolved plugin config.
 */
export function apply(ctx, config) {
  const options = normalizeOptions(config ?? {})
  const manager = new LajibuluodiManager({ ctx, options })

  ctx.effect(() => () => manager.dispose(), 'lajibuluodi lifecycle')

  ctx.on('session/event', (session, event) => {
    manager.onSessionEvent(session, event)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      await manager.beforeStep(payload)
    } catch {
      // never veto a step because snapshotting failed
    }
    return next()
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      await manager.beforeTool(exec)
    } catch {
      // never veto a tool call because snapshotting failed
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      manager.afterTool(exec)
    } catch {
      // observation only
    }
    return next()
  })

  ctx.on('session/disposed', session => {
    void manager.onSessionDisposed(session)
  })

  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(() => commands.register({
      definitionId: 'dsh-lajibuluodi',
      name: 'lajibuluodi',
      description: 'Inspect or restore the per-turn trash packages made by DSH-lajibuluodi',
      input: { hint: '[status|list|restore <id|name>|package]' },
      handler: async invocation => {
        try {
          const text = await manager.runCommand(invocation.rawInput, invocation.agent.session)
          return { kind: 'success', text }
        } catch (error) {
          return { kind: 'error', text: error && error.message ? error.message : String(error) }
        }
      },
    }), 'lajibuluodi command')
  }

  if (typeof ctx.logger?.info === 'function') {
    ctx.logger.info('[lajibuluodi] active; data roots are resolved per workspace volume')
  }
}
