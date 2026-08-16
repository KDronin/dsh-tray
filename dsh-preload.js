// Browser-like editing helpers injected into the maintained DSH web window.
// Fully replicates common browser/editor typing logic:
//   - typing one of " ' ( [ { （ “ ‘ 「 auto-inserts the closing pair
//   - typing the closing char right before an existing one skips over it
//   - backspace inside an empty pair removes both characters
'use strict'

const PAIRS = {
  '"': '"',
  "'": "'",
  '(': ')',
  '[': ']',
  '{': '}',
  '“': '”',
  '‘': '’',
  '「': '」',
}

function isEditable(t) {
  if (!t) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|search|url|email|password)$/i.test(t.type || 'text'))
}

function selection(t) {
  if (t.selectionStart !== undefined) {
    return { start: t.selectionStart, end: t.selectionEnd }
  }
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  return { range: r, collapsed: r.collapsed }
}

function getCharBefore(t) {
  if (t.selectionStart !== undefined) return t.value[t.selectionStart - 1] || ''
  const s = selection(t)
  if (!s || !s.collapsed) return ''
  const node = s.range.startContainer
  return node.nodeType === 3 ? (node.textContent || '')[s.range.startOffset - 1] || '' : ''
}

function getCharAfter(t) {
  if (t.selectionStart !== undefined) return t.value[t.selectionStart] || ''
  const s = selection(t)
  if (!s || !s.collapsed) return ''
  const node = s.range.startContainer
  return node.nodeType === 3 ? (node.textContent || '')[s.range.startOffset] || '' : ''
}

function hasSelection(t) {
  if (t.selectionStart !== undefined) return t.selectionStart !== t.selectionEnd
  const s = selection(t)
  return !!(s && !s.collapsed)
}

// React-friendly value setter (bypasses the framework's value tracker)
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function moveCaretBy(t, delta) {
  if (t.selectionStart !== undefined) {
    const p = t.selectionStart + delta
    t.selectionStart = t.selectionEnd = p
    return
  }
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return
  const r = sel.getRangeAt(0)
  const node = r.startContainer
  const off = r.startOffset + delta
  r.setStart(node, Math.max(0, off))
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
  const t = e.target
  if (!isEditable(t)) return
  const pair = PAIRS[e.key]
  if (!pair) return
  if (hasSelection(t)) return // never wrap an existing selection
  // typing the closing char before an existing one just skips over it
  if (getCharAfter(t) === pair) {
    e.preventDefault()
    moveCaretBy(t, 1)
    return
  }
  // insert the pair with the caret in the middle
  e.preventDefault()
  const open = e.key
  if (t.selectionStart !== undefined) {
    const s = t.selectionStart
    setNativeValue(t, t.value.slice(0, s) + open + pair + t.value.slice(s))
    moveCaretBy(t, 1)
  } else {
    document.execCommand('insertText', false, open + pair)
    moveCaretBy(t, -pair.length)
  }
})

// backspace inside an empty pair removes both characters
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Backspace' || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
  const t = e.target
  if (!isEditable(t)) return
  const before = getCharBefore(t)
  if (!PAIRS[before]) return
  if (getCharAfter(t) !== PAIRS[before]) return
  if (hasSelection(t)) return
  e.preventDefault()
  if (t.selectionStart !== undefined) {
    const s = t.selectionStart
    setNativeValue(t, t.value.slice(0, s - 1) + t.value.slice(s + 1))
    moveCaretBy(t, -1)
  } else {
    document.execCommand('delete', false) // remove the opening char
    document.execCommand('forwardDelete', false) // remove the closing char
  }
})
