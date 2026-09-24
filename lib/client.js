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
    const PLUGIN_VERSION = '0.2.0'

    // --- copy -----------------------------------------------------------------

    const zh = {
      'action.edit': '编辑这条消息并重跑',
      'action.edit-reply': '编辑这条回答',
      'editor.title': '编辑这条消息',
      'editor.title-reply': '编辑这条回答',
      'editor.placeholder': '修改后保存，会话将回退到这条消息之前并重新跑这一轮。',
      'editor.placeholder-reply': '改成你希望模型说过的内容，保存后它就成为这条回答。',
      'editor.save': '保存并重跑',
      'editor.save-reply': '保存替换',
      'editor.review': '确认执行',
      'editor.cancel': '取消',
      'editor.pending': '正在执行…',
      'editor.warn.attachments': '这条消息包含图片或文件附件，改写会丢弃它们，只保留文字。',
      'editor.warn-reply': '这条回答包含工具调用或思考过程，替换后它们会被一并移除。',
      'editor.hint': '保存后，这条消息之后的全部内容（含当轮回复与工具调用）会从模型上下文中移除，并从这里重新开始。原始会话日志不会改写。',
      'editor.hint-reply': '保存后，这条回答会被替换为你写的内容，它之后的内容一并移除。模型会把你写的内容当成自己说过的话，对话可以继续下去。原始会话日志不会改写。',
      'confirm.title': '确认执行？',
      'confirm.body': '确认后会立即执行：这条消息之后的内容会从模型上下文中移除。原始会话日志不会改写。',
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
      'error.reply': '已回退，但替换没有落地。请重试。',
      'error.empty': '改写后的内容不能为空。',
      'error.internal': '服务器内部错误，请稍后重试。',
    }

    const en = {
      'action.edit': 'Edit this message and re-run',
      'action.edit-reply': 'Edit this reply',
      'editor.title': 'Edit this message',
      'editor.title-reply': 'Edit this reply',
      'editor.placeholder': 'Saving rolls the conversation back to just before this message and this turn runs again.',
      'editor.placeholder-reply': 'Write what you want the model to have said; saving makes it this reply.',
      'editor.save': 'Save and re-run',
      'editor.save-reply': 'Save replacement',
      'editor.review': 'Confirm',
      'editor.cancel': 'Cancel',
      'editor.pending': 'Working...',
      'editor.warn.attachments': 'This message carries image or file attachments; rewriting keeps the text only.',
      'editor.warn-reply': 'This reply carries tool calls or reasoning; replacing it removes them.',
      'editor.hint': 'Saving removes everything after this message (including that turn\'s reply and tool calls) from the model context and starts again from here. The original session log is never rewritten.',
      'editor.hint-reply': 'Saving replaces this reply with your text and removes everything after it. The model goes on treating your words as its own, so the conversation can continue from here. The original session log is never rewritten.',
      'confirm.title': 'Confirm?',
      'confirm.body': 'Confirming applies right away: everything after this message leaves the model context. The original session log is never rewritten.',
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
      'error.reply': 'Rolled back, but the replacement did not land. Try again.',
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

    // A skin is free to make the theme's surface colours translucent - that is
    // the point of one: the artwork shows through, and the skin compensates by
    // giving *its own* elements a readable background and a text halo. A plugin's
    // classes are not in that list, so anything painted with --dsw-alias-bg-*
    // can end up with no background at all and become unreadable over the art.
    // (Seen in practice: a skin sets --dsw-alias-bg-base to a fully transparent
    // colour at scrim 0, and --dsw-alias-bg-layer-1 to a ~50% tint.)
    //
    // So this panel paints its own opaque surface and switches on the official
    // dark-theme hook `body[data-ds-dark-theme]`, which the theme and the official
    // UI packages use. Theme variables are still used for *colours* (hue,
    // semantic tones) - those survive a skin; it is alpha that does not.
    const CSS = [
      ':root{--dshet-panel:rgba(255,255,255,.96);--dshet-field:rgba(244,247,252,.98);--dshet-chip:rgba(255,255,255,.82);--dshet-line:rgba(16,24,40,.16);--dshet-ink:#0f1524;--dshet-ink-dim:#4b5872;--dshet-hover:rgba(16,24,40,.07);--dshet-shadow:0 12px 32px rgba(9,18,40,.22);--dshet-accent:#4d6bfe;--dshet-on-accent:#fff}',
      'body[data-ds-dark-theme]{--dshet-panel:rgba(22,28,44,.96);--dshet-field:rgba(14,19,33,.98);--dshet-chip:rgba(22,28,44,.82);--dshet-line:rgba(255,255,255,.18);--dshet-ink:#eef2f8;--dshet-ink-dim:#a6b1c6;--dshet-hover:rgba(255,255,255,.11);--dshet-shadow:0 12px 32px rgba(0,0,0,.5)}',
      '.dshet-action{width:28px;height:28px;padding:6px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:28px;background:transparent;color:var(--dshet-ink-dim);cursor:pointer;transition:background-color .12s,color .12s}',
      '.dshet-action:hover:not(:disabled){background:var(--dshet-chip);box-shadow:inset 0 0 0 1px var(--dshet-line);color:var(--dshet-ink)}',
      '.dshet-action:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dshet-accent));outline-offset:2px}',
      '.dshet-action:disabled{cursor:default;opacity:.4}',
      '.dshet-action svg{width:15px;height:15px}',
      '.dshet-action-host{display:inline-flex;align-items:center;justify-content:center}',
      '.dshet-row{position:relative}',
      '.dshet-floating{position:absolute;top:2px;right:6px;z-index:2;opacity:0;transition:opacity .12s}',
      '.dshet-row:hover .dshet-floating,.dshet-floating:focus-within{opacity:1}',
      '.dshet-collapsing{overflow:hidden;transition:height .2s ease,opacity .14s ease,margin .2s ease,padding .2s ease}',
      '[data-dshet-hidden="1"]{display:none!important}',
      '.dshet-editor{margin:8px 0 4px;padding:12px;border:1px solid var(--dshet-line);border-radius:12px;background:var(--dshet-panel);backdrop-filter:blur(18px) saturate(1.2);box-shadow:var(--dshet-shadow);color:var(--dshet-ink)}',
      '.dshet-editor-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dshet-ink)}',
      '.dshet-editor textarea{width:100%;min-height:84px;max-height:46vh;resize:vertical;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dshet-line);border-radius:8px;background:var(--dshet-field);color:var(--dshet-ink);font:inherit;font-size:14px;line-height:22px}',
      '.dshet-editor textarea::placeholder{color:var(--dshet-ink-dim)}',
      '.dshet-editor textarea:focus{outline:none;border-color:var(--dsw-alias-button-primary-fill,var(--dshet-accent))}',
      '.dshet-editor textarea:disabled{opacity:.65}',
      '.dshet-note{margin:8px 0 0;color:var(--dshet-ink-dim);font-size:12px;line-height:19px}',
      '.dshet-warn{margin:8px 0 0;color:var(--dsw-alias-state-warning-primary,#a2650a);font-size:12px;line-height:19px}',
      '.dshet-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary,#c93a31);font-size:12px;line-height:19px}',
      '.dshet-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:12px}',
      '.dshet-btn{padding:6px 14px;border:1px solid var(--dshet-line);border-radius:8px;background:var(--dshet-field);color:var(--dshet-ink);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background-color .12s,border-color .12s}',
      '.dshet-btn:hover:not(:disabled){background:var(--dshet-hover)}',
      '.dshet-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dshet-accent));outline-offset:2px}',
      '.dshet-btn:disabled{cursor:default;opacity:.5}',
      '.dshet-btn-primary{border-color:var(--dsw-alias-button-primary-fill,var(--dshet-accent));background:var(--dsw-alias-button-primary-fill,var(--dshet-accent));color:var(--dsw-alias-label-primary-foreground,var(--dshet-on-accent))}',
      '.dshet-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,var(--dshet-accent));filter:brightness(1.08)}',
      '.dshet-notice{margin:4px 0;padding:6px 10px;border:1px solid var(--dshet-line);border-radius:8px;background:var(--dshet-panel);backdrop-filter:blur(18px) saturate(1.2);box-shadow:var(--dshet-shadow);color:var(--dsw-alias-state-error-primary,#c93a31);font-size:12px;line-height:19px}',
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
        this.rowCount = -1
        this.editor = null
        this.editorElement = null
        this.editorDraft = ''
        this.confirming = false
        this.noticeTimer = null
        this.view = Object.freeze({
          hidden: new Map(),
          editable: new Map(),
          replies: new Map(),
          repliesByMessage: new Map(),
          editing: null,
          draft: '',
          confirming: false,
          pending: false,
          failure: null,
          notice: null,
          surfaceReady: false,
          loaded: false,
          loadError: false,
          // Matches the host's default: one click applies. Only an explicit
          // `confirm: true` in the profile turns the second step back on.
          confirmStep: false,
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
            // The model's replies are editable too, as a separate list: they are
            // rewritten rather than re-run, so the editor words the consequence
            // differently.
            const replies = new Map()
            const repliesByMessage = new Map()
            for (const reply of Array.isArray(data.replies) ? data.replies : []) {
              if (!reply || typeof reply.seq !== 'number') continue
              replies.set(reply.seq, reply)
              // The official assistant-actions strip hands us a messageId, so
              // replies are indexed by it too.
              if (typeof reply.messageId === 'string' && reply.messageId !== '') repliesByMessage.set(reply.messageId, reply)
            }
            this.publish({
              hidden,
              editable,
              replies,
              repliesByMessage,
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
          // A reply edit shadows its own reply too, so it leaves the editable
          // replies here and re-enters through the next /state refresh (the
          // appended correction is itself an editable reply).
          const replies = new Map(this.view.replies)
          for (const entry of replies.values()) {
            if (hidden.has(entry.seq)) replies.delete(entry.seq)
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
            replies,
            failure: null,
          })
          // The rollback has landed, so the editor is gone with its row: a
          // failed second half has to be reported somewhere that survives that.
          if (data.kind === 'reply' && data.applied === false) this.notify('reply')
          if (data.kind !== 'reply' && data.promptAccepted === false) this.notify('prompt')
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

    // The editable target of a Chat view node, or null when the row stands for
    // something that cannot be rewritten.
    //
    // Only human prompts come through here: a reply's entry comes from the
    // official assistant-actions strip instead, which is where the host puts
    // every other action for that row. Injecting one here used to put the pencil
    // in a different place from every other reply action.
    function targetFor(node, view) {
      if (!node || node.kind !== 'user') return null
      const data = node.data || {}
      const candidates = []
      const push = (value) => {
        if (typeof value === 'number' && !candidates.includes(value)) candidates.push(value)
      }
      push(data.seq)
      push(node.anchorSeq)
      for (const seq of candidates) {
        if (view.hidden.has(seq)) continue
        const entry = view.editable.get(seq)
        if (!entry) continue
        return {
          seq,
          mode: 'prompt',
          turn: entry.turn,
          messageId: entry.messageId,
          text: typeof entry.text === 'string' ? entry.text : '',
          attachments: typeof entry.attachments === 'number' ? entry.attachments : 0,
        }
      }
      return null
    }

    // The element that carries the turn-tail marker: either the flow-keyed row
    // itself or a wrapper inside it. Its own action strip is a direct child.
    function rootOfTurnTail(row) {
      if (typeof row.matches === 'function' && row.matches('[data-turn-tail]')) return row
      return row.querySelector('[data-turn-tail]')
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

    function injectRowAction(row, target, controller, t, options = {}) {
      const label = t(target.mode === 'reply' ? 'action.edit-reply' : 'action.edit')
      let entry = rowActions.get(row)
      if (!entry) {
        const host = document.createElement('span')
        host.className = 'dshet-action-host'
        // Marked so a later pass can tell this one apart from the one the
        // official assistant-actions strip renders, and drop the spare.
        if (options.fallback === true) host.dataset.dshetFallback = '1'
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
      // A caller that already picked the right bar (the turn tail's own strip)
      // hands it over; otherwise the first actions container in the row wins.
      const anchor = options.anchor ?? row.querySelector('[class*="_actions"]')
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

    // Every string the editor shows depends on what is being edited: a prompt is
    // re-run, a reply is replaced. Keeping them in one place keeps the two modes
    // from drifting apart in wording.
    function editorTexts(t, target) {
      const reply = target.mode === 'reply'
      return {
        title: t(reply ? 'editor.title-reply' : 'editor.title'),
        placeholder: t(reply ? 'editor.placeholder-reply' : 'editor.placeholder'),
        hint: t(reply ? 'editor.hint-reply' : 'editor.hint'),
        warn: t(reply ? 'editor.warn-reply' : 'editor.warn.attachments'),
        save: t(reply ? 'editor.save-reply' : 'editor.save'),
      }
    }

    function renderEditor(row, controller, view, t) {
      const target = view.editing
      const texts = editorTexts(t, target)
      const marker = editorMarker(target, view)
      const existing = row.querySelector('.dshet-editor')
      if (existing && existing.dataset.dshetFor === marker) return

      clearEditor()
      const box = document.createElement('div')
      box.className = 'dshet-editor'
      box.dataset.dshetFor = marker

      const title = document.createElement('p')
      title.className = 'dshet-editor-title'
      title.textContent = view.confirming ? t('confirm.title') : texts.title
      box.appendChild(title)

      const area = document.createElement('textarea')
      area.rows = 4
      area.value = controller.editorDraft
      area.disabled = view.pending || view.confirming
      area.spellcheck = false
      area.setAttribute('aria-label', texts.title)
      if (!view.confirming) area.placeholder = texts.placeholder
      area.addEventListener('input', () => controller.setDraft(area.value))
      box.appendChild(area)

      const note = document.createElement('p')
      note.className = 'dshet-note'
      note.textContent = view.confirming ? t('confirm.body') : texts.hint
      box.appendChild(note)

      if (target.attachments > 0) {
        const warn = document.createElement('p')
        warn.className = 'dshet-warn'
        warn.textContent = texts.warn
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
          : texts.save
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

    // Ask the host again whenever the transcript gains or loses rows.
    //
    // A change in the number of transcript rows is the signal that the host's
    // editable set may have moved on: a re-run appends a new prompt, which the
    // host will happily let the user edit but this half has never asked about.
    // Without this the plugin only ever worked once per page load - the second
    // edit had no action to click because the editable set was still the one
    // fetched at mount time.
    function syncEditableSet(controller, rowCount) {
      if (rowCount === controller.rowCount) return
      controller.rowCount = rowCount
      controller.load(true)
    }

    function applyDom(snapshot, view, controller, t) {
      if (!snapshot || !snapshot.nodes || typeof snapshot.nodes.get !== 'function') return
      const animate = controller.consumeAnimate()
      const rows = document.querySelectorAll('[data-chat-flow-key]')
      syncEditableSet(controller, rows.length)
      for (const row of rows) {
        if (!(row instanceof HTMLElement)) continue
        const key = row.getAttribute('data-chat-flow-key')
        if (!key) continue
        const node = snapshot.nodes.get(key)
        if (!node) continue
        const hidden = isRowHidden(view.hidden, seqsFor(node))
        setRowHidden(row, hidden, animate)
        const target = hidden ? null : targetFor(node, view)
        if (target !== null) {
          injectRowAction(row, target, controller, t)
        } else if (!hidden && node.kind === 'turn-tail') {
          // A reply's entry belongs in the host's own action strip, and that is
          // where it is registered. A slot entry that never renders leaves no
          // trace at all, though - no error, no gap - so the same pencil is also
          // offered through the turn tail's own strip, and only while that strip
          // does not already carry one. Both land in the platform's own bar, so
          // the position is identical either way.
          const covered = seqsFor(node).find((seq) => view.replies.has(seq) && !view.hidden.has(seq))
          // The strip lives inside the turn-tail root (`data-turn-tail`) as its
          // LAST direct child, while the row carrying the flow key may be a
          // wrapper around that root. Bounding the search by the tail root keeps
          // the tool-call bars inside the tail out of reach: those unmount as a
          // call expands, so a pencil parked there blinks, and it is not where
          // the reply's actions live anyway.
          const tailRoot = rootOfTurnTail(row)
          const bar =
            covered === undefined || tailRoot === null
              ? undefined
              : Array.from(tailRoot.children)
                  .reverse()
                  .find((child) => typeof child.className === 'string' && child.className.includes('_actions'))
          const slotPencil = bar === undefined ? null : bar.querySelector('.dshet-row-action:not([data-dshet-fallback])')
          if (covered !== undefined && bar !== undefined && slotPencil === null) {
            const entry = view.replies.get(covered)
            injectRowAction(
              row,
              {
                seq: covered,
                mode: 'reply',
                turn: entry.turn,
                messageId: entry.messageId,
                text: typeof entry.text === 'string' ? entry.text : '',
                attachments: typeof entry.attachments === 'number' ? entry.attachments : 0,
              },
              controller,
              t,
              { fallback: true, anchor: bar },
            )
          } else {
            // Either the strip's own entry is already there, or this row holds
            // nothing editable: any spare pencil of ours has to go.
            removeRowAction(row)
          }
        } else {
          removeRowAction(row)
        }
        // The editor anchors to whichever row covers the seq being edited, not to
        // the row that owns the entry: a reply's entry now lives in the turn-tail
        // action strip, while its editor still belongs under the reply text.
        if (
          !hidden &&
          view.editing !== null &&
          typeof view.editing.seq === 'number' &&
          seqsFor(node).includes(view.editing.seq)
        ) {
          renderEditor(row, controller, view, t)
        }
      }
      if (view.editing === null) clearEditor()
    }

    // The reply edit entry, registered in the host's own assistant-actions strip.
    //
    // It has to live there rather than be injected next to the message: the host
    // renders that strip per assistant message, hands the entry the messageId, and
    // keeps the platform's own reveal behaviour (always for the latest turn, hover
    // for older ones). Injecting instead put the pencil in a different place from
    // where every other action for that row lives, which is what users noticed.
    function ReplyActionEntry({ messageId, controller, useEditTurn, t }) {
      const view = useEditTurn((state) => state)
      const entry = view.repliesByMessage.get(messageId)
      if (entry === undefined || view.hidden.has(entry.seq)) return null
      const label = t('action.edit-reply')
      const open = (event) => {
        event.preventDefault()
        event.stopPropagation()
        controller.open({
          seq: entry.seq,
          mode: 'reply',
          turn: entry.turn,
          messageId: entry.messageId,
          text: typeof entry.text === 'string' ? entry.text : '',
          attachments: typeof entry.attachments === 'number' ? entry.attachments : 0,
        })
      }
      return jsx('button', {
        type: 'button',
        className: 'dshet-action dshet-row-action',
        'aria-label': label,
        title: label,
        onClick: open,
        children: jsx(PencilIcon, null),
      })
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

      // A reply's edit entry lives in the official assistant-actions strip, one
      // entry per assistant message. order 5 puts it ahead of the feedback
      // entries (order 10), so the pencil sits with the leading icons.
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'edit-turn-reply',
            order: 5,
            locale: NS,
            inject: (sessionId) => ({
              hooks: { editTurn: controllerFor(sessionId) },
              controller: controllerFor(sessionId),
            }),
          },
          ReplyActionEntry,
        ),
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
