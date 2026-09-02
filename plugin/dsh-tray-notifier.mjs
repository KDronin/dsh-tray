// DeepSeek Harness → DSHTray notification/power bridge (v3).
// Persistently installed through $DSH_HOME/cordis.patch.yml (host plane).
// - task-start   : a root agent started working → tray keeps the PC awake
// - task-complete: a root agent finished (running→idle) → tray notifies and
//                  may auto-sleep when the user is away
// - approval     : permission request → tray popup with Allow / Reject
// - question     : ask_user_question → tray popup with option buttons
//
// v3 fix: the harness allows exactly ONE active user-questions provider
// (`ctx.userQuestions.registerProvider` throws DUPLICATE_PROVIDER on a second
// registration), and dsh-web-app's api-gateway owns that registration. This
// plugin used to register its own provider, which raced the gateway and
// failed the whole plugin tree at boot. It now never registers a provider;
// it waits for the existing one to appear and WRAPS it (tray first, the
// original provider as the fallback when the tray is unreachable).
import { request, createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NOTIFY_PORT = 3489
const ANSWER_PORT = 3491
const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG = join(__dirname, 'dsh-tray-notifier.log')

const pendingApprovals = new Map()
const pendingQuestions = new Map()

function log(...a) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`)
  } catch { /* ignore */ }
}

function postNotify(payload, cb) {
  const body = JSON.stringify(payload)
  let done = false
  const finish = (ok) => {
    if (done) return
    done = true
    if (cb) cb(ok)
  }
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
    (res) => {
      res.resume()
      finish(res.statusCode === 200)
    },
  )
  req.on('error', () => finish(false))
  req.on('timeout', () => {
    req.destroy()
    finish(false)
  })
  req.end(body)
}

function startAnswerServer() {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/answer') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 1000000) req.destroy()
      })
      req.on('end', () => {
        let data
        try { data = JSON.parse(body) } catch { data = null }
        if (!data || typeof data !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end('{"ok":false}')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        handleAnswer(data)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('error', (err) => log('answer server error:', err && err.message))
  server.listen(ANSWER_PORT, '127.0.0.1', () => log('answer endpoint listening on 127.0.0.1:' + ANSWER_PORT))
  return server
}

function handleAnswer(data) {
  try {
    if (data.type === 'approval') {
      const pending = pendingApprovals.get(data.id)
      if (!pending) return
      pendingApprovals.delete(data.id)
      const decision = data.decision
      if (decision === 'allowed-once' || decision === 'rejected' || decision === 'cancelled') {
        pending.resolve(decision)
      } else {
        pending.resolve('rejected')
      }
      return
    }
    if (data.type === 'question') {
      const pending = pendingQuestions.get(data.id)
      if (!pending) return
      pendingQuestions.delete(data.id)
      if (data.cancelled) {
        pending.reject(new Error('user cancelled the question from tray'))
      } else if (Array.isArray(data.answers)) {
        pending.resolve({ answers: data.answers })
      } else {
        pending.reject(new Error('invalid question answer from tray'))
      }
    }
  } catch (err) {
    log('handleAnswer error:', err && err.message)
  }
}

function rootSessionIds(ctx) {
  try {
    return new Set(ctx.agents.roots().map((r) => r.id || r.sessionId || (r.session && r.session.id)).filter(Boolean))
  } catch {
    return new Set()
  }
}

function sessionIdOfAgent(agent) {
  if (!agent) return undefined
  return agent.id || agent.sessionId || (agent.session && agent.session.id) || undefined
}

export default {
  name: 'dsh-tray-notifier',
  inject: ['agents', 'sessions', 'sessionTitle', 'timer'],
  apply(ctx) {
    log('dsh-tray-notifier v3 applied')
    const last = new Map()
    const answerServer = startAnswerServer()

    const announceRunning = () => {
      try {
        const roots = new Set(rootSessionIds(ctx))
        for (const r of ctx.agents.roots()) {
          const sid = r.id || r.sessionId || (r.session && r.session.id)
          if (!sid || !roots.has(sid)) continue
          if (r.status === 'running') {
            let title
            try {
              const session = ctx.sessions.get(sid)
              const snap = session ? ctx.sessionTitle.get(session) : undefined
              if (snap && typeof snap.title === 'string' && snap.title.trim()) title = snap.title
            } catch { /* ignore */ }
            postNotify({ type: 'task-start', sessionId: sid, title, ts: Date.now() })
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
          let title
          try {
            const session = ctx.sessions.get(sid)
            const snap = session ? ctx.sessionTitle.get(session) : undefined
            if (snap && typeof snap.title === 'string' && snap.title.trim()) title = snap.title
          } catch { /* ignore */ }
          postNotify({ type: 'task-start', sessionId: sid, title, ts: Date.now() })
          log('resumed running task:', sid, '|', title || '(no title)')
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
            let title
            try {
              const session = ctx.sessions.get(sid)
              const snap = session ? ctx.sessionTitle.get(session) : undefined
              if (snap && typeof snap.title === 'string' && snap.title.trim()) title = snap.title
            } catch { /* ignore */ }
            postNotify({ type: 'task-start', sessionId: sid, title, ts: Date.now() })
            log('task start:', sid, '|', title || '(no title)')
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

    // ---- Permission / approval requests ----
    ctx.on('approval/request', (req, next) => {
      try {
        const id = `approval:${sessionIdOfAgent(req.agent) || 'agent'}:${req.toolName || ''}:${req.callId || ''}:${Date.now()}:${Math.random().toString(36).slice(2)}`
        return new Promise((resolve) => {
          let settled = false
          const finish = (outcome) => {
            if (settled) return
            settled = true
            if (req.signal) {
              try { req.signal.removeEventListener('abort', onAbort) } catch { /* ignore */ }
            }
            pendingApprovals.delete(id)
            resolve(outcome)
          }
          const onAbort = () => finish('cancelled')
          if (req.signal) {
            if (req.signal.aborted) {
              finish('cancelled')
              return
            }
            req.signal.addEventListener('abort', onAbort, { once: true })
          }
          pendingApprovals.set(id, { resolve: finish })
          postNotify({
            type: 'approval',
            id,
            toolName: req.toolName,
            callId: req.callId,
            reason: req.reason,
            sessionId: sessionIdOfAgent(req.agent),
            answerPort: ANSWER_PORT,
            ts: Date.now(),
          }, (ok) => {
            if (!ok) {
              // Tray is not available; let the normal web approval UI handle it.
              pendingApprovals.delete(id)
              Promise.resolve(next()).then(finish, () => finish('unavailable'))
            }
          })
        })
      } catch (err) {
        log('approval/request error:', err && err.message)
        return next()
      }
    })

    // ---- User questions ----
    // The harness allows exactly ONE active user-questions provider; the
    // web app's api-gateway owns it. Registering our own used to race the
    // gateway and fail the whole plugin tree with DUPLICATE_PROVIDER, so we
    // never register: we wait for the existing provider and wrap it instead.
    // The tray answers first; the original provider is the fallback when the
    // tray is unreachable.
    let originalQuestionProvider = undefined
    let wrappedUserQuestions = null
    let restoreQuestionProvider = null
    const wrappedQuestionProvider = {
      ask: (request) => {
        const id = `question:${sessionIdOfAgent(request.agent) || 'agent'}:${Date.now()}:${Math.random().toString(36).slice(2)}`
        return new Promise((resolve, reject) => {
          const pending = { resolve, reject }
          pendingQuestions.set(id, pending)
          const onAbort = () => {
            if (pendingQuestions.delete(id)) reject(new Error('question aborted'))
          }
          if (request.signal) {
            if (request.signal.aborted) {
              pendingQuestions.delete(id)
              reject(new Error('question aborted'))
              return
            }
            request.signal.addEventListener('abort', onAbort, { once: true })
          }
          postNotify({
            type: 'question',
            id,
            questions: request.questions,
            sessionId: sessionIdOfAgent(request.agent),
            answerPort: ANSWER_PORT,
            ts: Date.now(),
          }, (ok) => {
            if (!ok) {
              if (pendingQuestions.delete(id)) {
                if (originalQuestionProvider) {
                  originalQuestionProvider.ask(request).then(resolve, reject)
                } else {
                  reject(new Error('tray unavailable and no fallback question provider'))
                }
              }
            }
          })
        })
      },
    }

    const tryWrapQuestionProvider = () => {
      try {
        if (restoreQuestionProvider) return true
        const uq = ctx.get('userQuestions')
        if (!uq || !uq.provider) return false
        originalQuestionProvider = uq.provider
        wrappedUserQuestions = uq
        uq.provider = wrappedQuestionProvider
        restoreQuestionProvider = () => {
          if (wrappedUserQuestions && wrappedUserQuestions.provider === wrappedQuestionProvider) {
            wrappedUserQuestions.provider = originalQuestionProvider
          }
          wrappedUserQuestions = null
          restoreQuestionProvider = null
        }
        log('dsh-tray-notifier wrapped user-questions provider')
        return true
      } catch (err) {
        log('user-questions wrap error:', err && err.message)
        return false
      }
    }
    if (!tryWrapQuestionProvider()) {
      // The gateway registers its provider during boot; probe briefly for it
      // to land (500ms x 60 = 30s), then give up quietly.
      let wrapTries = 0
      const wrapProbe = ctx.timer.interval(() => {
        wrapTries += 1
        if (tryWrapQuestionProvider() || wrapTries >= 60) wrapProbe()
      }, 500)
    }

    ctx.on('dispose', () => {
      log('dsh-tray-notifier disposed')
      try { answerServer.close() } catch { /* ignore */ }
      if (restoreQuestionProvider) {
        try { restoreQuestionProvider() } catch { /* ignore */ }
      }
      for (const pending of pendingApprovals.values()) pending.resolve('cancelled')
      pendingApprovals.clear()
      for (const pending of pendingQuestions.values()) pending.reject(new Error('dsh-tray-notifier disposed'))
      pendingQuestions.clear()
    })
  },
}
