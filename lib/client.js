// dsh-edit-turn - browser half.
//
// One entry point: a per-session controller mounted through the official
// `conversation.input.overlay` list slot. It renders the in-place editor and
// enhances the message rows the host UI exposes no action slot for - user
// messages have no official action slot, which is exactly why the edit entry
// lives on the DOM row.
//
// Row targeting reads the official `useChat` standard hook (the ChatSnapshot
// keyed by the same `data-chat-flow-key` the DOM publishes) plus the official
// `data-chat-flow-*` anchors. No React fiber introspection and no CSS-module
// class hashing are involved, so a host UI refactor cannot silently detach the
// action.
//
// The module is a classic client bundle (client-modules protocol): it registers
// a factory with window.__ModuleLoader__ and returns apply().
window.__ModuleLoader__.load({
  id: 'dsh-edit-turn',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { jsx, jsxs, Fragment } = jsxRuntime

    const NS = 'dsh-edit-turn'
    const ROUTE_PREFIX = '/dsh-edit-turn'

    /** Keep in sync with package.json and lib/index.js. */
    const PLUGIN_VERSION = '0.1.0'

    // --- copy -----------------------------------------------------------------

    const zh = {
      'action.edit': '编辑这条消息并重跑',
      'editor.title': '编辑这条消息',
      'editor.placeholder': '修改后确认，会话将回退到这条消息之前并重新跑这一轮。',
      'editor.save': '保存并重跑',
      'editor.review': '确认回退',
      'editor.cancel': '取消',
      'editor.pending': '正在回退并重跑…',
      'editor.warn.attachments': '这条消息包含图片或文件附件，改写会丢弃它们，只保留文字。',
      'editor.hint': '保存后，这条消息之后的全部内容（含当轮回复与工具调用）会从模型上下文中移除，并从这里重新开始。原始会话日志不会改写。',
      'confirm.title': '确认回退并重跑？',
      'confirm.body': '这条消息之后的全部内容会从模型上下文中移除，然后用你改写后的内容重新跑这一轮。原始会话日志保持不变。',
      'error.invalid': '请求无效，请刷新后重试。',
      'error.session-not-active': '这个会话当前未激活，请先打开该会话再编辑。',
      'error.session-not-found': '找不到该会话的日志。',
      'error.busy': '该会话正在回复中，请等回复结束后再编辑。',
      'error.not-editable': '这条消息不支持编辑。',
      'error.already-rolled-back': '这条消息已经不在当前上下文里了。',
      'error.stale': '会话刚刚发生了变化，请重试。',
      'error.forbidden': '请求来源不被允许。',
      'error.method': '请求方式不被接受，请刷新后重试。',
      'error.generic': '编辑失败，请重试。',
      'error.prompt': '已回退，但重跑没有启动。请手动发送改写后的内容。',
      'error.empty': '改写后的内容不能为空。',
      'error.internal': '服务器内部错误，请稍后重试。',
    }

    const en = {
      'action.edit': 'Edit this message and re-run',
      'editor.title': 'Edit this message',
      'editor.placeholder': 'Confirm after editing: the conversation rolls back to just before this message and this turn runs again.',
      'editor.save': 'Save and re-run',
      'editor.review': 'Confirm rollback',
      'editor.cancel': 'Cancel',
      'editor.pending': 'Rolling back and re-running...',
      'editor.warn.attachments': 'This message carries image or file attachments; rewriting keeps the text only.',
      'editor.hint': 'Saving removes everything after this message (including that turn\'s reply and tool calls) from the model context and starts again from here. The original session log is never rewritten.',
      'confirm.title': 'Roll back and re-run?',
      'confirm.body': 'Everything after this message leaves the model context, then this turn runs again from your revised text. The original session log stays untouched.',
      'error.invalid': 'Invalid request; refresh and try again.',
      'error.session-not-active': 'This session is not open in DSH; open it first.',
      'error.session-not-found': 'No session log was found for this id.',
      'error.busy': 'This session is still replying; wait for it to finish.',
      'error.not-editable': 'This message cannot be edited.',
      'error.already-rolled-back': 'This message is no longer in the current context.',
      'error.stale': 'The session just changed; try again.',
      'error.forbidden': 'The request origin is not allowed.',
      'error.method': 'The request method is not accepted; refresh and try again.',
      'error.generic': 'The edit failed; try again.',
      'error.prompt': 'Rolled back, but the re-run did not start. Send the revised text manually.',
      'error.empty': 'The revised message cannot be empty.',
      'error.internal': 'The host hit an internal error; try again shortly.',
    }

    // Every error code the host can return travels through here. A code is
    // validated against the dictionary before it becomes a lookup key, so a
    // missing or unknown code can never reach `t()` as a constructed key - the
    // locale would return the key itself and the UI would print
    // "error.undefined" at the user.
    const ERROR_KEYS = new Set(Object.keys(en).filter((key) => key.startsWith('error.')))
    function errorText(t, code) {
      return t(typeof code === 'string' && ERROR_KEYS.has(`error.${code}`) ? `error.${code}` : 'error.generic')
    }

    // --- style ----------------------------------------------------------------

    const CSS = [
      '.dshet-action{width:28px;height:28px;padding:6px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;transition:background-color .12s,color .12s}',
      '.dshet-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.dshet-action:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4d6bfe);outline-offset:2px}',
      '.dshet-action:disabled{cursor:default;opacity:.4}',
      '.dshet-action svg{width:15px;height:15px}',
      '.dshet-action-host{display:inline-flex;align-items:center;justify-content:center}',
      '.dshet-row{position:relative}',
      '.dshet-floating{position:absolute;top:2px;right:6px;z-index:2;opacity:0;transition:opacity .12s}',
      '.dshet-row:hover .dshet-floating,.dshet-floating:focus-within{opacity:1}',
      '.dshet-collapsing{overflow:hidden;transition:height .2s ease,opacity .14s ease,margin .2s ease,padding .2s ease}',
      '[data-dshet-hidden="1"]{display:none!important}',
      '.dshet-editor{margin:8px 0 4px;padding:12px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 2px 10px rgba(0,0,0,.06)}',
      '.dshet-editor-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
      '.dshet-editor textarea{width:100%;min-height:84px;max-height:46vh;resize:vertical;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.32));border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:14px;line-height:22px}',
      '.dshet-editor textarea:focus{outline:none;border-color:var(--dsw-alias-button-primary-fill,#4d6bfe)}',
      '.dshet-editor textarea:disabled{opacity:.6}',
      '.dshet-note{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:19px}',
      '.dshet-warn{margin:8px 0 0;color:var(--dsw-alias-state-warning-primary,#c47b12);font-size:12px;line-height:19px}',
      '.dshet-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary,#d54941);font-size:12px;line-height:19px}',
      '.dshet-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:12px}',
      '.dshet-btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.32));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background-color .12s,border-color .12s}',
      '.dshet-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.dshet-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4d6bfe);outline-offset:2px}',
      '.dshet-btn:disabled{cursor:default;opacity:.5}',
      '.dshet-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.dshet-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,#4d6bfe);filter:brightness(1.08)}',
      '.dshet-notice{margin:4px 0;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));color:var(--dsw-alias-state-error-primary,#d54941);font-size:12px;line-height:19px}',
      '.dshet-spacer{flex:1 1 auto}',
      '@media (prefers-reduced-motion:reduce){.dshet-collapsing{transition:none}.dshet-floating{transition:none}}',
    ].join('')

    const TAG_ID = 'dsh-edit-turn/edit-turn.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --- icon -----------------------------------------------------------------

    // Hand-drawn pencil glyph: body, tip, baseline.
    const ICON_PATHS = [
      'M11.2 2.4l2.4 2.4',
      'M3.1 10.5l7.1-7.1 2.4 2.4-7.1 7.1-3.1.7z',
      'M2.6 13.6h10.8',
    ]
    const ICON_MARKUP =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      ICON_PATHS.map(
        (d) =>
          '<path d="' + d + '" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
      ).join('') +
      '</svg>'

    function PencilIcon() {
      return jsx('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        children: ICON_PATHS.map((d, index) =>
          jsx('path', { d, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }, index),
        ),
      })
    }

    // --- controller -----------------------------------------------------------

    class EditController {
      constructor(sessionId) {
        this.sessionId = sessionId
        this.listeners = new Set()
        this.inflight = null
        this.animateOnce = false
        this.editor = null
        this.editorElement = null
        this.editorDraft = ''
        this.confirming = false
        this.noticeTimer = null
        this.view = Object.freeze({
          hidden: new Map(),
          editable: new Map(),
          editing: null,
          draft: '',
          confirming: false,
          pending: false,
          failure: null,
          notice: null,
          surfaceReady: false,
          loaded: false,
          loadError: false,
          confirmStep: true,
          revision: 0,
        })
      }

      getSnapshot = () => this.view

      subscribe = (listener) => {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }

      publish(patch) {
        this.view = Object.freeze({ ...this.view, ...patch, revision: this.view.revision + 1 })
        for (const listener of this.listeners) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-edit-turn] subscriber threw:', error)
          }
        }
      }

      consumeAnimate() {
        const value = this.animateOnce === true
        this.animateOnce = false
        return value
      }

      load(force) {
        if (this.inflight !== null) return this.inflight
        if (this.view.loaded && force !== true) return Promise.resolve()
        const url = `${ROUTE_PREFIX}/state?sessionId=${encodeURIComponent(this.sessionId)}`
        const pending = fetch(url, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}))
            if (!res.ok || !data.ok) throw new Error(data && data.error ? String(data.error) : `HTTP ${res.status}`)
            const hidden = new Map()
            for (const item of Array.isArray(data.hidden) ? data.hidden : []) {
              if (item && typeof item.seq === 'number') hidden.set(item.seq, item.turn)
            }
            const editable = new Map()
            for (const turn of Array.isArray(data.turns) ? data.turns : []) {
              if (turn && typeof turn.seq === 'number') editable.set(turn.seq, turn)
            }
            this.publish({
              hidden,
              editable,
              surfaceReady: true,
              loaded: true,
              loadError: false,
              confirmStep: !(data.config && data.config.confirm === false),
            })
          })
          .catch(() => {
            this.publish({ loadError: true })
          })
          .finally(() => {
            this.inflight = null
          })
        this.inflight = pending
        return pending
      }

      open(target) {
        this.load()
        this.editor = target
        this.editorDraft = target.text
        this.confirming = false
        this.editorElement = null
        this.publish({ editing: target, draft: target.text, confirming: false, failure: null })
      }

      close() {
        if (this.view.pending) return
        this.editor = null
        this.editorDraft = ''
        this.confirming = false
        this.editorElement = null
        this.publish({ editing: null, draft: '', confirming: false, failure: null })
      }

      setDraft(value) {
        this.editorDraft = value
      }

      review() {
        if (this.editorDraft.trim() === '') {
          this.publish({ failure: 'empty' })
          return
        }
        if (this.view.confirmStep === false) {
          this.confirm()
          return
        }
        this.confirming = true
        this.publish({ confirming: true, draft: this.editorDraft, failure: null })
      }

      back() {
        if (this.view.pending) return
        this.confirming = false
        this.publish({ confirming: false, failure: null })
      }

      async confirm() {
        const target = this.editor
        if (target === null || this.view.pending) return
        const text = this.editorDraft
        if (text.trim() === '') {
          this.publish({ failure: 'empty' })
          return
        }
        this.publish({ pending: true, failure: null })
        try {
          const res = await fetch(`${ROUTE_PREFIX}/apply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: this.sessionId,
              seq: target.seq,
              messageId: typeof target.messageId === 'string' ? target.messageId : undefined,
              text,
            }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) {
            this.publish({ pending: false, failure: data && data.code ? String(data.code) : 'generic' })
            return
          }
          const hidden = new Map(this.view.hidden)
          for (const seq of Array.isArray(data.shadowed) ? data.shadowed : []) hidden.set(seq, target.turn)
          const editable = new Map(this.view.editable)
          for (const entry of editable.values()) {
            if (hidden.has(entry.seq)) editable.delete(entry.seq)
          }
          this.animateOnce = true
          this.editor = null
          this.editorDraft = ''
          this.editorElement = null
          this.confirming = false
          this.publish({
            pending: false,
            editing: null,
            confirming: false,
            hidden,
            editable,
            failure: null,
          })
          // The rollback has landed, so the editor is gone with its row: a
          // failed re-run has to be reported somewhere that survives that.
          if (data.promptAccepted === false) this.notify('prompt')
        } catch {
          this.publish({ pending: false, failure: 'generic' })
        }
      }

      notify(code) {
        if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer)
        this.publish({ notice: code })
        this.noticeTimer = window.setTimeout(() => {
          this.noticeTimer = null
          this.publish({ notice: null })
        }, 12_000)
      }

      dismissNotice() {
        if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer)
        this.noticeTimer = null
        this.publish({ notice: null })
      }

      dispose() {
        this.listeners.clear()
        if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer)
        this.noticeTimer = null
        this.editorElement = null
      }
    }

    // --- row targets ----------------------------------------------------------

    // The editable target of a Chat view node, or null when the row is not a
    // human prompt the user can rewrite.
    function targetFor(node, editable, hidden) {
      if (!node || node.kind !== 'user') return null
      const data = node.data || {}
      const seq = typeof data.seq === 'number' ? data.seq : node.anchorSeq
      if (typeof seq !== 'number') return null
      if (hidden.has(seq)) return null
      const entry = editable.get(seq)
      if (!entry) return null
      return {
        seq,
        turn: entry.turn,
        messageId: entry.messageId,
        text: typeof entry.text === 'string' ? entry.text : '',
        attachments: typeof entry.attachments === 'number' ? entry.attachments : 0,
      }
    }

    // Every surface seq a row stands for, so one rollback can hide the rows it
    // shadowed however the host UI chose to group them.
    function seqsFor(node) {
      const data = node.data || {}
      const out = []
      const push = (value) => {
        if (typeof value === 'number' && !out.includes(value)) out.push(value)
      }
      switch (node.kind) {
        case 'user':
        case 'context':
        case 'steering':
          push(data.seq)
          break
        case 'assistant-step':
          push(node.anchorSeq)
          if (data.finalNode) push(data.finalNode.seq)
          break
        case 'tool-call':
          if (data.root) push(data.root.seq)
          break
        case 'turn-tail':
          push(node.anchorSeq)
          if (data.closing && data.closing.finalNode) push(data.closing.finalNode.seq)
          break
        case 'turn-process':
          push(data.answerAnchorSeq)
          break
        default:
          push(node.anchorSeq)
      }
      return out
    }

    function isRowHidden(hidden, seqs) {
      for (const seq of seqs) {
        if (hidden.has(seq)) return true
      }
      return false
    }

    // --- dom enhancement ------------------------------------------------------

    const rowActions = new WeakMap()

    function setRowHidden(row, hide, animate) {
      if (hide) {
        if (row.dataset.dshetHidden === '1') return
        row.dataset.dshetHidden = '1'
        if (!animate || typeof requestAnimationFrame !== 'function') {
          row.style.display = 'none'
          return
        }
        const height = row.getBoundingClientRect().height
        row.classList.add('dshet-collapsing')
        row.style.height = `${height}px`
        row.style.opacity = '1'
        requestAnimationFrame(() => {
          row.style.height = '0px'
          row.style.opacity = '0'
          row.style.marginTop = '0px'
          row.style.marginBottom = '0px'
          row.style.paddingTop = '0px'
          row.style.paddingBottom = '0px'
        })
        window.setTimeout(() => {
          if (row.dataset.dshetHidden !== '1') return
          row.classList.remove('dshet-collapsing')
          row.style.display = 'none'
        }, 240)
        return
      }
      if (row.dataset.dshetHidden !== '1') return
      delete row.dataset.dshetHidden
      row.classList.remove('dshet-collapsing')
      row.style.display = ''
      row.style.height = ''
      row.style.opacity = ''
      row.style.marginTop = ''
      row.style.marginBottom = ''
      row.style.paddingTop = ''
      row.style.paddingBottom = ''
    }

    function removeRowAction(row) {
      const entry = rowActions.get(row)
      if (!entry) return
      entry.host.remove()
      rowActions.delete(row)
    }

    function injectRowAction(row, target, controller, t) {
      const label = t('action.edit')
      let entry = rowActions.get(row)
      if (!entry) {
        const host = document.createElement('span')
        host.className = 'dshet-action-host'
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dshet-action dshet-row-action'
        button.innerHTML = ICON_MARKUP
        host.appendChild(button)
        entry = { host, button }
        rowActions.set(row, entry)
      }
      const { host, button } = entry
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label)
        button.setAttribute('title', label)
      }
      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        controller.open(target)
      }
      const anchor = row.querySelector('[class*="_actions"]')
      if (anchor) {
        host.classList.remove('dshet-floating')
        row.classList.remove('dshet-row')
        if (host.parentElement !== anchor) anchor.appendChild(host)
      } else {
        host.classList.add('dshet-floating')
        row.classList.add('dshet-row')
        if (host.parentElement !== row) row.appendChild(host)
      }
    }

    function clearEditor() {
      const elements = document.querySelectorAll('.dshet-editor')
      for (const element of elements) element.remove()
    }

    // The editor is plain DOM on purpose: the host row is a React subtree and
    // injecting a second controlled tree into it would fight its reconciler.
    // The draft is mirrored into the controller on every input event, so a
    // host re-render that wipes the textarea cannot lose what was typed.
    // The re-render marker for the in-place editor.
    //
    // Every field `renderEditor` reads belongs here. A marker that only tracks
    // the target makes the editor a dead end: the confirmation step publishes new
    // state, the marker stays equal, the node is never rebuilt, and the button
    // keeps offering "save" instead of advancing to "confirm" - the editor
    // becomes unclickable from the user's side.
    function editorMarker(target, view) {
      return [
        target.seq,
        view.confirming ? 1 : 0,
        view.pending ? 1 : 0,
        view.failure === null ? '' : view.failure,
      ].join('|')
    }

    function renderEditor(row, controller, view, t) {
      const target = view.editing
      const marker = editorMarker(target, view)
      const existing = row.querySelector('.dshet-editor')
      if (existing && existing.dataset.dshetFor === marker) return

      clearEditor()
      const box = document.createElement('div')
      box.className = 'dshet-editor'
      box.dataset.dshetFor = marker

      const title = document.createElement('p')
      title.className = 'dshet-editor-title'
      title.textContent = view.confirming ? t('confirm.title') : t('editor.title')
      box.appendChild(title)

      const area = document.createElement('textarea')
      area.rows = 4
      area.value = controller.editorDraft
      area.disabled = view.pending || view.confirming
      area.spellcheck = false
      area.setAttribute('aria-label', t('editor.title'))
      if (!view.confirming) area.placeholder = t('editor.placeholder')
      area.addEventListener('input', () => controller.setDraft(area.value))
      box.appendChild(area)

      const note = document.createElement('p')
      note.className = 'dshet-note'
      note.textContent = view.confirming ? t('confirm.body') : t('editor.hint')
      box.appendChild(note)

      if (target.attachments > 0) {
        const warn = document.createElement('p')
        warn.className = 'dshet-warn'
        warn.textContent = t('editor.warn.attachments')
        box.appendChild(warn)
      }
      if (typeof view.failure === 'string' && view.failure !== '') {
        const error = document.createElement('p')
        error.className = 'dshet-error'
        error.setAttribute('role', 'status')
        error.textContent = errorText(t, view.failure)
        box.appendChild(error)
      }

      const footer = document.createElement('div')
      footer.className = 'dshet-footer'

      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'dshet-btn'
      cancel.textContent = t('editor.cancel')
      cancel.disabled = view.pending
      cancel.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (view.confirming) controller.back()
        else controller.close()
      }

      const submit = document.createElement('button')
      submit.type = 'button'
      submit.className = 'dshet-btn dshet-btn-primary'
      submit.textContent = view.pending
        ? t('editor.pending')
        : view.confirming
          ? t('editor.review')
          : t('editor.save')
      submit.disabled = view.pending
      submit.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (view.confirming) controller.confirm()
        else controller.review()
      }

      footer.appendChild(cancel)
      footer.appendChild(submit)
      box.appendChild(footer)

      row.appendChild(box)
      if (!view.confirming && !view.pending) {
        try {
          area.focus()
          area.setSelectionRange(area.value.length, area.value.length)
        } catch {
          /* focus is best-effort */
        }
      }
    }

    function applyDom(snapshot, view, controller, t) {
      if (!snapshot || !snapshot.nodes || typeof snapshot.nodes.get !== 'function') return
      const animate = controller.consumeAnimate()
      const rows = document.querySelectorAll('[data-chat-flow-key]')
      for (const row of rows) {
        if (!(row instanceof HTMLElement)) continue
        const key = row.getAttribute('data-chat-flow-key')
        if (!key) continue
        const node = snapshot.nodes.get(key)
        if (!node) continue
        const hidden = isRowHidden(view.hidden, seqsFor(node))
        setRowHidden(row, hidden, animate)
        const target = hidden ? null : targetFor(node, view.editable, view.hidden)
        if (target !== null) injectRowAction(row, target, controller, t)
        else removeRowAction(row)
        if (
          !hidden &&
          view.editing !== null &&
          typeof view.editing.seq === 'number' &&
          target !== null &&
          target.seq === view.editing.seq
        ) {
          renderEditor(row, controller, view, t)
        }
      }
      if (view.editing === null) clearEditor()
    }

    // --- react entries --------------------------------------------------------

    function OverlayEntry({ useChat, useEditTurn, controller, t }) {
      const snapshot = typeof useChat === 'function' ? useChat((state) => state) : undefined
      const view = useEditTurn((state) => state)

      react.useEffect(() => {
        controller.load()
      }, [controller])

      react.useEffect(() => {
        if (snapshot === undefined) return undefined
        let scheduled = false
        const run = () => {
          scheduled = false
          applyDom(snapshot, view, controller, t)
        }
        run()
        const observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
          else window.setTimeout(run, 16)
        })
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
        }
      }, [snapshot, view, controller, t])

      return jsxs(Fragment, {
        children: [
          typeof view.notice !== 'string' || view.notice === ''
            ? null
            : jsx('div', {
                className: 'dshet-notice',
                role: 'status',
                onClick: () => controller.dismissNotice(),
                children: errorText(t, view.notice),
              }),
        ],
      })
    }

    // --- plugin ---------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-edit-turn: dictionaries')

      const controllers = new Map()
      const controllerFor = (sessionId) => {
        let controller = controllers.get(sessionId)
        if (controller === undefined) {
          controller = new EditController(sessionId)
          controllers.set(sessionId, controller)
        }
        return controller
      }
      ctx.effect(
        () => () => {
          for (const controller of controllers.values()) controller.dispose()
          controllers.clear()
        },
        'dsh-edit-turn: per-session controllers',
      )

      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'edit-turn',
            order: 9,
            locale: NS,
            inject: (sessionId) => ({ hooks: { editTurn: controllerFor(sessionId) }, controller: controllerFor(sessionId) }),
          },
          OverlayEntry,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.PLUGIN_VERSION = PLUGIN_VERSION
    return module.exports
  },
})
