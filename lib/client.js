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
    // The sibling that owns re-running: it shadows a turn and regenerates it
    // from the prompt the surface now shows, then replays what followed. The
    // editor's re-run button is only offered when it is mounted.
    const RERUN_PREFIX = '/dsh-rerun-turn'

    /** Keep in sync with package.json and lib/index.js. */
    const PLUGIN_VERSION = '0.2.15'

    // --- copy -----------------------------------------------------------------

    const zh = {
      'action.edit': '编辑这条消息',
      'action.edit-reply': '编辑这条回答',
      'editor.title': '编辑这条消息',
      'editor.title-reply': '编辑这条回答',
      'editor.placeholder': '改成你希望自己当时说的内容。保存后这条消息之后的轮次会从模型上下文中移除，改后的内容成为新的起点。',
      'editor.placeholder-reply': '改成你希望模型说过的内容，保存后它就成为这条回答。',
      'editor.save': '保存',
      'editor.rerun': '重跑',
      'editor.save-reply': '保存',
      'editor.review': '确认执行',
      'editor.cancel': '取消',
      'editor.pending': '正在保存…',
      'editor.warn.attachments': '这条消息包含图片或文件附件，改写会丢弃它们，只保留文字。',
      'editor.warn-reply': '这条回答包含工具调用或思考过程，替换后它们会被一并移除。',
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
      'error.prompt': '已回退，但改后的内容没能写进上下文。请重试。',
      'error.reply': '已回退，但替换没有落地。请重试。',
      'error.empty': '改写后的内容不能为空。',
      'error.rerun-nothing': '已保存，但这一轮没有可重跑的作答。',
      'error.rerun-unavailable': '已保存，但重跑没有开始，请稍后重试。',
      'error.not-rerunnable': '这一轮没有可重跑的作答。',
      'error.already-retired': '这一轮的内容已经不在当前上下文里了。',
      'error.rerunning': '已经有一次重跑在进行中，请等它结束。',
      'error.internal': '服务器内部错误，请稍后重试。',
    }

    const en = {
      'action.edit': 'Edit this message',
      'action.edit-reply': 'Edit this reply',
      'editor.title': 'Edit this message',
      'editor.title-reply': 'Edit this reply',
      'editor.placeholder': 'Saving rolls the conversation back to just before this message and this turn runs again.',
      'editor.placeholder-reply': 'Write what you want the model to have said; saving makes it this reply.',
      'editor.save': 'Save',
      'editor.rerun': 'Re-run',
      'editor.save-reply': 'Save',
      'editor.review': 'Confirm',
      'editor.cancel': 'Cancel',
      'editor.pending': 'Working...',
      'editor.warn.attachments': 'This message carries image or file attachments; rewriting keeps the text only.',
      'editor.warn-reply': 'This reply carries tool calls or reasoning; replacing it removes them.',
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
      'error.rerun-nothing': 'Saved, but this turn has no reply that can be re-run.',
      'error.rerun-unavailable': 'Saved, but the re-run did not start; try again.',
      'error.not-rerunnable': 'This turn has no reply that can be re-run.',
      'error.already-retired': 'This turn is no longer part of the current context.',
      'error.rerunning': 'A re-run is already in flight; wait for it to finish.',
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
      // The pencil sits among the platform's own action icons, so it takes the
      // platform's icon colour: our own `--dshet-ink-dim` is a blue-grey and
      // read as a different, "active" icon next to the neutral grey ones. The
      // variable resolves on the action bar (and everywhere above it); the
      // fallback is the value it resolves to in the default theme.
      '.dshet-action{width:28px;height:28px;padding:6px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;transition:background-color .12s,color .12s}',
      '.dshet-action:hover:not(:disabled){background:var(--dshet-chip);box-shadow:inset 0 0 0 1px var(--dshet-line);color:var(--dsw-alias-label-primary,var(--dshet-ink))}',
      '.dshet-action:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dshet-accent));outline-offset:2px}',
      '.dshet-action:disabled{cursor:default;opacity:.4}',
      '.dshet-action svg{width:15px;height:15px}',
      // The reply pencil leads its strip. The host draws the copy button ahead of
      // the slot this entry is rendered into, and the strip lays its children out
      // in DOM order, so in DOM position the pencil can only ever come second -
      // behind the copy button, which is where the user does not look for it.
      // `order` reorders the flex line without touching the host's own tree.
      '.dshet-reply-action{order:-1}',
      // A prompt this plugin rewrote in place: the platform renders no bubble for
      // a replacement message, so this one is ours. Styled from the plugin own
      // namespaced variables, which follow the active theme without borrowing
      // CSS-module hashes that change between builds.
      // Font metrics copied from the platform's own user bubble
      // (`.Sixlwa_bubble`): a fixed size or `font:inherit` is wrong here -
      // inherit picks up the row's 16px, fixed ignores the reader's content
      // font setting, and either way the rewritten text changed size against
      // the bubble it replaces.
      '.dshet-revision{box-sizing:border-box;align-self:flex-end;width:fit-content;max-width:min(72ch,86%);margin:6px 0 6px auto;padding:9px 14px;border-radius:16px;background:var(--dshet-field);color:var(--dshet-ink);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}',
      '.dshet-revision:empty{display:none}',
      '.dshet-revision{position:relative}',
      // Fallback only: a row with no action bar to keep is displayed away
      // entirely, and then its pencil has nowhere but the bubble. It sits in a
      // gutter the bubble reserves for it, never over the text - an absolutely
      // positioned button inside the bubble used to land on the last line, which
      // is how the rewritten prompt got covered up.
      '.dshet-revision.dshet-revision-action{padding-inline-end:40px}',
      '.dshet-revision .dshet-action-host{position:absolute;inset-inline-end:6px;top:6px;opacity:0;transition:opacity .12s ease}',
      '.dshet-revision:hover .dshet-action-host,.dshet-revision:focus-within .dshet-action-host{opacity:1}',
      // A sibling plugin can append its own button (dsh-delete-turn's bin) into
      // the same bar at any time, which left this pencil one slot short of the
      // right end: DOM insertion order can never promise that position, so flex
      // order does. The bar is a flex container (`display:flex`) and every
      // platform item in it is `order:0`; the gutter and floating placements
      // ignore order, being absolutely positioned or in a block box.
      '.dshet-action-host{display:inline-flex;align-items:center;justify-content:center;order:9}',
      '.dshet-row{position:relative}',
      '.dshet-floating{position:absolute;top:2px;right:6px;z-index:2;opacity:0;transition:opacity .12s}',
      '.dshet-row:hover .dshet-floating,.dshet-floating:focus-within{opacity:1}',
      '.dshet-collapsing{overflow:hidden;transition:height .2s ease,opacity .14s ease,margin .2s ease,padding .2s ease}',
      // A row this plugin rolled back loses its message, not its action strip:
      // the platform's time / copy / delete buttons (and every other plugin's)
      // stay reachable, so only rows with nothing worth keeping go fully away.
      '[data-dshet-hidden="1"]:not([data-dshet-keep-actions]){display:none!important}',
      // One rounded container, the way the platform's own composer box is
      // built: the input is transparent and borderless inside it, the actions
      // sit at its bottom-right, and focus is shown on the container rather
      // than on a second box inside it. The input grows with its text (the
      // render/input paths call `fitEditorHeight`); `display:block` removes the
      // inline-block baseline gap a textarea would otherwise leave.
      // The editor lives OUTSIDE the message row, on a layer of its own pinned
      // to the body: the host re-renders that row whenever it likes, and an
      // input inside a subtree it rebuilds loses its drag selection, its IME
      // composition and its clicks a piece at a time. The layer covers the
      // viewport but only the box itself takes pointer events, and the box is
      // positioned under its row by `placeEditor`.
      '.dshet-layer{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:40}',
      '.dshet-layer .dshet-editor{position:absolute;pointer-events:auto}',
      '.dshet-editor{margin:0;border:1px solid var(--dshet-line);border-radius:16px;background:var(--dshet-panel);backdrop-filter:blur(18px) saturate(1.2);box-shadow:var(--dshet-shadow);color:var(--dshet-ink);transition:border-color .12s}',
      '.dshet-editor:focus-within{border-color:var(--dsw-alias-button-primary-fill,var(--dshet-accent))}',
      '.dshet-editor textarea{display:block;width:100%;min-height:47px;max-height:46vh;overflow-y:auto;resize:none;box-sizing:border-box;padding:11px 14px 0;border:0;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));outline:none}',
      '.dshet-editor textarea::placeholder{color:var(--dshet-ink-dim)}',
      '.dshet-editor textarea:disabled{opacity:.65}',
      '.dshet-note,.dshet-warn,.dshet-error{margin:4px 14px 0;font-size:12px;line-height:19px}',
      '.dshet-note{color:var(--dshet-ink-dim)}',
      '.dshet-warn{color:var(--dsw-alias-state-warning-primary,#a2650a)}',
      '.dshet-error{color:var(--dsw-alias-state-error-primary,#c93a31)}',
      '.dshet-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:4px 10px 10px}',
      '.dshet-btn{padding:6px 16px;border:1px solid var(--dshet-line);border-radius:999px;background:var(--dshet-field);color:var(--dshet-ink);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background-color .12s,border-color .12s}',
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
        // The live textarea and whether it currently holds the user's focus.
        // Focus is only ever taken on open, or handed back to a REBUILT box
        // when the user was typing in the one that was just replaced - never
        // taken from somewhere else. Rebuilding used to call `focus()`
        // unconditionally, so any host re-render of the row pulled the caret
        // out of whatever the user was typing in (the composer included).
        this.editorElement = null
        this.editorBox = null
        this.editorRow = null
        this.editorFocus = false
        this.editorDraft = ''
        this.clearTimer = null
        this.pendingRerun = false
        this.siblingRerun = 'unknown'
        // Bumped on every probe: an answer older than the newest probe is stale
        // and must not move the button.
        this.probeToken = 0
        this.confirming = false
        this.noticeTimer = null
        this.view = Object.freeze({
          hidden: new Map(),
          revisions: new Map(),
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
          // Whether the sibling that owns re-running (dsh-rerun-turn) is
          // mounted; probed when an editor opens, updated only on change.
          siblingRerun: 'unknown',
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
        // A refresh asked for while one is already running has to land *after*
        // it: handing back the in-flight response would answer with a snapshot
        // the host may have taken before a save, wiping out the very state that
        // save just published.
        if (this.inflight !== null) return this.inflight.then(() => this.load(force))
        if (this.view.loaded && force !== true) return Promise.resolve()
        const url = `${ROUTE_PREFIX}/state?sessionId=${encodeURIComponent(this.sessionId)}`
        const pending = fetch(url, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}))
            if (!res.ok || !data.ok) throw new Error(data && data.error ? String(data.error) : `HTTP ${res.status}`)
            const hidden = new Map()
            // seq -> the seq of the message that now stands in its place. A prompt
            // this plugin rewrote travels as a replacement carrier, so its revised
            // text has to be shown exactly where the old message was shown.
            const revisions = new Map()
            for (const item of Array.isArray(data.hidden) ? data.hidden : []) {
              if (!item || typeof item.seq !== 'number') continue
              hidden.set(item.seq, item.turn)
              if (typeof item.replacement === 'number') revisions.set(item.seq, item.replacement)
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
              revisions,
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
        // Pressing the pencil again for the SAME message re-focuses the open
        // box instead of starting over: resetting the draft to the original
        // text silently threw away whatever had been typed.
        const same = this.editor !== null && this.editor.seq === target.seq && this.editor.mode === target.mode
        const previous = this.editorElement
        this.load()
        this.editor = target
        if (!same) this.editorDraft = target.text
        this.confirming = false
        this.editorElement = null
        // The intent to keep the user's caret in this box. It is set when the
        // editor opens and cleared only when the user presses somewhere
        // outside it - never by a blur: the host rebuilding the row (or a
        // temporary disable while saving) removes or disables the node, and
        // treating that as "the user left" dropped the caret for good.
        this.editorFocus = true
        if (same && previous !== null && typeof previous.focus === 'function') {
          try {
            previous.focus()
          } catch {
            /* focus is best-effort */
          }
        }
        this.publish({ editing: target, draft: this.editorDraft, confirming: false, failure: null })
        this.probeSiblingRerun()
      }

      // The sibling is probed the way our own loader is probed: its state route
      // answers 400 without a sessionId when it is mounted, 404 when the route
      // does not exist. A change is published - the editor's marker carries it,
      // so the button appears (or never does).
      async probeSiblingRerun() {
        const token = (this.probeToken += 1)
        let status = 0
        try {
          const response = await fetch(`${RERUN_PREFIX}/state`, { headers: { accept: 'application/json' } })
          status = response.status
        } catch {
          // A sibling that is not mounted is not an error (I5): a rejected
          // fetch, a timeout and a 404 all land in 'absent', and none of them
          // logs anything.
          status = 0
        }
        // Two opens before the first answer arrived: the slower probe used to
        // land second and take the button back out. Only the newest speaks.
        if (token !== this.probeToken) return
        const next = status === 400 || status === 405 ? 'present' : 'absent'
        this.siblingRerun = next
        if (this.view.siblingRerun !== next) this.publish({ siblingRerun: next })
      }

      close() {
        if (this.view.pending) return
        this.pendingRerun = false
        this.editorElement = null
        this.editorBox = null
        this.editorRow = null
        this.editorFocus = false
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
        this.pendingRerun = false
        this.runReview()
      }

      /** The same save, plus the intent to re-run the turn afterwards. */
      reviewRerun() {
        this.pendingRerun = true
        this.runReview()
      }

      runReview() {
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
        const rerunIntent = this.pendingRerun
        this.pendingRerun = false
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
          const shadowed = Array.isArray(data.shadowed) ? data.shadowed : []
          const hidden = new Map(this.view.hidden)
          for (const seq of shadowed) hidden.set(seq, target.turn)
          // A rewritten prompt lands as the rollback's replacement carrier, so
          // its revised text has to be shown exactly where the old message was
          // shown - and it has to be shown right away, because the row is hidden
          // in this very pass. A rewritten reply is appended as its own new
          // reply instead, so it gets no standing-in entry here: that text
          // arrives with the refresh below, on a row of its own.
          const standsIn = typeof data.replacementSeq === 'number' && data.kind !== 'reply'
          const revisions = new Map(this.view.revisions)
          if (standsIn) for (const seq of shadowed) revisions.set(seq, data.replacementSeq)
          const editable = new Map(this.view.editable)
          for (const entry of editable.values()) {
            if (hidden.has(entry.seq)) editable.delete(entry.seq)
          }
          if (standsIn) {
            editable.set(data.replacementSeq, {
              seq: data.replacementSeq,
              turn: target.turn,
              messageId: typeof target.messageId === 'string' ? target.messageId : undefined,
              text,
              attachments: typeof target.attachments === 'number' ? target.attachments : 0,
            })
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
          this.editorBox = null
          this.editorRow = null
          this.editorFocus = false
          this.confirming = false
          this.publish({
            pending: false,
            editing: null,
            confirming: false,
            hidden,
            revisions,
            editable,
            replies,
            failure: null,
          })
          // The rollback has landed, so the editor is gone with its row: a
          // failed second half has to be reported somewhere that survives that.
          if (data.kind === 'reply' && data.applied === false) this.notify('reply')
          if (data.kind !== 'reply' && data.applied === false) this.notify('prompt')
          // Save first, re-run second - always: the sibling re-runs the turn
          // from the prompt the surface NOW shows, so the revised wording has
          // to be on the surface before it is asked to regenerate. Not
          // awaited: its own client takes the screen from here.
          if (rerunIntent) this.startSiblingRerun(target.turn)
          // The view above is complete enough to render, but the host is the
          // authority on what the session now looks like: only its answer knows
          // how many rows the platform decided to draw, and what the appended
          // correction or the re-run actually contains. Without this the client
          // kept the optimistic snapshot until something else happened to move
          // the row count, which for a rewritten message was never.
          await this.load(true)
        } catch {
          this.publish({ pending: false, failure: 'generic' })
        }
      }

      // Hand the re-run to the sibling: find the turn's reply through its own
      // state (the freshest view of what it can rerun) and ask it to start.
      async startSiblingRerun(turn) {
        try {
          const response = await fetch(
            `${RERUN_PREFIX}/state?sessionId=${encodeURIComponent(this.sessionId)}`,
            { headers: { accept: 'application/json' } },
          )
          const state = response.ok ? await response.json().catch(() => ({})) : {}
          const replies = Array.isArray(state.replies)
            ? state.replies.filter((entry) => entry && entry.turn === turn && typeof entry.seq === 'number')
            : []
          if (replies.length === 0) {
            this.notify('rerun-nothing')
            return
          }
          const head = replies.reduce((best, entry) => (entry.seq > best.seq ? entry : best))
          const started = await fetch(`${RERUN_PREFIX}/apply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: this.sessionId, seq: head.seq }),
          })
          const result = await started.json().catch(() => ({}))
          if (!started.ok || !result.ok) {
            this.notify(result && result.code ? String(result.code) : 'rerun-unavailable')
          }
        } catch {
          this.notify('rerun-unavailable')
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
        if (this.clearTimer !== null) window.clearTimeout(this.clearTimer)
        this.clearTimer = null
        clearEditor()
        this.listeners.clear()
        if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer)
        this.noticeTimer = null
        this.editorElement = null
        this.editorBox = null
        this.editorRow = null
        this.editorFocus = false
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

    // --- injected-node namespace ----------------------------------------------
    //
    // The host reloads this bundle in place: a new module instance with fresh
    // closures, a fresh WeakMap and a fresh editor layer, over the DOM the
    // previous instance left behind. Nothing in an instance can recognise its
    // predecessor's nodes by identity, so every node this half injects carries
    // its namespace in an attribute as well as in its class (contract I3): the
    // attribute is what a reload looks for (reuse it, never plant a second) and
    // what a real unload sweeps away. The class forms stay as fallbacks - a
    // bundle older than this one injected the same nodes with the class alone.
    const HOST_ATTR = 'dshetActionHost'
    const LAYER_ATTR = 'dshetLayer'
    const EDITOR_ATTR = 'dshetEditor'
    const HOST_SELECTOR = '[data-dshet-action-host="1"],.dshet-action-host'
    const LAYER_SELECTOR = '[data-dshet-layer="1"],.dshet-layer'
    // The live activation of an injected action, kept on the button element
    // itself: see `wireAction`.
    const ACTIVATE = 'dshetActivate'
    // Everything this half creates itself. The React-owned nodes are NOT in here
    // on purpose (the notice banner, the reply entry in the assistant-actions
    // strip): the host unmounts those through its own reconciler, and pulling a
    // node out from under React makes it throw on the way out.
    const OWN_NODE_SELECTOR = [
      HOST_SELECTOR,
      LAYER_SELECTOR,
      '[data-dshet-editor="1"],.dshet-editor',
      '[data-dshet-revision="1"],.dshet-revision',
    ].join(',')

    // The action hosts this module instance stands behind. A host carrying the
    // namespace that no pass of this instance claimed cannot be positioned or
    // updated by anyone: it is a leftover of an apply that is gone, and
    // `dropUnclaimedHosts` takes it out.
    const liveHosts = new WeakSet()

    /** Does this node still hang in a tree? A parentless host is one nobody can see. */
    function hasParent(node) {
      return node !== null && node !== undefined && node.parentElement !== null && node.parentElement !== undefined
    }

    /** Is this one of our action hosts - by namespace attribute, or by class? */
    function isActionHost(node) {
      if (node === null || node === undefined) return false
      const className = typeof node.className === 'string' ? node.className : ''
      if (/(^|\s)dshet-action-host(\s|$)/.test(className)) return true
      if (typeof node.matches === 'function') {
        try {
          return node.matches(HOST_SELECTOR) === true
        } catch {
          return false
        }
      }
      return false
    }

    /** Every action host of ours inside `scope`, the scope itself included. */
    function actionHostsIn(scope) {
      const out = []
      if (scope === null || scope === undefined) return out
      if (isActionHost(scope)) out.push(scope)
      if (typeof scope.querySelectorAll === 'function') {
        for (const node of scope.querySelectorAll(HOST_SELECTOR)) {
          if (!out.includes(node)) out.push(node)
        }
      }
      return out
    }

    /** The button inside an injected host, wherever a previous apply left it. */
    function actionButtonIn(host) {
      for (const child of host.children) {
        const className = typeof child.className === 'string' ? child.className : ''
        if (child.tagName === 'BUTTON' || /(^|\s)dshet-action(\s|$)/.test(className)) return child
      }
      return null
    }

    function createActionHost() {
      const host = document.createElement('span')
      host.className = 'dshet-action-host'
      host.dataset[HOST_ATTR] = '1'
      return host
    }

    function createActionButton() {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dshet-action dshet-row-action'
      button.innerHTML = ICON_MARKUP
      return button
    }

    /**
     * Wire the press/click pair onto an injected action.
     *
     * The action itself is NOT captured here: it is read off the button at press
     * time (`ACTIVATE`). A reloaded bundle reuses the very node the retired one
     * injected - that is what the namespace is for - and it wires that node
     * again, so the handler has to reach the controller that is mounted NOW.
     * A captured closure would open the retired controller, which does nothing
     * at all and reads exactly like a dead pencil.
     */
    function wireAction(button) {
      pressable(button, () => {
        const activate = button[ACTIVATE]
        if (typeof activate === 'function') activate()
      })
    }

    /** The pencil host a previous apply injected into this row, if there is one (I3). */
    function adoptActionHost(row) {
      const hosts = actionHostsIn(row)
      if (hosts.length === 0) return null
      // The first one wins: a second host in the same row is a ghost of an
      // earlier apply, and the sweep at the end of this pass removes it.
      const host = hosts[0]
      if (host.dataset !== undefined && host.dataset[HOST_ATTR] !== '1') host.dataset[HOST_ATTR] = '1'
      let button = actionButtonIn(host)
      if (button === null) {
        button = createActionButton()
        host.appendChild(button)
      }
      wireAction(button)
      return { host, button, target: null }
    }

    // Show a rewritten prompt where its original row is.
    //
    // The bubble is cloned from a real user bubble's classes at runtime - the
    // platform's class names are CSS-module hashes that change between builds, so
    // copying a live one keeps skins and themes working without hardcoding them.
    //
    // Returns whether the row may be hidden now. `false` means this is a user
    // message with a replacement recorded for it but no replacement text on
    // screen - a snapshot that has not caught up yet - and hiding it would leave
    // the transcript with nothing where the message was.
    function renderRevision(row, node, view, hidden, controller, t) {
      let revisionSeq = null
      for (const seq of seqsFor(node)) {
        if (view.revisions.has(seq)) {
          revisionSeq = seq
          break
        }
      }
      const existing = ownRevisionBubble(row)
      if (revisionSeq === null || !hidden) {
        if (existing !== null) existing.remove()
        return true
      }
      // Only one bubble per row, ever: drop any other bubble that claims it
      // (the host can shunt a bubble away from where it was planted, and the
      // next pass used to plant a second one next to the stray).
      {
        const key = row.getAttribute('data-chat-flow-key')
        if (typeof key === 'string' && key !== '') {
          for (const candidate of document.querySelectorAll('.dshet-revision')) {
            if (candidate !== existing && candidate.dataset !== undefined && candidate.dataset[REVISION_FOR] === key) {
              candidate.remove()
            }
          }
        }
      }
      const entry = view.editable.get(headRevision(view.revisions.get(revisionSeq), view.revisions))
      const text = entry && typeof entry.text === 'string' ? entry.text : ''
      if (text === '') {
        if (existing !== null) existing.remove()
        return node.kind !== 'user'
      }
      const bubble = existing === null ? cloneUserBubble(row) : existing
      {
        const key = row.getAttribute('data-chat-flow-key')
        if (typeof key === 'string' && key !== '' && bubble.dataset[REVISION_FOR] !== key) {
          bubble.dataset[REVISION_FOR] = key
        }
      }
      placeRevisionBubble(row, bubble)
      if (bubble.textContent !== text) bubble.textContent = text
      // The edit entry goes where every other action of this row lives: the
      // platform's own bar, which the collapse keeps standing, at its right end
      // behind the clock and the copy button - the row the user reads as "this
      // message", so that is where its actions belong. The bubble's gutter is
      // only the fallback for a row with no bar at all: that row is displayed
      // away entirely and the bubble stands before it, so there is nothing to
      // join. Injected after the text assignment so the host is not wiped.
      if (entry) {
        const editTarget = { ...entry, mode: 'prompt' }
        if (row.querySelector('[class*="_actions"]') !== null) {
          injectRowAction(row, editTarget, controller, t)
          removeRowAction(bubble)
          bubble.classList.remove('dshet-revision-action')
        } else {
          injectRowAction(bubble, editTarget, controller, t, { gutter: true })
          removeRowAction(row)
          bubble.classList.add('dshet-revision-action')
        }
      } else {
        removeRowAction(bubble)
        bubble.classList.remove('dshet-revision-action')
      }
      return true
    }

    // A copy of a live user bubble element, classes and all.
    // The key of the row a bubble stands in for. It is what makes a stray
    // bubble recognisable after the host's DOM has shifted around it: an
    // unlabelled bubble that is no longer the row's direct child or its
    // immediate previous sibling used to be forgotten, and the next pass
    // planted a second one - two identical bubbles on screen.
    const REVISION_FOR = 'dshetRevisionFor'
    function cloneUserBubble(row) {
      const bubble = document.createElement('div')
      bubble.className = 'dshet-revision'
      // Namespace attribute as well as the class: a reloaded bundle finds this
      // bubble by attribute (it has no memory of the node), and an unload sweeps
      // it by the same selector.
      bubble.dataset.dshetRevision = '1'
      if (row !== null && row !== undefined) {
        const key = row.getAttribute('data-chat-flow-key')
        if (typeof key === 'string' && key !== '') bubble.dataset[REVISION_FOR] = key
      }
      return bubble
    }

    // The standing-in bubble this row was given, wherever the last pass put it.
    //
    // It lives inside the row - the platform's own message, not a sibling of it -
    // but a row that could not keep its action bar is displayed away entirely and
    // takes its children with it, so the bubble is then parked before the row.
    // Both positions have to be recognised or every pass would plant a second one.
    function ownRevisionBubble(row) {
      for (const child of row.children) {
        if (child.classList && child.classList.contains('dshet-revision')) return child
      }
      const previous = row.previousElementSibling
      if (previous !== null && previous.classList && previous.classList.contains('dshet-revision')) {
        return previous
      }
      // Anywhere else the host may have shunted it: the bubble carries the row
      // key, so it is found again instead of duplicated. Filtered in place
      // rather than with an attribute selector, which keeps the stubs honest.
      const key = row.getAttribute('data-chat-flow-key')
      if (typeof key === 'string' && key !== '') {
        for (const bubble of document.querySelectorAll('.dshet-revision')) {
          if (bubble.dataset !== undefined && bubble.dataset[REVISION_FOR] === key) return bubble
        }
      }
      return null
    }

    // The message a chain of rewrites ends at.
    //
    // Rewriting the same message twice lands two replacements: 8 -> 19 for the
    // first, 19 -> 23 for the second. The transcript row still stands for 8, so
    // resolving a single hop lands on 19 - a shadowed seq with no entry left -
    // and the bubble and its pencil silently disappeared after the second save.
    // The chain has to be followed to the head (23).
    function headRevision(seq, revisions) {
      let current = seq
      const seen = new Set([seq])
      for (let hop = 0; hop < 64; hop += 1) {
        const next = revisions.get(current)
        if (typeof next !== 'number' || seen.has(next)) return current
        current = next
        seen.add(current)
      }
      return current
    }

    // Plant the bubble where the message it replaces used to be: inside the row,
    // ahead of the node that carries the action bar, so the rewritten prompt reads
    // above the timestamp and the copy button - the order the platform draws a
    // message and its bar in. Planting it after the row put the bar on top of the
    // text, as if the time and the copy belonged to whatever came next.
    //
    // Idempotent, and only ever moves the node when the position is wrong: this
    // runs on every DOM pass, and rewriting the tree the observer watches would
    // never settle.
    function placeRevisionBubble(row, bubble) {
      const strip = row.querySelector('[class*="_actions"]')
      let holder = strip
      while (strip !== null && holder !== null && holder.parentElement !== row) {
        holder = holder.parentElement
      }
      const inside = strip !== null && holder !== null && holder.parentElement === row
      if (!inside && row.parentElement === null) return
      const parent = inside ? row : row.parentElement
      const before = inside ? holder : row
      if (bubble.parentElement !== parent || bubble.nextElementSibling !== before) {
        parent.insertBefore(bubble, before)
      }
    }

    // Collapse a row's message while leaving its action strip standing.
    //
    // The platform's own time / copy / delete bar - and every other plugin's
    // buttons - live in the same row as the prompt this plugin rolls back.
    // Displaying the row away took them with it, so a rewritten prompt left the
    // user no way to copy, read or delete the original. The row therefore stays:
    // everything that leads to the strip collapses, the strip does not, and the
    // marker attribute tells the stylesheet that the row itself must survive.
    //
    // Structure-agnostic on purpose - the platform's row classes are CSS-module
    // hashes that change between builds, so the walk starts from the strip (whose
    // `_actions` suffix is stable) and hides that strip's ancestors' other
    // children up to the row. Returns false when there is no strip to keep, and
    // false is what tells the caller to hide the whole row instead.
    function collapseRowContent(row, hide) {
      const strip = row.querySelector('[class*="_actions"]')
      if (strip === null) return false
      let node = strip
      while (node !== null && node !== row) {
        const parent = node.parentElement
        if (parent === null) return false
        for (const child of parent.children) {
          if (child === node) continue
          // This plugin's own furniture lives beside the message too: the
          // in-place editor, a floating pencil and the bubble standing in for
          // the rewritten prompt are not message content. The bubble is what
          // the transcript has left of the message once this walk is done -
          // hiding it here would take the text away a second time.
          if (
            child.classList &&
            (child.classList.contains('dshet-editor') ||
              child.classList.contains('dshet-action-host') ||
              child.classList.contains('dshet-revision'))
          ) {
            continue
          }
          if (hide) {
            // Written only when the value changes: this runs on every DOM pass,
            // and an attribute write the observer can see would never settle.
            // The marker is written only for a `none` this plugin wrote (I4):
            // a child another plugin had already displayed away is left
            // untouched, so the restore pass cannot take that hiding back out.
            if (child.style.display !== 'none') {
              child.style.display = 'none'
              if (child.dataset.dshetCollapsed !== '1') child.dataset.dshetCollapsed = '1'
            }
          } else if (child.dataset.dshetCollapsed === '1') {
            child.style.display = ''
            delete child.dataset.dshetCollapsed
          }
        }
        node = parent
      }
      return true
    }

    // Attribution for the hiding below (contract §4). Another plugin writes its
    // own marker on a row it displayed away (delete-turn 'dshdt', rerun-turn
    // 'dsrr'); this half resets `display` for its OWN hide only, and a row
    // another plugin is keeping away stays away.
    const HIDE_OWNERS = [
      ['dshdt', 'data-dshdt-hidden', 'dshdtHidden'],
      ['dshet', 'data-dshet-hidden', 'dshetHidden'],
      ['dsrr', 'data-dsrr-hidden', 'dsrrHidden'],
    ]
    /** Is anyone but `own` claiming a hide on this row? */
    function foreignHideOn(row, own) {
      for (const [key, attr, prop] of HIDE_OWNERS) {
        if (key === own) continue
        if (row.dataset?.[prop] === '1') return true
        if (typeof row.hasAttribute === 'function' && row.hasAttribute(attr)) return true
      }
      return false
    }

    function setRowHidden(row, hide, animate) {
      // A turn tail is not a message row. It is the strip a turn's end renders
      // (duration, usage, actions); when the turn behind it is rolled back the
      // strip is an orphan with nothing left to act on. Keeping it, which is
      // right for a message row, stacked one empty strip per edit and pushed
      // the conversation down the page - the report was "every save moves the
      // model's answer further down".
      const isTail = row.getAttribute('data-chat-flow-kind') === 'turn-tail'
      if (hide) {
        const keepsStrip = isTail ? false : collapseRowContent(row, true)
        if (keepsStrip) {
          if (row.dataset.dshetKeepActions !== '1') row.dataset.dshetKeepActions = '1'
        } else if (row.dataset.dshetKeepActions === '1') {
          // Older passes marked this tail as keep-actions; with the rule fixed
          // the attribute has to go, or the row stays visible through it.
          delete row.dataset.dshetKeepActions
        }
        if (row.dataset.dshetHidden === '1') {
          if (keepsStrip || row.style.display === 'none') return
        }
        row.dataset.dshetHidden = '1'
        if (keepsStrip) return
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
      collapseRowContent(row, false)
      if (row.dataset.dshetHidden !== '1') return
      delete row.dataset.dshetHidden
      if (row.dataset.dshetKeepActions === '1') delete row.dataset.dshetKeepActions
      row.classList.remove('dshet-collapsing')
      // I4: dropping our marker ends OUR hide. `display` is only ours to clear
      // while no other plugin's hide marker stands - a row a sibling displayed
      // away stays away, whatever this half would prefer.
      row.style.display = foreignHideOn(row, 'dshet') ? 'none' : ''
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
      liveHosts.delete(entry.host)
      entry.host.remove()
      rowActions.delete(row)
    }

    function injectRowAction(row, target, controller, t, options = {}) {
      const label = t(target.mode === 'reply' ? 'action.edit-reply' : 'action.edit')
      let entry = rowActions.get(row)
      // An entry whose host lost its parent is not an entry any more: another
      // apply swept the node away (or the host took it out with the container it
      // was in), and a pass that only repositions it would leave this row with
      // no pencil at all.
      if (entry !== undefined && !hasParent(entry.host)) {
        rowActions.delete(row)
        entry = undefined
      }
      // I3: a host a previous apply injected into this row is REUSED, never
      // doubled. The WeakMap cannot find it - a reloaded bundle starts with an
      // empty one - so the namespace attribute is what does.
      if (entry === undefined) {
        const adopted = adoptActionHost(row)
        if (adopted !== null) entry = adopted
      }
      if (entry === undefined) {
        const host = createActionHost()
        const button = createActionButton()
        // The marker goes on the BUTTON, not only on its wrapper: the pass that
        // looks for the official strip's entry queries buttons, so a marker one
        // level up made this pencil look like the strip's own and it deleted
        // itself - then the next pass put it back, which reads as flicker.
        host.appendChild(button)
        entry = { host, button, target }
        // The action reads the CURRENT target off the entry and the CURRENT
        // controller off the button, so re-wiring on a later apply is harmless
        // and a reloaded bundle can take this very node over.
        wireAction(button)
        rowActions.set(row, entry)
      }
      entry.target = target
      const { host, button } = entry
      // The fallback marker mirrors the placement chosen below: a host adopted
      // from a gutter placement must not keep claiming one it no longer has.
      if (options.fallback === true) {
        if (button.dataset.dshetFallback !== '1') button.dataset.dshetFallback = '1'
      } else if (button.dataset !== undefined && button.dataset.dshetFallback !== undefined) {
        delete button.dataset.dshetFallback
      }
      button[ACTIVATE] = () => controller.open(entry.target)
      liveHosts.add(host)
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label)
        button.setAttribute('title', label)
      }
      // A caller that already picked the right bar (the turn tail's own strip)
      // hands it over; otherwise the first actions container in the row wins.
      const anchor =
        options.gutter === true ? null : options.anchor ?? row.querySelector('[class*="_actions"]')
      if (anchor) {
        host.classList.remove('dshet-floating')
        row.classList.remove('dshet-row')
        // The clock and the usage pill trail the actions in that strip, so a
        // plain append parks an action behind the row's trailing info. Sit after
        // the LAST platform action icon instead - that is where the host seats
        // its own extra actions, and where the user row keeps its pencil.
        const lastAction = lastPlatformAction(anchor)
        // On the second pass this pencil is already `lastAction.nextSibling`, and
        // inserting a node before itself is not a no-op in every engine - skip
        // past ourselves so the position stays put instead of drifting to the end.
        let next = lastAction === null ? null : lastAction.nextSibling
        if (next === host) next = next.nextSibling
        if (host.parentElement !== anchor || host.nextSibling !== next) anchor.insertBefore(host, next)
      } else if (options.gutter === true) {
        // The revision bubble is ours, not the platform's: it has no action bar
        // to join, so the pencil goes into the bubble's own reserved gutter
        // (`.dshet-revision-action`). Never `.dshet-floating` - that rule is
        // positioned against the row, which put the button on top of the text.
        host.classList.remove('dshet-floating')
        row.classList.remove('dshet-row')
        if (host.parentElement !== row) row.appendChild(host)
      } else {
        host.classList.add('dshet-floating')
        row.classList.add('dshet-row')
        if (host.parentElement !== row) row.appendChild(host)
      }
    }

    /**
     * One pencil per row, however often the bundle is applied over the same DOM.
     *
     * Every pass registers the host it stands behind in `liveHosts`. A host that
     * carries this plugin's namespace and was claimed by NO pass of this
     * instance cannot be positioned or updated by anyone: it is the leftover of
     * an apply that is gone (a reload, a plugin toggle, a bundle-group swap),
     * and left alone the bar collects one more of them per apply - the observed
     * report was seven action hosts and seventeen children in a single strip,
     * which the user reads as three re-run buttons on one row. Only nodes
     * carrying this plugin's own namespace are ever considered (I3).
     *
     * The DOM pass runs on every snapshot, so a ghost is taken out on the first
     * pass after the reload that produced it.
     */
    function dropUnclaimedHosts() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      let hosts = []
      try {
        hosts = document.querySelectorAll(HOST_SELECTOR)
      } catch {
        return
      }
      for (const host of hosts) {
        if (liveHosts.has(host)) continue
        try {
          host.remove()
        } catch {}
      }
    }

    // The platform's own action icons all carry a hashed class ending in
    // `_action`; the clock, the usage pill and anything this plugin adds do not
    // (ours are hyphenated). Matching that suffix avoids CSS-module hashes
    // entirely - they change between builds.
    function lastPlatformAction(bar) {
      const children = Array.from(bar.children)
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index]
        const className = typeof child.className === 'string' ? child.className : ''
        if (/_action\b/.test(className)) return child
      }
      return null
    }

    function clearEditor() {
      const elements = document.querySelectorAll('.dshet-editor')
      for (const element of elements) element.remove()
      // An empty layer has no business staying on the page: the editor is
      // hosted on the body, where nothing else clears up after it.
      if (editorLayer !== null && editorLayer.isConnected === true && editorLayer.children.length === 0) {
        editorLayer.remove()
        editorLayer = null
      }
    }

    // The layer the editor is hosted on. It is created once, hangs off the
    // body - where the host's React tree cannot reach it - and survives every
    // rebuild of the conversation.
    let editorLayer = null
    function ensureEditorLayer() {
      if (editorLayer !== null && editorLayer.isConnected === true) return editorLayer
      // A reloaded bundle starts with no layer of its own; the one the previous
      // instance left is the same node doing the same job, so it is adopted
      // rather than doubled (I3). The instance that left it takes it out with
      // its own sweep when it is disposed.
      const existing = ownLayer()
      if (existing !== null && existing.isConnected !== false) {
        editorLayer = existing
        return editorLayer
      }
      editorLayer = document.createElement('div')
      editorLayer.className = 'dshet-layer'
      editorLayer.dataset[LAYER_ATTR] = '1'
      document.body.appendChild(editorLayer)
      return editorLayer
    }

    /** The editor layer a previous apply left on the page, if there is one. */
    function ownLayer() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
      try {
        return document.querySelector(LAYER_SELECTOR)
      } catch {
        return null
      }
    }

    // Put the box under the row it belongs to: same width, just below its lower
    // edge. Called on render and whenever the page scrolls or resizes, since
    // the layer is fixed to the viewport.
    function placeEditor(row, box) {
      const layer = ensureEditorLayer()
      if (box.parentElement !== layer) layer.appendChild(box)
      const rect = row.getBoundingClientRect()
      box.style.left = `${Math.round(rect.left)}px`
      box.style.top = `${Math.round(rect.bottom + 6)}px`
      box.style.width = `${Math.round(rect.width)}px`
    }

    // Grow the textarea to its content, the way a normal input box behaves.
    // Without this it sits at a fixed `rows` height and a two-line edit floats
    // in half an empty box. The stylesheet owns the limits (`min-height`,
    // `max-height`); the element only ever gets the measured height, and the
    // `+2` is the top and bottom border `scrollHeight` does not count.
    function fitEditorHeight(area) {
      area.style.height = 'auto'
      const height = area.scrollHeight
      if (typeof height === 'number' && height > 0) area.style.height = `${height + 2}px`
    }

    // Wire an action so a host re-render cannot eat the click.
    //
    // The host owns the row and rebuilds it freely - while a turn streams it
    // re-renders constantly - so an injected button can be replaced between
    // mousedown and mouseup, and a click only fires when both land on the same
    // node. That is what "the button does nothing" looks like from outside, and
    // it is unguessable from the state. The action therefore rides on
    // pointerdown; the click path stays for the keyboard, de-duplicated so one
    // press cannot run the action twice.
    function pressable(button, action) {
      let pressed = false
      button.onpointerdown = (event) => {
        if (typeof event.button === 'number' && event.button !== 0) return
        pressed = true
        event.preventDefault()
        event.stopPropagation()
        action()
      }
      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (pressed) {
          pressed = false
          return
        }
        action()
      }
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
        // The re-run button appears when the sibling probe lands; without it in
        // the marker the editor would never be rebuilt to show the button.
        view.siblingRerun === 'present' ? 'r' : 'n',
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
        warn: t(reply ? 'editor.warn-reply' : 'editor.warn.attachments'),
        // Saving writes the revision into the context; only the opt-in config asks
        // the model again, and the button says which one will happen.
        save: t(reply ? 'editor.save-reply' : 'editor.save'),
      }
    }

    function renderEditor(row, controller, view, t) {
      const target = view.editing
      const texts = editorTexts(t, target)
      const marker = editorMarker(target, view)
      const existing = controller.editorBox !== null && controller.editorBox.isConnected === true
        ? controller.editorBox
        : null
      if (existing && existing.dataset.dshetFor === marker) {
        placeEditor(row, existing)
        return
      }

      // Focus policy. The host re-renders this row freely, so the box gets
      // rebuilt; taking focus at that moment is what pulled the caret out of
      // the composer (or whatever else the user was typing in). Focus is only
      // taken when the editor was just opened, or handed back to the rebuild
      // when the user was typing in the box that was just replaced - with the
      // caret where it was.
      const previous = controller.editorElement
      const fresh = previous === null
      const wasFocused = !fresh && (controller.editorFocus === true || document.activeElement === previous)
      const caret = wasFocused && typeof previous.selectionStart === 'number'
        ? [previous.selectionStart, previous.selectionEnd]
        : null

      clearEditor()
      const box = document.createElement('div')
      box.className = 'dshet-editor'
      box.dataset[EDITOR_ATTR] = '1'
      box.dataset.dshetFor = marker

      const area = document.createElement('textarea')
      area.rows = 1
      area.value = controller.editorDraft
      area.disabled = view.pending || view.confirming
      area.spellcheck = false
      area.setAttribute('aria-label', texts.title)
      if (!view.confirming) area.placeholder = texts.placeholder
      area.addEventListener('input', (event) => {
        controller.setDraft(area.value)
        // Never relayout mid-composition: the IME owns the field until it
        // commits, and moving it under the candidate window is how a box
        // "eats" pinyin.
        if (event.isComposing === true) return
        fitEditorHeight(area)
      })
      area.addEventListener('compositionend', () => fitEditorHeight(area))
      area.addEventListener('focus', () => {
        controller.editorFocus = true
      })
      // The keyboard of every input box in this app: Enter acts (the composer
      // sends), Shift+Enter breaks the line, Escape leaves (one step back when
      // the confirmation step is showing). The guard is the platform's own
      // (`isComposing` OR keyCode 229): the Enter that commits a 拼音/かな
      // candidate can arrive with `isComposing === false` and keyCode 229 - and
      // missing that half is what saved the box on every candidate pick.
      area.addEventListener('keydown', (event) => {
        if (event.isComposing === true || event.keyCode === 229) return
        if (event.key === 'Enter' && event.shiftKey !== true) {
          event.preventDefault()
          if (view.confirming) controller.confirm()
          else controller.review()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (view.confirming) controller.back()
          else controller.close()
        }
      })
      box.appendChild(area)

      // Only what the user has to know right now: what the replacement will
      // discard, and what went wrong. The running explanation lives in the
      // README and in the buttons' tooltips, the way a normal input box does it.
      if (view.confirming) {
        const note = document.createElement('p')
        note.className = 'dshet-note'
        note.textContent = t('confirm.body')
        box.appendChild(note)
      }
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
      cancel.title = `${t('editor.cancel')} (Esc)`
      cancel.disabled = view.pending
      pressable(cancel, () => {
        if (view.confirming) controller.back()
        else controller.close()
      })

      const submit = document.createElement('button')
      submit.type = 'button'
      submit.className = 'dshet-btn dshet-btn-primary'
      submit.textContent = view.pending
        ? t('editor.pending')
        : view.confirming
          ? t('editor.review')
          : texts.save
      submit.title = `${submit.textContent} (Enter)`
      submit.disabled = view.pending
      pressable(submit, () => {
        if (view.confirming) controller.confirm()
        else controller.review()
      })

      footer.appendChild(cancel)
      // The re-run button belongs to the sibling (dsh-rerun-turn): it appears
      // only when that plugin is mounted, only for a prompt edit, and only
      // outside the confirmation step - the intent is carried through it. Save
      // first, re-run second, always. A reply edit has no re-run here: the
      // action strip of the reply carries the sibling's own button.
      if (target.mode === 'prompt' && view.siblingRerun === 'present' && view.confirming !== true) {
        const rerun = document.createElement('button')
        rerun.type = 'button'
        rerun.className = 'dshet-btn dshet-rerun'
        rerun.textContent = t('editor.rerun')
        rerun.disabled = view.pending
        pressable(rerun, () => controller.reviewRerun())
        footer.appendChild(rerun)
      }
      footer.appendChild(submit)
      box.appendChild(footer)

      placeEditor(row, box)
      controller.editorBox = box
      controller.editorRow = row
      controller.editorElement = area
      fitEditorHeight(area)
      if (!view.confirming && !view.pending && (fresh || wasFocused)) {
        try {
          area.focus()
          const end = typeof area.value.length === 'number' ? area.value.length : 0
          const [start, stop] = caret === null ? [end, end] : caret
          area.setSelectionRange(Math.min(start, end), Math.min(stop, end))
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
        // A prompt this plugin rewrote in place is not a discard: the platform keeps
        // the old row (it keeps transcript rows for messages that left the surface),
        // and the revision belongs exactly there - not at the tail the carrier's
        // sequence number would sort to. Our own bubble stands in for it.
        // Never let a rendering nicety take the whole browser half down: without
        // this plugin there are no edit entries at all. What it must not do is
        // take the message down with it either - a failed draw leaves the row
        // up, so the worst case is the old text showing for another refresh.
        let canHide = true
        try {
          canHide = renderRevision(row, node, view, hidden, controller, t)
        } catch {
          canHide = node.kind !== 'user'
        }
        const visible = hidden && canHide
        setRowHidden(row, visible, animate)
        // A collapsed row's entry is placed by `renderRevision`: the rewritten
        // prompt stands in for the message and the pencil goes into the bar that
        // survives alongside it. Tearing that down here would take back out what
        // that call has only just put there - so the row keeps its entry only
        // while something of ours is standing in for it. A row that collapsed
        // with no replacement on screen (a rollback this plugin knows nothing
        // about) is not editable any more and loses the pencil it had.
        if (visible) {
          if (ownRevisionBubble(row) === null) removeRowAction(row)
        } else {
          const target = targetFor(node, view)
          if (target !== null) injectRowAction(row, target, controller, t)
          else removeRowAction(row)
        }
        // The editor anchors to whichever row covers the seq being edited, not to
        // the row that owns the entry: a reply's entry now lives in the turn-tail
        // action strip, while its editor still belongs under the reply text.
        //
        // A rewritten prompt is covered by no row at all: the revision is a
        // replacement event and the platform draws no row for those, so its seq
        // appears in no node. The row that STANDS for it - the collapsed one
        // whose pencil was just pressed - covers it through its revision
        // mapping, and the editor is hosted on the layer anyway, so rendering it
        // under a collapsed row costs nothing and works.
        const editing = view.editing
        const coversEditing = editing !== null && typeof editing.seq === 'number' &&
          (seqsFor(node).includes(editing.seq) ||
            seqsFor(node).some((seq) => headRevision(seq, view.revisions) === editing.seq))
        if (coversEditing && (!hidden || row.style.display !== 'none')) {
          renderEditor(row, controller, view, t)
        }
      }
      if (view.editing === null) {
        clearEditor()
        controller.editorBox = null
        controller.editorRow = null
      }
      // Whatever of ours no row of this pass claimed is a ghost of an earlier
      // apply: the host rebuilt the row under it, or the bundle was reloaded
      // over it. Contract §5 - a button nobody can update must not pile up.
      dropUnclaimedHosts()
    }

    // A snapshot this entry can read, or null when the controller cannot be
    // trusted to have one.
    //
    // The slot runtime abdicates an entry that throws during render - permanently
    // for the life of the page: the cell renders an empty placeholder and this
    // pencil never comes back, with no error surfaced to the user. One missing
    // prop therefore has to cost this button alone, so every read below is
    // guarded and nothing here can throw.
    function readReplyView(controller) {
      if (controller === null || controller === undefined || typeof controller.getSnapshot !== 'function') return null
      const view = controller.getSnapshot()
      if (view === null || typeof view !== 'object') return null
      if (!view.repliesByMessage || typeof view.repliesByMessage.get !== 'function') return null
      if (!view.hidden || typeof view.hidden.has !== 'function') return null
      return view
    }

    // The reply edit entry, registered in the host's own assistant-actions strip.
    //
    // It has to live there rather than be injected next to the message: the host
    // renders that strip per assistant message, hands the entry the messageId, and
    // keeps the platform's own reveal behaviour (always for the latest turn, hover
    // for older ones). Injecting instead put the pencil in a different place from
    // where every other action for that row lives, which is what users noticed.
    function ReplyActionEntry(input) {
      const props = input !== null && typeof input === 'object' ? input : {}
      const messageId = props.messageId
      const controller = props.controller
      const t = typeof props.t === 'function' ? props.t : null
      const [view, setView] = react.useState(() => {
        try {
          return readReplyView(controller)
        } catch {
          return null
        }
      })
      react.useEffect(() => {
        let unsubscribe = null
        try {
          setView(readReplyView(controller))
          if (controller !== null && controller !== undefined && typeof controller.subscribe === 'function') {
            unsubscribe = controller.subscribe(() => setView(readReplyView(controller)))
          }
        } catch {
          setView(null)
        }
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [controller])
      const entry = view === null ? undefined : view.repliesByMessage.get(messageId)
      if (entry === undefined || entry === null || view.hidden.has(entry.seq)) return null
      const label = t === null ? '' : t('action.edit-reply')
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
      // The config object is always an object: this runtime's `jsx` reads
      // `config.key` without a null check, so `jsx(PencilIcon, null)` threw and
      // the boundary retired the entry for the whole page.
      return jsx('button', {
        type: 'button',
        className: 'dshet-action dshet-row-action dshet-reply-action',
        'aria-label': label,
        title: label,
        onClick: open,
        children: jsx(PencilIcon, {}),
      })
    }

    // --- react entries --------------------------------------------------------

    function OverlayEntry({ useChat, useEditTurn, controller, t }) {
      const snapshot = typeof useChat === 'function' ? useChat((state) => state) : undefined
      const view = useEditTurn((state) => state)

      react.useEffect(() => {
        controller.load()
      }, [controller])

      // Pressing outside the editor is the one signal that means "the user
      // left". Blur cannot be that signal: a host re-render replaces the node
      // (blur without a related target) and a save temporarily disables it -
      // both used to drop the caret for good.
      react.useEffect(() => {
        if (typeof document.addEventListener !== 'function' || typeof document.removeEventListener !== 'function') {
          return undefined
        }
        const onPointerDown = (event) => {
          const target = event.target
          const inside = target !== null && target !== undefined && typeof target.closest === 'function'
            && target.closest('.dshet-editor') !== null
          if (!inside) controller.editorFocus = false
        }
        const keepPlaced = () => {
          const row = controller.editorRow
          const box = controller.editorBox
          if (row !== null && box !== null && box.isConnected === true) placeEditor(row, box)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        // Scroll events do not bubble; capture reaches the inner scroller too.
        document.addEventListener('scroll', keepPlaced, { capture: true, passive: true })
        window.addEventListener('resize', keepPlaced)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('scroll', keepPlaced, true)
          window.removeEventListener('resize', keepPlaced)
        }
      }, [controller])

      react.useEffect(() => {
        if (snapshot === undefined) return undefined
        let scheduled = false
        const run = () => {
          scheduled = false
          // Always the CURRENT view: this callback can outlive the render that
          // created it, and a pass carrying an older view un-hid a collapsed
          // row - the original bubble reappeared beside the revision bubble.
          const live = typeof controller.getSnapshot === 'function' ? controller.getSnapshot() : view
          applyDom(snapshot, live, controller, t)
        }
        run()
        const observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
          else window.setTimeout(run, 16)
        })
        observer.observe(document.body, { childList: true, subtree: true })
        // This effect re-runs whenever the view changes, and its cleanup runs
        // first every time; only a REAL unmount means the conversation view
        // went away (switching to Settings, say) and the editor has to go with
        // it - left behind, it floated over whatever came next. So the clear is
        // deferred, and the next run of this effect cancels it.
        if (controller.clearTimer !== null) {
          window.clearTimeout(controller.clearTimer)
          controller.clearTimer = null
        }
        return () => {
          observer.disconnect()
          if (controller.clearTimer !== null) window.clearTimeout(controller.clearTimer)
          controller.clearTimer = window.setTimeout(() => {
            controller.clearTimer = null
            clearEditor()
            controller.editorBox = null
            controller.editorRow = null
            controller.editorElement = null
          }, 250)
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

    // --- unload -----------------------------------------------------------------

    /**
     * Take back everything this half put on the page.
     *
     * Runs when the plugin is disposed - a reload, a toggle, a bundle-group swap
     * - and it works by NAMESPACE, never by identity: the WeakMap and the layer
     * reference die with the module instance, the attributes on the nodes do
     * not, and the instance that replaces this one starts with no memory of them
     * at all. That is exactly why a reload used to leave a second pencil (and a
     * third, and a fourth) in the same bar.
     *
     * Only nodes this plugin created are removed, and only state this plugin
     * wrote is taken back (I3, I4): a row another plugin is keeping away stays
     * away, and the host's own buttons never move.
     */
    function releaseInjectedNodes() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      const each = (selector, act) => {
        let nodes = []
        try {
          nodes = document.querySelectorAll(selector)
        } catch {
          return
        }
        for (const node of nodes) {
          try {
            act(node)
          } catch {}
        }
      }
      // 1. The platform's own rows go back to how this half found them. These
      //    markers are this plugin's own writes, so this is its own state - and
      //    only its own: the restore path asks the attribution guard first (I4).
      each('[data-dshet-hidden="1"]', (row) => setRowHidden(row, false))
      each('[data-dshet-collapsed="1"]', (child) => {
        child.style.display = ''
        delete child.dataset.dshetCollapsed
      })
      // A row caught mid-collapse keeps the inline height and opacity this half
      // wrote, and nothing after this would ever clear them.
      each('.dshet-collapsing', (row) => {
        row.classList.remove('dshet-collapsing')
        row.style.height = ''
        row.style.opacity = ''
        row.style.marginTop = ''
        row.style.marginBottom = ''
        row.style.paddingTop = ''
        row.style.paddingBottom = ''
      })
      // 2. Every node this half created goes with it: the injected pencils, the
      //    bubbles standing in for rewritten prompts, the editor and the layer
      //    it is hosted on. React's own nodes are deliberately not in the
      //    selector - the host unmounts those, and pulling one out from under
      //    React makes it throw on the way out.
      each(OWN_NODE_SELECTOR, (node) => node.remove())
      editorLayer = null
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
          // The DOM this half injected is not owned by the controllers: it
          // outlives them, and the next apply has no way to find it except by
          // namespace. An unload that does not take it out is what left one more
          // pencil in the bar on every reload (I3, contract §5).
          releaseInjectedNodes()
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
