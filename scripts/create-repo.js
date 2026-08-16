// Create a private GitHub repo for this plugin and set the dsh-plugin topic.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'github-auth.json'), 'utf8'))
const token = auth.token
const login = auth.login
const REPO = process.argv[2] || 'dsh-tray'

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = https.request({
      host: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'user-agent': 'dshtray',
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(b) } catch { parsed = null }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed)
        else reject(new Error(`HTTP ${res.statusCode}: ${(parsed && parsed.message) || b.slice(0, 200)}`))
      })
      res.on('error', reject)
    })
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

;(async () => {
  // 1. create the private repo (name conflict → append -2, -3, ...)
  let repo = REPO
  let created = null
  for (let i = 0; i < 5; i += 1) {
    try {
      created = await api('POST', '/user/repos', {
        name: repo,
        description: 'DeepSeek Harness 桌面托盘插件：托盘启动 Harness、任务完成通知、电源管理、进程接管、GitHub 集成',
        private: true,
        has_issues: true,
        has_wiki: false,
      })
      break
    } catch (err) {
      if (/422|name already exists/.test(String(err.message))) {
        repo = `${REPO}-${i + 2}`
        console.log('repo name taken, trying', repo)
        continue
      }
      throw err
    }
  }
  if (!created) throw new Error('无法创建仓库')
  console.log('REPO CREATED:', created.full_name, 'private =', created.private)

  // 2. set the dsh-plugin topic
  await api('PUT', `/repos/${login}/${repo}/topics`, { names: ['dsh-plugin'] })
  console.log('TOPIC SET: dsh-plugin')

  // 3. verify
  const check = await api('GET', `/repos/${login}/${repo}`)
  console.log('VERIFY:', JSON.stringify({ full_name: check.full_name, private: check.private, topics: check.topics, html_url: check.html_url }))
  fs.writeFileSync(path.join(__dirname, '..', '.repo-name'), repo)
})().catch((err) => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
