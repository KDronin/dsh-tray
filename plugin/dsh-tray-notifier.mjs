// DeepSeek Harness → DSHTray notification/power bridge (v2).
// Persistently installed through $DSH_HOME/cordis.patch.yml (host plane).
// - task-start  : a root agent started working → tray keeps the PC awake
// - task-complete: a root agent finished (running→idle) → tray notifies and
//                  may auto-sleep when the user is away
import { request } from 'node:http'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NOTIFY_PORT = 3489
const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG = join(__dirname, 'dsh-tray-notifier.log')

function log(...a) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`)
  } catch { /* ignore */ }
}

function postNotify(payload) {
  const body = JSON.stringify(payload)
  const req = request(
    {
      host: '127.0.0.1',
      port: NOTIFY_PORT,
      path: '/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 2000,
    },
    (res) => { res.resume() },
  )
  req.on('error', () => {})
  req.on('timeout', () => req.destroy())
  req.end(body)
}

function rootSessionIds(ctx) {
  try {
    return new Set(ctx.agents.roots().map((r) => r.id || r.sessionId || (r.session && r.session.id)).filter(Boolean))
  } catch {
    return new Set()
  }
}

export default {
  name: 'dsh-tray-notifier',
  inject: ['agents', 'sessions', 'sessionTitle', 'timer'],
  apply(ctx) {
    log('dsh-tray-notifier v3 applied')
    const last = new Map()

    const announceRunning = () => {
      try {
        const roots = new Set(rootSessionIds(ctx))
        for (const r of ctx.agents.roots()) {
          const sid = r.id || r.sessionId || (r.session && r.session.id)
          if (!sid || !roots.has(sid)) continue
          if (r.status === 'running') {
            postNotify({ type: 'task-start', sessionId: sid, ts: Date.now() })
          }
        }
      } catch (err) {
        log('heartbeat error:', err && err.message)
      }
    }

    // If we are (re)loaded while a root agent is already working, tell the
    // tray app immediately so keep-awake engages.
    try {
      for (const r of ctx.agents.roots()) {
        const sid = r.id || r.sessionId || (r.session && r.session.id)
        if (!sid) continue
        if (r.status === 'running') {
          last.set(sid, 'running')
          postNotify({ type: 'task-start', sessionId: sid, ts: Date.now() })
          log('resumed running task:', sid)
        } else {
          last.set(sid, r.status || 'idle')
        }
      }
    } catch (err) {
      log('startup scan error:', err && err.message)
    }

    // Heartbeat so a tray app (re)started mid-task converges within a minute.
    ctx.timer.interval(() => announceRunning(), 60000)

    ctx.on('agent/status', (payload) => {
      try {
        const { agent, status } = payload || {}
        if (!agent || !status) return
        const sid = agent.id || agent.sessionId || (agent.session && agent.session.id)
        if (!sid) return
        const prev = last.get(sid) || ''
        last.set(sid, status)

        // Root agents only: in-process subagents finishing mid-turn are not
        // "task complete" and must not toggle power or popups.
        let isRoot = false
        try {
          isRoot = rootSessionIds(ctx).has(sid)
        } catch { /* keep false */ }
        if (!isRoot) return

        if (status === 'running') {
          if (prev !== 'running') {
            postNotify({ type: 'task-start', sessionId: sid, ts: Date.now() })
            log('task start:', sid)
          }
          return
        }
        if (status !== 'idle' || prev !== 'running') return

        let title = '任务已完成'
        try {
          const session = ctx.sessions.get(sid)
          const snap = session ? ctx.sessionTitle.get(session) : undefined
          if (snap && typeof snap.title === 'string' && snap.title.trim()) title = snap.title
        } catch { /* keep default */ }

        postNotify({
          type: 'task-complete',
          sessionId: sid,
          title,
          message: '已完成本轮任务，点击「查看」打开 Harness。',
          ts: Date.now(),
        })
        log('task complete:', sid, '|', title)
      } catch (err) {
        log('error:', err && err.message)
      }
    })

    ctx.on('dispose', () => log('dsh-tray-notifier disposed'))
  },
}
