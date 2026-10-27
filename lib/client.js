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
    // DOM injection has to land before the browser paints, or the host's own
    // buttons are visible for a frame and ours pop in after them.
    const useBrowserLayoutEffect = typeof react.useLayoutEffect === 'function' ? react.useLayoutEffect : react.useEffect
    const jsxRuntime = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { jsx, jsxs, Fragment } = jsxRuntime

    const NS = 'dsh-edit-turn'
    const ROUTE_PREFIX = '/dsh-edit-turn'
    // One picked file may not exceed this. It mirrors the platform's own default
    // per-image ceiling (dsh-attachment-local's 20 MiB), because a payload above
    // it would be refused by the store anyway - saying so in the picker is
    // kinder than a round trip that fails.
    /**
     * Display index base for inserted blocks.
     *
     * Recorded content indices are far below this; lib/patch.js owns the same
     * number (INSERT_INDEX_BASE) and the two must agree, because this half reads
     * the server's block list verbatim.
     */
    const INSERT_INDEX_BASE = 1000000
    const MAX_ATTACH_BYTES = 20 * 1024 * 1024
    // Above this a chip keeps its label instead of trying to draw itself: a
    // thumbnail is not worth decoding a 30 MB attachment for.
    const MAX_THUMB_BYTES = 8 * 1024 * 1024
    // The sibling that owns re-running: it shadows a turn and regenerates it
    // from the prompt the surface now shows, then replays what followed. The
    // editor's re-run button is only offered when it is mounted.
    const RERUN_PREFIX = '/dsh-rerun-turn'

    /** Keep in sync with package.json and lib/index.js. */
    const PLUGIN_VERSION = '0.5.4'

    // --- copy -----------------------------------------------------------------

    const zh = {
      'action.edit': '编辑这条消息',
      'action.edit-reply': '编辑这条回答',
      // The platform's own words for its copy action, spelled here because the
      // row's copy button is recognised BY them (see `nativeCopyButton`): the host
      // labels that button through the shared `common` dictionary, and this is the
      // same wording. Namespace keys shadow the shared ones, so these two keep the
      // bundle's own key surface complete; the structural rule does not need them.
      'copy': '复制',
      'copied': '复制成功',
      'action.copied': '复制成功',
      'action.copy': '复制这条回答',
      'action.tail-actions': '这一轮的动作',
      'added.block': '插件新增的块（模型能看到，对话里也画出来）',
      'editor.add-text': '加一个正文块',
      'editor.add-reasoning': '加一个思维链块',
      'editor.add-short': '+正文',
      'editor.add-reasoning-short': '+思维链',
      'editor.title': '编辑这条消息',
      'editor.title-reply': '编辑这条回答',
      'editor.placeholder': '改成你希望自己当时说的内容。保存后就地替换这条消息，后面的对话保持不变。',
      'editor.placeholder-reply': '改成你希望模型说过的内容，保存后它就成为这条回答。',
      'editor.save': '保存',
      'editor.rerun': '重跑',
      'editor.save-reply': '保存',
      'editor.block': '编辑哪一块',
      'editor.block.all': '全部',
      'config.style': '编辑器样式',
      'config.placement': '编辑器位置',
      'config.height': '编辑器高度',
      'height.max': '一轮最大',
      'height.content': '随内容',
      'height.fill': '全部铺满',
      'config.summary.height.max': '一轮最大',
      'config.summary.height.content': '随内容',
      'config.summary.height.fill': '全部铺满',
      'config.hint.height.max': '打开时取这一轮所有思维链/正文里的最大高度；编辑中随你打字长高、删字变矮，但不会比打开时更矮。',
      'config.hint.height.content': '打开时框高跟着当前块走；编辑中随你打字长高、删字变矮，但不会比打开时更矮。',
      'config.hint.height.fill': '普通块打开时按一轮最大，编辑中随打字长高、删字变矮（不会比打开时更矮）；选「全部」时铺满对话区到输入框之间的整段高度，只有一个滚动条。',
      'placement.overlay': '浮层',
      'placement.inline': '页面内联',
      'placement.legacy': '整行旧版',
      'config.summary.legacy': '整行旧版',
      'config.hint.legacy': '整条 assistant 行套框、正文保持旧的内部滚动；同样向下盖住 action bar，功能键在左下。',
      'config.summary.overlay': '浮层',
      'config.summary.inline': '页面内联',
      'config.hint.overlay': '悬浮在视口内，长内容在编辑框内滚动。',
      'config.hint.inline': '按页面坐标铺在消息上，跟随页面滚动，高度按内容展开，不再截到视口。',
      'config.summary.frame': '整行描边',
      'config.summary.bubble': '贴合气泡',
      'config.summary.center': '居中面板',
      'config.hint.frame': '一圈描边套住整条消息行，正文输入框落在消息文字上，按钮在右上角。',
      'config.hint.bubble': '编辑框精确等于消息气泡的大小。',
      'config.hint.center': '大号居中面板，输入框随内容增长。',
      'style.frame': '整行',
      'style.bubble': '气泡',
      'style.center': '居中',
      'editor.block.text': '正文',
      'editor.block.reasoning': '思维链',
      'editor.placeholder-block': '只改这一块；工具调用、其余内容和后续对话保持不变。',
      'confirm.body-block': '确认后只替换这一块，工具调用、其他内容和后续对话保持不变。原始会话日志不会改写。',
      'editor.review': '确认执行',
      'editor.cancel': '取消',
      'editor.pending': '正在保存…',
      'editor.warn.attachments': '这条消息包含图片或文件附件，改写会丢弃它们，只保留文字。',
      'editor.warn-reply': '这条回答包含工具调用或思考过程，替换后它们会被一并移除。',
      'editor.attach.add': '添加附件',
      'editor.attach.remove': '移除这个附件',
      'confirm.body': '确认后会立即执行：只有这条消息被替换，后面的对话保持不变。原始会话日志不会改写。',
      'error.invalid': '请求无效，请刷新后重试。',
      'error.session-not-active': '这个会话当前未激活，请先打开该会话再编辑。',
      'error.session-not-found': '找不到该会话的日志。',
      'error.session-empty': '这个会话还没有内容，暂时没有可编辑的东西。',
      'error.busy': '该会话正在回复中，请等回复结束后再编辑。',
      'error.not-editable': '这条消息不支持编辑。',
      'error.unsupported': '当前宿主不支持就地改写回复，需要走重放路径。',
      'error.already-rolled-back': '这条消息已经不在当前上下文里了。',
      'error.stale': '会话刚刚发生了变化，请重试。',
      'error.forbidden': '请求来源不被允许。',
      'error.method': '请求方式不被接受，请刷新后重试。',
      'error.generic': '编辑失败，请重试。',
      'error.network': '没能连上宿主，请检查连接后重试。',
      'error.prompt': '已回退，但改后的内容没能写进上下文。请重试。',
      'error.reply': '已回退，但替换没有落地。请重试。',
      'error.empty': '改写后的内容不能为空。',
      'error.rerun-nothing': '已保存，但这一轮没有可重跑的作答。',
      'error.rerun-unavailable': '已保存，但重跑没有开始，请稍后重试。',
      'error.not-rerunnable': '这一轮没有可重跑的作答。',
      'error.already-retired': '这一轮的内容已经不在当前上下文里了。',
      'error.rerunning': '已经有一次重跑在进行中，请等它结束。',
      'error.internal': '服务器内部错误，请稍后重试。',
      'error.projection-missing': '编辑投影未注册，请重启 DSH 后重试。',
      'error.attachment-refused': '附件没能存下来，本次修改没有执行。',
      'error.attachments-dropped': '已保存，但这条消息的图片或文件没能保留：当前部署没有可用的附件存储。',
      'error.attachment-unreadable': '这个附件读不出来，请换一个文件。',
      'error.attachment-too-large': '这个文件太大，无法作为附件。',
      'error.too-large': '这次修改太大，服务器没有接收。',
      'error.replay-partial': '已保存并改写了这条回答，但后面的轮次没能全部重放回来，请重新打开会话确认。',
    }

    const en = {
      'action.edit': 'Edit this message',
      'action.edit-reply': 'Edit this reply',
      'copy': 'Copy',
      'copied': 'Copied',
      'action.copied': 'Copied',
      'action.copy': 'Copy this reply',
      'action.tail-actions': 'Actions for this turn',
      'added.block': 'A block added by this plugin (the model sees it; drawn here too)',
      'editor.add-text': 'Add a body block',
      'editor.add-reasoning': 'Add a reasoning block',
      'editor.add-short': '+Body',
      'editor.add-reasoning-short': '+Thinking',
      'editor.title': 'Edit this message',
      'editor.title-reply': 'Edit this reply',
      'editor.placeholder': 'Write what you want to have said. Saving replaces this message in place; the conversation after it stays as it is.',
      'editor.placeholder-reply': 'Write what you want the model to have said; saving makes it this reply.',
      'editor.save': 'Save',
      'editor.rerun': 'Re-run',
      'editor.save-reply': 'Save',
      'editor.block': 'Block',
      'editor.block.all': 'All blocks',
      'config.style': 'Editor style',
      'config.placement': 'Editor placement',
      'config.height': 'Editor height',
      'height.max': 'Turn max',
      'height.content': 'Content',
      'height.fill': 'Fill when all',
      'config.summary.height.max': 'Turn max',
      'config.summary.height.content': 'Content',
      'config.summary.height.fill': 'Fill when all',
      'config.hint.height.max': 'Opens at the tallest reasoning/text block of the turn; while editing it grows with your text and shrinks back, never below the height it opened at.',
      'config.hint.height.content': 'Opens sized for the current block; while editing it grows with your text and shrinks back, never below the height it opened at.',
      'config.hint.height.fill': 'Single blocks open at the turn max and follow your text while editing (never below the opening height); the all-blocks page fills the whole band between the conversation top and the composer, with one scrollbar.',
      'placement.overlay': 'Overlay',
      'placement.inline': 'In-page',
      'placement.legacy': 'Legacy row',
      'config.summary.legacy': 'Legacy row',
      'config.hint.legacy': 'Frames the whole assistant row and keeps the old inner scroll; still covers the action bar, with the controls at the bottom left.',
      'config.summary.overlay': 'Overlay',
      'config.summary.inline': 'In-page',
      'config.hint.overlay': 'Floats inside the viewport; long content scrolls inside the editor.',
      'config.hint.inline': 'Lays over the message in page coordinates and scrolls with the page; it grows with the content instead of being clipped to the viewport.',
      'config.summary.frame': 'Row frame',
      'config.summary.bubble': 'Exact bubble',
      'config.summary.center': 'Centered panel',
      'config.hint.frame': 'Outline the whole message row; the textarea sits on the message text and the actions move to the top-right.',
      'config.hint.bubble': 'The editor is exactly the message bubble.',
      'config.hint.center': 'A large centred panel whose textarea grows with the content.',
      'style.frame': 'Frame',
      'style.bubble': 'Bubble',
      'style.center': 'Center',
      'editor.block.text': 'Answer',
      'editor.block.reasoning': 'Reasoning',
      'editor.placeholder-block': 'Only this block changes; tool calls, the rest of the reply and later turns stay.',
      'confirm.body-block': 'Confirming replaces only this block; tool calls, the rest of the reply and later turns stay. The original session log is never rewritten.',
      'editor.review': 'Confirm',
      'editor.cancel': 'Cancel',
      'editor.pending': 'Working...',
      'editor.warn.attachments': 'This message carries image or file attachments; rewriting keeps the text only.',
      'editor.warn-reply': 'This reply carries tool calls or reasoning; replacing it removes them.',
      'editor.attach.add': 'Add an attachment',
      'editor.attach.remove': 'Remove this attachment',
      'confirm.body': 'Confirming applies right away: only this message is replaced; the conversation after it stays as it is. The original session log is never rewritten.',
      'error.invalid': 'Invalid request; refresh and try again.',
      'error.session-not-active': 'This session is not open in DSH; open it first.',
      'error.session-not-found': 'No session log was found for this id.',
      'error.session-empty': 'This session has nothing in it yet; there is nothing to edit.',
      'error.busy': 'This session is still replying; wait for it to finish.',
      'error.not-editable': 'This message cannot be edited.',
      'error.unsupported': 'This harness does not expose the in-place reply path; the replay path is needed.',
      'error.already-rolled-back': 'This message is no longer in the current context.',
      'error.stale': 'The session just changed; try again.',
      'error.forbidden': 'The request origin is not allowed.',
      'error.method': 'The request method is not accepted; refresh and try again.',
      'error.generic': 'The edit failed; try again.',
      'error.network': 'Could not reach the host; check the connection and try again.',
      'error.prompt': 'Rolled back, but the re-run did not start. Send the revised text manually.',
      'error.reply': 'Rolled back, but the replacement did not land. Try again.',
      'error.empty': 'The revised message cannot be empty.',
      'error.rerun-nothing': 'Saved, but this turn has no reply that can be re-run.',
      'error.rerun-unavailable': 'Saved, but the re-run did not start; try again.',
      'error.not-rerunnable': 'This turn has no reply that can be re-run.',
      'error.already-retired': 'This turn is no longer part of the current context.',
      'error.rerunning': 'A re-run is already in flight; wait for it to finish.',
      'error.internal': 'The host hit an internal error; try again shortly.',
      'error.projection-missing': 'The edit projection is not registered; restart DSH and retry.',
      'error.attachment-refused': 'The attachment could not be stored, so nothing was changed.',
      'error.attachments-dropped': 'Saved, but the images or files on this message could not be kept: this deployment mounts no attachment store.',
      'error.attachment-unreadable': 'That attachment could not be read; try another file.',
      'error.attachment-too-large': 'That file is too large to attach.',
      'error.too-large': 'That revision was too large for the host to accept.',
      'error.replay-partial': 'Saved and corrected, but the turns after it could not all be replayed; reopen the session to check.',
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

    // --- a rewritten prompt, rendered the way the bubble it stands in for is ---

    /**
     * Whether the markdown bubble plugin is on this page.
     *
     * Its own presence marker is the only honest signal: the host draws a user
     * bubble as plain text (`white-space: pre-wrap`), so rendering markdown in
     * the revision bubble is only correct when something else is already
     * rendering the OTHER user bubbles that way. Without it, a rewritten prompt
     * would look different from every untouched prompt around it.
     */
    function markdownBubbleInstalled() {
      try {
        return typeof globalThis !== 'undefined' && globalThis.__DSH_MARKDOWN_BUBBLE__ !== undefined
      } catch {
        return false
      }
    }

    /** One mounted markdown occurrence per bubble, so a rebuild can unmount it. */
    const revisionRoots = new WeakMap()

    /**
     * Draw one rewritten prompt's text into `host`.
     *
     * The host's own markdown renderer (`MarkdownText`) is a React component and
     * this half builds DOM by hand, so it is mounted through `react-dom/client` -
     * the same module the host's own bundles require. Anything missing (no
     * react-dom, no primitives, a hostile host shape) falls back to the plain
     * text node this bubble has always used.
     *
     * @param host - the bubble element that shows the text.
     * @param text - the rewritten text.
     * @returns whether the markdown path was used.
     */
    function renderRevisionText(host, text) {
      if (!markdownBubbleInstalled()) return false
      try {
        const react = require('react')
        const reactDom = require('react-dom/client')
        const MarkdownText = primitives.MarkdownText
        if (
          typeof react?.createElement !== 'function' ||
          typeof reactDom?.createRoot !== 'function' ||
          MarkdownText === undefined ||
          MarkdownText === null
        ) {
          return false
        }
        const previous = revisionRoots.get(host)
        if (previous !== undefined && typeof previous.unmount === 'function') previous.unmount()
        const node = document.createElement('span')
        node.className = 'dshet-revision-text'
        host.appendChild(node)
        const root = reactDom.createRoot(node)
        root.render(react.createElement(MarkdownText, { text }))
        revisionRoots.set(host, root)
        return true
      } catch (error) {
        console.warn('[dsh-edit-turn] the rewritten prompt could not be rendered as markdown:', error)
        return false
      }
    }

    // --- style ----------------------------------------------------------------
    /**
     * Take the active skin's own surfaces when they are actually opaque.
     *
     * A skin may paint its surfaces translucent so artwork shows through, and it
     * compensates with its own text halo - which a plugin element does not have.
     * So the theme's surfaces are adopted only after resolving them to a real
     * colour and finding them opaque; a translucent skin leaves this editor on
     * its own opaque palette. Colours, radii and shadows need no such guard:
     * those are hue and geometry, and they survive any skin.
     *
     * The result is written as inline variables on `body`, which beats both the
     * `:root` defaults and the dark-theme rule below them.
     *
     * @returns nothing; the stylesheet defaults stand when no probe is possible.
     */
    function resolveSkinPalette() {
      if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return
      if (typeof getComputedStyle !== 'function') return
      const probe = document.createElement('span')
      probe.setAttribute('aria-hidden', 'true')
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;pointer-events:none'
      document.body.appendChild(probe)
      const read = (name) => {
        try {
          probe.style.color = `var(${name})`
          const match = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color)
          if (match === null) return null
          const parts = match[1].split(',').map((value) => Number.parseFloat(value))
          if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) return null
          return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
        } catch {
          return null
        }
      }
      const css = (color) => `rgba(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)},${color.a})`
      const style = document.body.style
      const setVar = (name, value) => {
        if (style === undefined || style === null) return
        if (typeof style.setProperty === 'function') style.setProperty(name, value)
        else style[name] = value
      }
      const clearVar = (name) => {
        if (style === undefined || style === null) return
        if (typeof style.removeProperty === 'function') style.removeProperty(name)
        else delete style[name]
      }
      try {
        const panel = read('--dsw-alias-bg-layer-1')
        const layer2 = read('--dsw-alias-bg-layer-2')
        const accent = read('--dsw-alias-button-primary-fill')
        // The skin's surface HUE is taken; its transparency is not. A skin paints
        // its own elements translucent over artwork and gives them a text halo -
        // a plugin element has none, so the same colour is adopted at full
        // opacity. That keeps a dark artwork skin dark (instead of falling back
        // to this plugin's light palette, which is what a skin that never sets
        // `data-ds-dark-theme` used to get) without ever painting text on art.
        const solid = (color) => (color === null ? null : { r: color.r, g: color.g, b: color.b, a: 1 })
        const panelSolid = solid(panel)
        if (panelSolid === null) {
          clearVar('--dshet-panel')
          clearVar('--dshet-chip')
          clearVar('--dshet-field')
        } else {
          const fieldSolid = solid(layer2) ?? panelSolid
          setVar('--dshet-panel', css(panelSolid))
          setVar('--dshet-chip', css(panelSolid))
          setVar('--dshet-field', css(fieldSolid))
        }
        if (accent === null) {
          clearVar('--dshet-on-accent')
        } else {
          // The label that sits ON the accent fill: the platform exposes no
          // inverse token here, so it is picked from the fill's own luminance.
          const channel = (value) => {
            const v = value / 255
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
          }
          const luminance = 0.2126 * channel(accent.r) + 0.7152 * channel(accent.g) + 0.0722 * channel(accent.b)
          setVar('--dshet-on-accent', luminance > 0.35 ? '#0f1115' : '#fff')
        }
      } finally {
        if (typeof probe.remove === 'function') probe.remove()
      }
    }



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
      // Colours, radii and shadows come from the active theme's own tokens, so a
      // skin restyles this editor the way it restyles the rest of the app; every
      // one of them falls back to the value this plugin shipped with. The palette
      // hangs off `body`, not `:root`: a custom property substitutes against the
      // values in scope where it is DEFINED, and the theme declares its tokens on
      // body - on `:root` every reference would silently fall back. Only the
      // SURFACES stay namespaced: a skin is free to make its own surfaces
      // translucent (that is the point of one), and a plugin's element has no
      // artwork-aware halo to stay readable behind. The surfaces are taken from
      // the theme too, but only when a runtime probe finds them opaque (see
      // resolveSkinPalette).
      'body{--dshet-panel:rgba(255,255,255,.96);--dshet-field:rgba(244,247,252,.98);--dshet-chip:rgba(255,255,255,.82);--dshet-line:var(--dsw-alias-border-l2,rgba(16,24,40,.16));--dshet-ink:var(--dsw-alias-label-primary,#0f1524);--dshet-ink-dim:var(--dsw-alias-label-secondary,#4b5872);--dshet-ink-soft:var(--dsw-alias-label-tertiary,#81858c);--dshet-hover:rgba(16,24,40,.07);--dshet-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(9,18,40,.22));--dshet-accent:var(--dsw-alias-button-primary-fill,#4d6bfe);--dshet-on-accent:#fff;--dshet-bubble:var(--dsw-specific-bubble,var(--dshet-field));--dshet-radius-panel:var(--dsw-radius-panel,16px);--dshet-radius-xl:var(--dsw-radius-xl,16px);--dshet-radius-lg:var(--dsw-radius-lg,16px);--dshet-radius-md:var(--dsw-radius-md,12px);--dshet-radius-sm:var(--dsw-radius-sm,8px)}',
      'body[data-ds-dark-theme]{--dshet-panel:rgba(22,28,44,.96);--dshet-field:rgba(14,19,33,.98);--dshet-chip:rgba(22,28,44,.82);--dshet-hover:rgba(255,255,255,.11);--dshet-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.5))}',
      // A hover wash that follows the skin's ink instead of a fixed grey.
      '@supports (color:color-mix(in srgb,red,blue)){body{--dshet-hover:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}body[data-ds-dark-theme]{--dshet-hover:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent)}}',
      // The pencil sits among the platform's own action icons, so it takes the
      // platform's icon colour: our own `--dshet-ink-dim` is a blue-grey and
      // read as a different, "active" icon next to the neutral grey ones. The
      // variable resolves on the action bar (and everywhere above it); the
      // fallback is the value it resolves to in the default theme.
      '.dshet-action{width:28px;height:28px;padding:6px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;transition:background-color .12s,color .12s}',
      // The fallback strip for a turn with no closing body.
      //
      // The gate is the host's OWN marker: TurnTailNodeView renders
      // `data-actions-reveal` on the tail container exactly on the branch that
      // also draws the official action row, and never on the branch that has
      // none. So one rule hides this strip wherever the official one exists -
      // the two can never be drawn together, and no observer is needed.
      '.dshet-tail{display:inline-flex;align-items:center;gap:2px;margin-left:4px}',
      '[data-turn-tail][data-actions-reveal] .dshet-tail{display:none}',
      '.dshet-tail[data-reveal=always]{opacity:1}',
      '@media (hover:hover){.dshet-tail[data-reveal=hover]{opacity:0;transition:opacity 80ms}[data-turn-tail]:hover .dshet-tail[data-reveal=hover],[data-turn-tail]:focus-within .dshet-tail[data-reveal=hover]{opacity:1}}',
      '.dshet-tail-action[data-copied=1]{color:var(--dshet-accent,#4d6bfe)}',
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
      '.dshet-revision{box-sizing:border-box;align-self:flex-end;width:fit-content;max-width:min(72ch,86%);margin:6px 0 6px auto;padding:9px 14px;border-radius:var(--dshet-radius-xl);background:var(--dshet-bubble);color:var(--dshet-ink);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}',
      '.dshet-revision:empty{display:none}',
      '.dshet-revision{position:relative}',
      // Fallback only: a row with no action bar to keep is displayed away
      // entirely, and then its pencil has nowhere but the bubble. It sits in a
      // gutter the bubble reserves for it, never over the text - an absolutely
      // positioned button inside the bubble used to land on the last line, which
      // is how the rewritten prompt got covered up.
      '.dshet-revision.dshet-revision-action{padding-inline-end:40px}',
      '.dshet-revision-text{display:block}',
      '.dshet-revision-files{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
      '.dshet-revision-file{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:2px 6px 2px 2px;border:1px solid var(--dshet-line);border-radius:var(--dshet-radius-sm);background:var(--dshet-chip);font-size:12px;line-height:18px}',
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
      // The one platform action on such a row that cannot answer for itself:
      // copy hands over the text of the message the row was DRAWN for - the
      // wording the user replaced, because the host draws no row for a
      // replacement event. This half answers that press and draws the host's
      // own "copied" moment on the same button (`takeOverRowCopy`): the icon
      // is swapped for a check the way the host swaps it, for the same second.
      '[data-dshet-copy-flash="1"]{position:relative}',
      '[data-dshet-copy-flash="1"]>svg{opacity:0}',
      '[data-dshet-copy-flash="1"]::after{content:"";position:absolute;left:50%;top:50%;width:7px;height:12px;margin:-7px 0 0 -4px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}',
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
      '.dshet-layer[data-dshet-inline="1"]{position:absolute;left:0;top:0;right:auto;bottom:auto;width:100%;height:0}',
      '.dshet-layer{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:40}',
      '.dshet-layer .dshet-editor{position:absolute;pointer-events:auto}',
      '.dshet-editor{display:flex;flex-direction:column;max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain;margin:0;border:1px solid var(--dshet-line);border-radius:var(--dshet-radius-panel);background:var(--dshet-panel);backdrop-filter:blur(var(--dsh-input-card-blur,18px)) saturate(1.2);box-shadow:var(--dshet-shadow);color:var(--dshet-ink);transition:border-color .12s}',
      '.dshet-editor[data-dshet-drop="1"]{outline:2px dashed #4a7dff;outline-offset:-4px}',
      '.dshet-editor:focus-within{border-color:var(--dsw-alias-button-primary-fill,var(--dshet-accent))}',
      '.dshet-editor[data-dshet-inplace="1"]{overflow:hidden;border:1.5px solid var(--dsw-alias-button-primary-fill,#4a7dff);border-radius:var(--dshet-radius-md);background:var(--dshet-panel);backdrop-filter:none;box-shadow:none}',
      '.dshet-editor[data-dshet-inplace="1"] textarea{position:absolute;min-height:0;max-height:none;padding:6px 10px;border:0;border-radius:8px;background:transparent;overflow-y:auto}',
      '.dshet-editor[data-dshet-inplace="1"] .dshet-footer{position:absolute;top:auto;left:0;right:0;bottom:0;height:46px;align-items:center;padding:6px 10px;box-sizing:border-box;background:var(--dshet-panel);border-radius:0 0 var(--dshet-radius-md) var(--dshet-radius-md);gap:6px}',
      '.dshet-editor[data-dshet-inplace="1"] .dshet-btn{padding:2px 8px;font-size:12px;line-height:18px;border-radius:8px}',
      '.dshet-editor[data-dshet-inplace="1"] .dshet-pick{position:static;top:auto;left:auto;padding:0;background:transparent;border-radius:0}',
      '.dshet-editor[data-dshet-inplace="1"] .dshet-note,.dshet-editor[data-dshet-inplace="1"] .dshet-warn{position:absolute;left:8px;bottom:6px;max-width:60%;margin:0;background:var(--dshet-panel);border-radius:8px;padding:2px 6px}',
      '.dshet-editor[data-dshet-inplace="1"] .dshet-error{position:absolute;left:8px;right:8px;bottom:52px;max-width:none;margin:0;padding:6px 10px;border:1px solid var(--dshet-line);border-radius:8px;background:var(--dshet-panel);box-shadow:var(--dshet-shadow);font-weight:500}',

      '.dshet-editor textarea{display:block;width:100%;min-height:47px;max-height:min(46vh,420px);overflow-y:auto;resize:none;box-sizing:border-box;padding:11px 14px 0;border:0;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));outline:none}',
      '.dshet-editor textarea::placeholder{color:var(--dshet-ink-dim)}',
      '.dshet-editor textarea:disabled{opacity:.65}',
      // The blocks this message carries: one chip each, drawn from the same
      // tokens as the panel so a skin cannot wash them out. A chip only takes
      // the width it needs; the label is the only part that may shrink, and the
      // remove button never does.
      '.dshet-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 14px 0}',
      '.dshet-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 4px 3px 6px;border:1px solid var(--dshet-line);border-radius:10px;background:var(--dshet-chip);color:var(--dshet-ink);font-size:12px;line-height:18px}',
      '.dshet-thumb{width:26px;height:26px;flex:none;border-radius:6px;object-fit:cover;background:var(--dshet-field)}',
      '.dshet-chip-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshet-chip-size{flex:none;color:var(--dshet-ink-dim)}',
      '.dshet-chip-remove{flex:none;width:18px;height:18px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dshet-ink-dim);font:inherit;font-size:13px;line-height:16px;cursor:pointer}',
      '.dshet-chip-remove:hover:not(:disabled){background:var(--dshet-hover);color:var(--dsw-alias-state-error-primary,#c93a31)}',
      '.dshet-chip-remove:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dshet-accent));outline-offset:1px}',
      '.dshet-chip-remove:disabled{cursor:default;opacity:.5}',
      '.dshet-attach-row{position:absolute;left:12px;bottom:10px;z-index:2;display:flex;align-items:center;margin:0}',
      '.dshet-attach{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:1px 6px;box-sizing:border-box;border:0;border-radius:999px;background:#f5f6f7;color:#0f1115;font:inherit;line-height:1;cursor:pointer;outline:none;box-shadow:none;-webkit-appearance:none;transition:background-color .12s,color .12s}',
      '.dshet-attach svg{width:14px;height:14px;display:block;stroke:currentColor;fill:none;stroke-width:1.3;}',
      '.dshet-attach:hover:not(:disabled){background:var(--dshet-hover);color:var(--dshet-ink)}',
      '.dshet-attach:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dshet-accent));outline-offset:2px}',
      '.dshet-attach:disabled{cursor:default;opacity:.5}',
      '.dshet-attach-input{display:none}',
      '.dshet-note,.dshet-warn,.dshet-error{margin:4px 14px 0;font-size:12px;line-height:19px}',
      '.dshet-note{color:var(--dshet-ink-dim)}',
      '.dshet-warn{color:var(--dsw-alias-state-warning-primary,#a2650a)}',
      '.dshet-error{color:var(--dsw-alias-state-error-primary,#c93a31)}',
      '.dshet-footer{position:absolute;left:0;right:0;bottom:0;top:auto;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:6px;height:46px;padding:6px 10px;box-sizing:border-box;background:var(--dshet-panel);border-radius:0 0 var(--dshet-radius-panel) var(--dshet-radius-panel)}',
      '.dshet-footer-actions{display:flex;align-items:center;gap:6px}',
      '.dshet-all-nav{position:sticky;top:0;z-index:2;display:flex;flex-wrap:nowrap;align-items:center;gap:6px;min-height:28px;padding:4px 0 6px;background:var(--dshet-panel);overflow-x:auto;scrollbar-width:none}',
      '.dshet-all-nav button{flex:none;border:0;border-radius:999px;background:var(--dshet-hover);color:var(--dshet-ink-dim);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;cursor:pointer;white-space:nowrap}',
      '.dshet-all-nav button:hover{color:var(--dshet-ink)}',
      '.dshet-all{position:absolute;left:8px;right:8px;top:6px;bottom:52px;overflow-y:auto;display:flex;flex-direction:column;padding:2px 4px 4px}',
      '.dshet-all-block{display:flex;flex-direction:column;padding:6px 0 8px}',
      '.dshet-all-block:first-child{padding-top:2px}',
      '.dshet-all-head{display:flex;width:100%;box-sizing:border-box;align-items:center;gap:8px;font-size:11px;color:var(--dshet-ink-dim);padding:0 2px 4px}',
      '.dshet-all-head>span:first-child{background:var(--dshet-hover);border-radius:6px;padding:1px 6px;white-space:nowrap}',
      '.dshet-all-line{flex:1;height:1px;background:var(--dshet-line);opacity:.55}',
      '.dshet-editor[data-dshet-inplace="1"] .dshet-all .dshet-all-area{position:static;left:auto;top:auto;width:100%;height:auto;min-height:32px;max-height:none;padding:0 2px;border-radius:0;overflow:hidden}',
      '.dshet-all-area{display:block;width:100%;min-height:32px;max-height:none;box-sizing:border-box;border:0;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));resize:none;outline:none;overflow:hidden;scrollbar-width:none;padding:0 2px}',
      '.dshet-editor .dshet-footer .dshet-btn{height:34px;box-sizing:border-box;padding:0 14px}',
      '.dshet-btn{padding:6px 16px;border:1px solid var(--dshet-line);border-radius:999px;background:var(--dshet-field);color:var(--dshet-ink);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background-color .12s,border-color .12s}',
      '.dshet-btn:hover:not(:disabled){background:var(--dshet-hover)}',
      '.dshet-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dshet-accent));outline-offset:2px}',
      '.dshet-btn:disabled{cursor:default;opacity:.5}',
      '.dshet-btn-save{width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:#81858c}',
      '.dshet-btn-save:hover:not(:disabled){background:var(--dshet-hover)}',
      '.dshet-btn-save svg{width:15px;height:15px;display:block;stroke:currentColor;fill:none;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}',
      '.dshet-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
      '.dshet-btn-primary{border-color:var(--dsw-alias-button-primary-fill,var(--dshet-accent));background:var(--dsw-alias-button-primary-fill,var(--dshet-accent));color:var(--dsw-alias-label-primary-foreground,var(--dshet-on-accent))}',
      '.dshet-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,var(--dshet-accent));filter:brightness(1.08)}',
'.dshet-btn.dshet-btn-save{width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dshet-ink-soft);filter:none}',
      '.dshet-btn.dshet-btn-save:hover:not(:disabled){background:var(--dshet-hover);filter:none}',
      '.dshet-btn.dshet-btn-save.dshet-btn-confirm{background:var(--dshet-hover);box-shadow:inset 0 0 0 1.5px var(--dshet-accent)}',
      '.dshet-editor .dshet-footer .dshet-btn.dshet-btn-icon{width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:#81858c;filter:none}',
      '.dshet-editor .dshet-footer .dshet-btn.dshet-btn-icon:hover:not(:disabled){background:var(--dshet-hover);color:var(--dshet-ink-soft);filter:none}',
      '.dshet-btn-icon svg{width:15px;height:15px;display:block;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}',
      '.dshet-editor[data-dshet-inplace="1"] .dshet-btn.dshet-btn-save{width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:#81858c;filter:none}',
      '.dshet-editor[data-dshet-inplace="1"] .dshet-btn.dshet-btn-save:hover:not(:disabled){background:var(--dshet-hover);filter:none}',
      '.dshet-pick{display:flex;align-items:center;gap:4px;padding:0;font-size:12px;color:var(--dshet-ink-dim)}',
      '.dshet-config{display:flex;flex-direction:column;gap:10px}',
      '.dshet-config-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dshet-config-hint{margin:0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:13px;line-height:20px}',
      '.dshet-select{padding:3px 8px;border:1px solid var(--dshet-line);border-radius:var(--dshet-radius-sm);background:var(--dshet-field);color:var(--dshet-ink);font:inherit;font-size:12px;line-height:18px}',
      '.dshet-pick .dshet-select{height:28px;padding:0 6px;border:0;border-radius:8px;background:transparent;line-height:1;cursor:pointer;outline:none}',
      '.dshet-pick .dshet-select:hover{background:var(--dshet-hover)}',
      // Blocks the user added to a reply: they have no recorded node of the
      // host's to draw over, so they are appended after that row's content.
      '.dshet-added{display:flex;flex-direction:column;gap:6px;margin-top:8px}',
      '.dshet-added-block{white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dshet-added-reasoning{padding:6px 10px;border-left:3px solid var(--dshet-line,rgba(128,128,128,.45));border-radius:0 8px 8px 0;background:var(--dshet-panel,rgba(128,128,128,.06));color:var(--dsw-alias-label-secondary,#6b7280);font-size:12.5px;line-height:20px}',
      '.dshet-added-text{color:inherit}',
      '.dshet-addbar{display:inline-flex;align-items:center;gap:4px;margin-left:6px}',
      '.dshet-addblock{padding:2px 8px;border:1px solid var(--dshet-line);border-radius:999px;background:var(--dshet-field);color:var(--dshet-ink);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dshet-addblock:hover{background:var(--dshet-hover)}',
      '.dshet-addblock:disabled{opacity:.5;cursor:default}',
      '[data-dshet-patch]{white-space:pre-wrap}',
      '.dshet-notice{margin:4px 0;padding:6px 10px;border:1px solid var(--dshet-line);border-radius:8px;background:var(--dshet-panel);backdrop-filter:blur(18px) saturate(1.2);box-shadow:var(--dshet-shadow);color:var(--dsw-alias-state-error-primary,#c93a31);font-size:12px;line-height:19px}',
      '@media (prefers-reduced-motion:reduce){.dshet-collapsing{transition:none}.dshet-floating{transition:none}}',
    ].join('')

    const TAG_ID = 'dsh-edit-turn/edit-turn.css'
    if (typeof document !== 'undefined') {
      // Reused, not skipped. A plugin upgrade over a live page finds the tag the
      // PREVIOUS build injected; leaving it alone meant a new rule never reached
      // the page - the added-block styling was on screen as plain body text.
      let tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']')
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = NS
        tag.dataset.pluginCss = TAG_ID
        document.head.appendChild(tag)
      }
      if (tag.textContent !== CSS) tag.textContent = CSS
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
        this.editorAnchor = null
        this.editorMode = 'reply'
        this.editorStyle = 'frame'
        this.editorFocus = false
        this.editorDraft = ''
        this.editorBlockKey = ''
        this.editorDrafts = new Map()
        // The block list being edited: what the carrier will be rebuilt from.
        // Every entry is either `{ keep: <index> }` - a block of this message the
        // user left alone - or `{ add: { data, mediaType?, name } }` for
        // something they just picked, with the display fields the chip needs.
        // The list is the ONLY thing that decides what the host writes, which is
        // why a chip the user removes simply leaves it.
        this.editorParts = []
        // Names the added chips, so removing one is a matter of identity rather
        // than of position (a DOM pass may run between two of them).
        this.uploadSeq = 0
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
          // Landed in-place reply patches, latest per block, and the same data
          // indexed by seq for the in-place text display.
          patches: [],
          patchBySeq: new Map(),
          replyMode: 'replay',
          // The block being edited in the reply editor (null for a prompt).
          blocks: [],
          blockIndex: null,
          blockKind: null,
          editing: null,
          draft: '',
          parts: [],
          confirming: false,
          pending: false,
          failure: null,
          notice: null,
          surfaceReady: false,
          loaded: false,
          loadError: false,
          // What the host said it can do with a block list (see /state's
          // `capabilities`). False is the safe reading: an older host, a failed
          // load and a deployment without an attachment store all mean "text
          // only", which is what the editor then offers - with the warning that
          // says so - instead of a chip it cannot honour.
          attachmentsOk: false,
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
            // The in-place reply patches, latest per block. The model sees them
            // through the host projection; this half uses them to draw the
            // projected text over the recorded row.
            const patches = []
            const patchBySeq = new Map()
            for (const patch of Array.isArray(data.patches) ? data.patches : []) {
              if (!patch || typeof patch.seq !== 'number' || typeof patch.blockIndex !== 'number') continue
              if (patch.kind !== 'text' && patch.kind !== 'reasoning') continue
              const normalized = {
                seq: patch.seq,
                blockIndex: patch.blockIndex,
                kind: patch.kind,
                text: String(patch.text ?? ''),
                // An entry that carries `insertId` is a block the user ADDED,
                // not a rewrite of one the message already has. The transcript
                // has no node for it, so it is drawn separately.
                ...(typeof patch.insertId === 'string' ? { insertId: patch.insertId } : {}),
                ...(patch.removed === true ? { removed: true } : {}),
              }
              const previous = patches.findIndex((entry) => entry.seq === normalized.seq && entry.blockIndex === normalized.blockIndex)
              if (previous >= 0) patches[previous] = normalized
              else patches.push(normalized)
              let byBlock = patchBySeq.get(normalized.seq)
              if (byBlock === undefined) { byBlock = new Map(); patchBySeq.set(normalized.seq, byBlock) }
              byBlock.set(normalized.blockIndex, normalized)
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
            let preferredStyle = data.config && (data.config.editorStyle === 'bubble' || data.config.editorStyle === 'center')
              ? data.config.editorStyle
              : 'frame'
            const savedStyle = readStoredEditorStyle()
            if (savedStyle !== null) preferredStyle = savedStyle
            this.editorStyle = preferredStyle
            this.publish({
              hidden,
              revisions,
              editable,
              replies,
              repliesByMessage,
              patches,
              patchBySeq,
              replyMode: data.mode === 'patch' ? 'patch' : 'replay',
              editorStyle: data.config && (data.config.editorStyle === 'bubble' || data.config.editorStyle === 'center')
                ? data.config.editorStyle
                : 'frame',
              surfaceReady: true,
              busy: data.busy === true,
              loaded: true,
              loadError: false,
              confirmStep: !(data.config && data.config.confirm === false),
              // What this host can do with blocks, taken from its own answer.
              // An older host says nothing here, which reads as "text only" -
              // the behaviour every release before blocks had.
              attachmentsOk: Boolean(data.capabilities && data.capabilities.attachments === true),
            })
          })
          .catch(() => {
            this.publish({ loadError: true })
          })
          .finally(() => {
            this.inflight = null
            // While the session is replying, the editor stays open but cannot
            // save; re-check so the banner clears itself when the turn ends.
            if (this.view.busy === true && this.editor !== null) {
              const token = (this.busyToken = (this.busyToken ?? 0) + 1)
              window.setTimeout(() => {
                if (this.busyToken === token && this.editor !== null) this.load()
              }, 3000)
            }
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
        // A reply on the patch path carries its editable blocks; open the one
        // the editor was asked for, or the answer text when none was named.
        const replyBlocks = target.mode === 'reply' && Array.isArray(target.blocks) ? target.blocks : []
        const requested = typeof target.blockIndex === 'number'
          ? replyBlocks.find((block) => block.index === target.blockIndex)
          : undefined
        // Pressing the same pencil again keeps the block the user already
        // switched to; only a fresh open picks the answer block by default.
        const current = same && typeof this.editorBlockIndex === 'number'
          ? replyBlocks.find((block) => block.index === this.editorBlockIndex)
          : undefined
        // A fresh open always lands on the answer text: a turn's block list is
        // mostly reasoning now, and opening on a chain-of-thought is not what
        // the pencil means. The picker is how the user goes to a thought.
        const answerBlock = [...replyBlocks].reverse().find((block) => block.kind === 'text')
        const chosen = (same ? current : undefined) ?? answerBlock ?? requested ?? replyBlocks[0]
        const normalized = replyBlocks.length > 0
          ? {
              ...target,
              patch: true,
              blocks: replyBlocks,
              blockIndex: chosen === undefined ? undefined : chosen.index,
              blockKind: chosen === undefined ? undefined : chosen.kind,
            }
          : target
        this.editor = normalized
        this.editorMode = normalized.mode === 'prompt' ? 'prompt' : 'reply'
        this.editorAnchor = target.anchor !== undefined && target.anchor !== null && target.anchor.isConnected === true
          ? target.anchor
          : null
        this.editorBlocks = replyBlocks
        this.editorBlockIndex = chosen === undefined ? null : chosen.index
        this.editorBlockKind = chosen === undefined ? null : chosen.kind
        this.editorTargetSeq = chosen !== undefined && typeof chosen.seq === 'number' ? chosen.seq : null
        this.editorAll = false
        // The height the box opens at: the floor the user cannot shrink below
        // for as long as this edit lasts (save or cancel ends it). Null until
        // the first layout measures it.
        this.editorBaseHeight = null
        // ONE draft store per open, keyed by block: the 正文/思维链 pages and the
        // sub-pages inside 全部 all read and write it, so switching pages never
        // drops what the user typed (only closing the editor does).
        this.editorDrafts = new Map()
        if (!same) {
          this.editorBlockKey = chosen === undefined ? '' : blockDraftKey(chosen)
          this.editorDraft = chosen === undefined ? target.text : chosen.text
          this.editorParts = blocksToParts(normalized, this.sessionId)
        }
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
        this.publish({
          editing: normalized,
          draft: this.editorDraft,
          parts: this.editorParts.slice(),
          blocks: replyBlocks,
          blockIndex: this.editorBlockIndex,
          blockKind: this.editorBlockKind,
          targetSeq: this.editorTargetSeq,
          allBlocks: false,
          confirming: false,
          failure: null,
        })
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

      // Pick another block of the same reply. The editor is rebuilt by the
      // block index in its marker; the draft becomes that block's current
      // (already projected) text.
      selectBlock(value) {
        if (this.view.pending) return
        const target = this.editor
        if (target === null || !Array.isArray(target.blocks)) return
        const raw = String(value)
        if (raw === 'all') {
          // The all-blocks page reads the SAME drafts: a block edited on its own
          // page shows that edit in its sub-page, and the other way round.
          this.editorAll = true
          this.editorElement = null
          this.publish({ allBlocks: true, blockIndex: null, blockKind: null, targetSeq: null, failure: null })
          return
        }
        const split = raw.includes(':') ? raw.split(':') : ['', raw]
        const seq = split[0] === '' ? null : Number(split[0])
        const index = Number(split[1])
        const block = target.blocks.find((entry) =>
          entry.index === index && (seq === null || entry.seq === undefined || entry.seq === seq))
        // Leaving the all-blocks view has to say so: the picker change alone left
        // `allBlocks` true, so the box was redrawn as the all view again with a
        // picker that said "正文" - two fields over a single-block selection.
        this.editorAll = false
        if (block === undefined || block.kind === undefined) {
          // Nothing matched: still leave the all view, keeping the block that was
          // selected before it, so the picker describes the box again.
          this.publish({ allBlocks: false, failure: null })
          return
        }
        this.editorBlockIndex = block.index
        this.editorBlockKind = block.kind
        this.editorTargetSeq = typeof block.seq === 'number' ? block.seq : this.editorTargetSeq
        this.editorBlockKey = blockDraftKey(block)
        // This block's own draft, which may already carry what the user typed on
        // another page - never the recorded text, which used to wipe it.
        this.editorDraft = this.draftOfBlock(block)
        this.editorElement = null
        this.publish({ draft: this.editorDraft, blockIndex: block.index, blockKind: block.kind, targetSeq: this.editorTargetSeq, allBlocks: false, failure: null })
      }

      close() {
        if (this.view.pending) return
        this.pendingRerun = false
        this.editorElement = null
        this.editorBox = null
        this.editorRow = null
        this.editorAnchor = null
        this.editorMode = 'reply'
        this.editorFocus = false
        this.editor = null
        this.editorDraft = ''
        this.editorParts = []
        this.confirming = false
        this.editorElement = null
        this.editorBlocks = []
        this.editorBlockIndex = null
        this.editorBlockKind = null
        this.editorTargetSeq = null
        this.editorAll = false
        this.editorDrafts = new Map()
        this.editorBlockKey = ''
        this.editorBaseHeight = null
        this.publish({ editing: null, draft: '', parts: [], blocks: [], blockIndex: null, blockKind: null, confirming: false, failure: null })
      }

      /**
       * Add an empty block of `kind` right after the block being edited.
       *
       * The new block is a DRAFT until the save: it lives on the editor's block
       * list with a synthetic index and a stable id, and the record that carries
       * it names the id (never the index - inserting shifts every later index, so
       * a position cannot be an identity). Saving it blank means "this block
       * should not exist", which the host treats as a no-op for a draft and as a
       * removal for one that was already written.
       *
       * @param kind - 'text' or 'reasoning'.
       */
      addBlock(kind) {
        if (this.view.pending) return
        const target = this.editor
        if (target === null || !Array.isArray(target.blocks)) return
        if (kind !== 'text' && kind !== 'reasoning') return
        const current = target.blocks.find((block) => blockDraftKey(block) === this.editorBlockKey)
        // Positions are CONTENT indices, which is what the message carries. A
        // block we inserted has no recorded index, so it keeps its own position.
        let position = 0
        if (current !== undefined) {
          position = typeof current.insertId === 'string' ? current.position : current.index + 1
        } else if (target.blocks.length > 0) {
          const last = target.blocks[target.blocks.length - 1]
          position = typeof last.insertId === 'string' ? last.position : last.index + 1
        }
        const order = this.insertSeq === undefined ? 0 : this.insertSeq
        this.insertSeq = order + 1
        const id = 'ins-' + Date.now().toString(36) + '-' + order.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
        const block = {
          seq: target.seq,
          index: INSERT_INDEX_BASE + order,
          kind,
          text: '',
          original: '',
          patched: false,
          insertId: id,
          position,
        }
        target.blocks.push(block)
        this.editorAll = false
        this.editorBlockKey = blockDraftKey(block)
        this.editorBlockIndex = block.index
        this.editorBlockKind = kind
        this.editorDraft = ''
        this.setDraftFor(block, '')
        this.editorElement = null
        this.publish({
          blocks: target.blocks,
          blockIndex: block.index,
          blockKind: kind,
          targetSeq: target.seq,
          draft: '',
          allBlocks: false,
          failure: null,
        })
      }

      /** The inserted draft block the editor is on, or undefined. */
      currentInsertedBlock(target) {
        if (target === null || target === undefined || !Array.isArray(target.blocks)) return undefined
        return target.blocks.find(
          (block) =>
            typeof block.insertId === 'string' &&
            (blockDraftKey(block) === this.editorBlockKey ||
              (typeof this.editorBlockIndex === 'number' && block.index === this.editorBlockIndex)),
        )
      }

      /** The draft of one block: what the user typed, else the recorded text. */
      draftOfBlock(block) {
        const drafts = this.editorDrafts
        if (drafts instanceof Map) {
          const key = blockDraftKey(block)
          const typed = drafts.get(key)
          if (typeof typed === 'string') return typed
        }
        return block !== null && block !== undefined && typeof block.text === 'string' ? block.text : ''
      }

      /** Remember one block's draft, wherever the user typed it. */
      setDraftFor(block, value) {
        if (!(this.editorDrafts instanceof Map)) this.editorDrafts = new Map()
        this.editorDrafts.set(blockDraftKey(block), String(value ?? ''))
      }

      setDraft(value) {
        this.editorDraft = value
        // The 正文/思维链 page and the matching sub-page inside 全部 are the same
        // block: one store, so the edit survives a page switch.
        const blocks = Array.isArray(this.editorBlocks) ? this.editorBlocks : []
        const current =
          blocks.find((block) => blockDraftKey(block) === this.editorBlockKey) ??
          (typeof this.editorBlockIndex === 'number'
            ? blocks.find((block) => block.index === this.editorBlockIndex && (this.editorBlockKind === null || block.kind === this.editorBlockKind))
            : undefined)
        if (current !== undefined) this.setDraftFor(current, value)
      }

      setEditorStyle(style) {
        if (!EDITOR_STYLES.includes(style)) return
        setEditorStylePreference(style)
        this.editorStyle = style
        this.publish({ editorStyle: style })
      }

      /**
       * One chip the user removed leaves the block list, and nothing else.
       *
       * The list IS the edit: a block that is no longer in it is not written
       * when the carrier is rebuilt, so removing a chip is the whole
       * implementation of "this attachment should not be here any more".
       */
      removePart(key) {
        const next = this.editorParts.filter((part) => part.key !== key)
        if (next.length === this.editorParts.length) return
        this.editorParts = next
        this.publish({ parts: next.slice() })
      }

      /** One payload the user picked joins the block list, at the end. */
      addUpload(upload) {
        this.editorParts = [...this.editorParts, upload]
        this.publish({ parts: this.editorParts.slice() })
      }

      /**
       * Read picked files and append one chip each.
       *
       * The bytes stay in the browser until the save: the host admits them
       * through the platform's attachment store only when the user commits, so
       * opening the editor and cancelling stores nothing.
       */
      attachFiles(files) {
        let list = []
        try {
          list = files === null || files === undefined ? [] : Array.prototype.slice.call(files)
        } catch {
          list = []
        }
        for (const file of list) {
          if (!file || typeof file !== 'object') continue
          if (typeof file.size === 'number' && file.size > MAX_ATTACH_BYTES) {
            this.notify('attachment-too-large')
            continue
          }
          const name = typeof file.name === 'string' && file.name !== '' ? file.name : null
          const mediaType = typeof file.type === 'string' && file.type !== '' ? file.type : null
          readAsBase64(file, (data) => {
            if (data === null) {
              this.notify('attachment-unreadable')
              return
            }
            this.uploadSeq += 1
            this.addUpload({
              key: `a${this.uploadSeq}`,
              add: {
                data,
                ...(mediaType === null ? {} : { mediaType }),
                ...(name === null ? {} : { name }),
              },
              // The chip's own fields. A picked image can show itself through
              // the very bytes it is carrying - no round trip, no store.
              label: name !== null ? name : mediaType !== null ? mediaType : 'attachment',
              bytes: typeof file.size === 'number' ? file.size : null,
              thumbnail: `data:${mediaType === null ? 'application/octet-stream' : mediaType};base64,${data}`,
            })
          })
        }
      }

      /**
       * Save one inserted draft block.
       *
       * @param target - the open editor's target.
       * @param block - the inserted draft block.
       * @param text - its current draft; blank removes it (a draft it never
       *   wrote is simply not recorded).
       */
      async confirmInserted(target, block, text) {
        this.publish({ pending: true, failure: null, failureDetail: null })
        try {
          const res = await fetch(`${ROUTE_PREFIX}/apply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
              ? { signal: AbortSignal.timeout(20000) }
              : {}),
            body: JSON.stringify({
              sessionId: this.sessionId,
              targets: [
                {
                  seq: typeof block.seq === 'number' ? block.seq : target.seq,
                  kind: block.kind,
                  text,
                  insert: { id: block.insertId, position: block.position },
                },
              ],
            }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) {
            const code = data && data.code ? String(data.code) : 'generic'
            const detail = data && typeof data.error === 'string' && data.error !== '' ? data.error : null
            this.publish({ pending: false, failure: code, failureDetail: detail })
            return
          }
          this.editor = null
          this.editorDraft = ''
          this.editorAll = false
          this.editorElement = null
          this.editorBox = null
          this.editorRow = null
          this.publish({
            pending: false,
            editing: null,
            draft: '',
            blocks: [],
            blockIndex: null,
            blockKind: null,
            confirming: false,
            failure: null,
          })
          await this.load(true)
        } catch (error) {
          this.publish({ pending: false, failure: 'network', failureDetail: String((error && error.message) || error) })
        }
      }

      /** The all-blocks save: one request carrying every edited block. */
      async confirmAll(target) {
        const blocks = Array.isArray(target.blocks) ? target.blocks : []
        const targets = []
        for (const block of blocks) {
          const text = this.draftOfBlock(block)
          if (typeof block.insertId === 'string') {
            // An inserted draft may be saved blank: that means it should not
            // exist, and the host stores nothing for a draft it never wrote.
            targets.push({
              seq: typeof block.seq === 'number' ? block.seq : target.seq,
              kind: block.kind,
              text,
              insert: { id: block.insertId, position: block.position },
            })
            continue
          }
          if (typeof text !== 'string' || text.trim() === '') {
            this.publish({ failure: 'empty' })
            return
          }
          if (text !== block.text) {
            targets.push({ seq: typeof block.seq === 'number' ? block.seq : target.seq, blockIndex: block.index, kind: block.kind, text })
          }
        }
        if (targets.length === 0) {
          this.publish({ failure: null })
          this.editor = null
          this.publish({ editing: null })
          return
        }
        this.publish({ pending: true, failure: null, failureDetail: null })
        try {
          const res = await fetch(`${ROUTE_PREFIX}/apply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
              ? { signal: AbortSignal.timeout(20000) }
              : {}),
            body: JSON.stringify({ sessionId: this.sessionId, targets }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) {
            const code = data && data.code ? String(data.code) : 'generic'
            const detail = data && typeof data.error === 'string' && data.error !== '' ? data.error : null
            this.publish({ pending: false, failure: code, failureDetail: detail })
            return
          }
          this.editor = null
          this.editorDraft = ''
          this.editorAll = false
          this.editorDrafts = new Map()
          this.editorElement = null
          this.editorBox = null
          this.editorRow = null
          this.editorFocus = false
          this.confirming = false
          this.publish({ pending: false, editing: null, confirming: false, failure: null })
          this.load()
        } catch {
          this.publish({ pending: false, failure: 'generic' })
        }
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
        if (this.editorAll === true) {
          return this.confirmAll(target)
        }
        const text = this.editorDraft
        const inserted = this.currentInsertedBlock(target)
        if (inserted !== undefined) {
          // A block this editor just created is saved as an insertion, not as a
          // rewrite: it has no recorded block to point at. Blank means "forget
          // it", which is why the empty check below does not apply.
          return this.confirmInserted(target, inserted, text)
        }
        if (text.trim() === '') {
          this.publish({ failure: 'empty' })
          return
        }
        // What the host will rebuild the carrier from: the blocks still on the
        // list, in order, plus anything picked. Sent only when the host answered
        // that it can carry blocks - a request that names blocks this host would
        // have to drop is a request that lies about what the save did.
        const parts = target.mode === 'prompt' && this.view.attachmentsOk === true
          ? this.editorParts.map((part) => (part.keep !== undefined ? { keep: part.keep } : { add: part.add }))
          : undefined
        this.publish({ pending: true, failure: null, failureDetail: null })
        try {
          const res = await fetch(`${ROUTE_PREFIX}/apply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // A hung host must not leave the editor pending forever with a
            // button that looks dead.
            ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
              ? { signal: AbortSignal.timeout(20000) }
              : {}),
            body: JSON.stringify({
              sessionId: this.sessionId,
              seq: target.seq,
              messageId: typeof target.messageId === 'string' ? target.messageId : undefined,
              text,
              ...(parts === undefined ? {} : { parts }),
              // The in-place reply path names one block; the host validates that
              // it is still that kind at that index before writing the record.
              ...(target.patch === true && typeof this.editorBlockIndex === 'number'
                ? {
                    blockIndex: this.editorBlockIndex,
                    kind: this.editorBlockKind,
                    ...(this.editorTargetSeq === null ? {} : { targetSeq: this.editorTargetSeq }),
                  }
                : {}),
            }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) {
            const code = data && data.code ? String(data.code) : 'generic'
            const detail = data && typeof data.error === 'string' && data.error !== '' ? data.error : null
            this.publish({ pending: false, failure: code, failureDetail: detail })
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
              // The host answers with what the carrier now carries, described
              // the way /state describes it. Adopted for the row drawn before
              // the refresh lands: without it a second save could not know
              // which blocks are still there and would rewrite text-only.
              blocks: Array.isArray(data.blocks) ? data.blocks : [],
            })
          }
          // A reply edit shadows its own reply too, so it leaves the editable
          // replies here and re-enters through the next /state refresh (the
          // appended correction is itself an editable reply).
          const replies = new Map(this.view.replies)
          // The in-place path wrote one small record and touched no surface
          // row: the reply stays where it is, and its block list is updated
          // optimistically so the next render already shows the new text.
          let patches = this.view.patches
          let patchBySeq = this.view.patchBySeq
          if (data.mode === 'patch' && data.target && typeof data.target.blockIndex === 'number') {
            // The BLOCK's own seq, not the reply's. A turn's reasoning can live
            // in another step's message, and the host reports that seq in the
            // answer. Keying the optimistic patch by the reply's seq looked up
            // the wrong block, took the wrong `original`, and the patch then
            // matched nothing in the DOM - the edit appeared only after a reload,
            // when /state supplied it under its own seq (reported from the field
            // for the 思维链 page; the 正文 page looked fine because its block IS
            // the reply's own).
            const patchSeq = typeof data.target.seq === 'number' ? data.target.seq : target.seq
            const targetPatch = {
              seq: patchSeq,
              blockIndex: data.target.blockIndex,
              kind: data.target.kind === 'reasoning' ? 'reasoning' : 'text',
              text: String(data.target.text ?? ''),
            }
            patches = patches
              .filter((entry) => !(entry.seq === targetPatch.seq && entry.blockIndex === targetPatch.blockIndex))
              .concat([targetPatch])
            patchBySeq = new Map(patchBySeq)
            const byBlock = new Map(patchBySeq.get(targetPatch.seq) ?? [])
            byBlock.set(targetPatch.blockIndex, targetPatch)
            patchBySeq.set(targetPatch.seq, byBlock)
            // The entry that carries this block: the reply's own, or the one
            // whose block list holds another step's reasoning.
            let entry = replies.get(patchSeq)
            if (entry === undefined || !Array.isArray(entry.blocks)) {
              for (const candidate of replies.values()) {
                if (Array.isArray(candidate?.blocks) && candidate.blocks.some((block) => block.seq === patchSeq)) {
                  entry = candidate
                  break
                }
              }
            }
            if (entry !== undefined && Array.isArray(entry.blocks)) {
              const blocks = entry.blocks.map((block) =>
                block.index === targetPatch.blockIndex &&
                (block.seq === undefined || block.seq === patchSeq)
                  ? { ...block, text: targetPatch.text, patched: true }
                  : block)
              const text = blocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n')
              replies.set(target.seq, {
                ...entry,
                blocks,
                text,
                patched: blocks.some((block) => block.patched === true),
              })
            }
          }
          for (const entry of replies.values()) {
            if (hidden.has(entry.seq)) replies.delete(entry.seq)
          }
          this.animateOnce = true
          this.editor = null
          this.editorDraft = ''
          this.editorParts = []
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
            patches,
            patchBySeq,
            blocks: [],
            blockIndex: null,
            blockKind: null,
            parts: [],
            failure: null,
          })
          // `unchanged` means the host wrote NOTHING: the draft is (verbatim)
          // the text the message already carries. The flag is read here for one
          // reason, and it is not the user's: a no-op is not a failure. The
          // `applied === false` wording below would claim the rollback landed
          // and the replacement did not, which is a lie about an edit that was
          // never attempted.
          //
          // Nothing is announced for it, deliberately (0.2.20 removed the
          // notice this used to draw): the edit was simply not an edit, so the
          // editor closes like any save and the screen is exactly as it was -
          // no row was shadowed, so none is hidden, and the message keeps the
          // pencil it had. (The banner also landed on top of the composer's
          // placeholder text, which is not a place to report anything from.)
          //
          // The re-run intent survives it. "Re-run" saves first only because the
          // sibling regenerates the turn from the prompt the surface shows; a
          // user who pressed it wants that turn regenerated whether or not the
          // wording moved, so the chain below is NOT gated on a write having
          // happened. (The decision itself is the host's - the text is parsed
          // there, once - and this half only reads the flag it sends back.)
          if (data.unchanged !== true) {
            // The rollback has landed, so the editor is gone with its row: a
            // failed second half has to be reported somewhere that survives that.
            if (data.kind === 'reply' && data.applied === false) this.notify('reply')
            if (data.kind !== 'reply' && data.applied === false) this.notify('prompt')
            // The save landed, but it left non-text blocks behind (the host says
            // so): the editor that could have warned is gone by now, so this is
            // the only place the user can still be told (see applyEdit's
            // `dropped`).
            if (data.kind !== 'reply' && data.applied === true && data.dropped === true) this.notify('attachments-dropped')
            // The correction landed, but replaying the turns behind it did not:
            // the editor is already gone, so this is the only place left to say
            // that the tail is missing from the context instead of silently
            // hiding rows the user still expects.
            if (data.applied === true && data.replay && data.replay.error) this.notify('replay-partial')
          }
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
          // The blocks this message carries, as /state described them. They seed
          // the editor's chips; a host that does not describe them (or an
          // optimistic entry that predates its refresh) simply has none.
          blocks: Array.isArray(entry.blocks) ? entry.blocks : [],
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
      pressable(button, (event) => {
        const activate = button[ACTIVATE]
        if (typeof activate === 'function') activate(event)
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
        // Nothing of ours stands in for this row any more: the row's own copy
        // button answers for itself again.
        releaseRowCopy(row)
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
      const extraBlocks = entry && Array.isArray(entry.blocks) ? entry.blocks.filter((block) => block.type !== 'text') : []
      if (text === '' && extraBlocks.length === 0) {
        if (existing !== null) existing.remove()
        releaseRowCopy(row)
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
      // A rewritten prompt may still carry images/files. The carrier keeps
      // those blocks, the model reads them, and the editor lists them - the
      // standing-in bubble must show them too, or an edited image message looks
      // like the images were deleted.
      const signature = text + '|' + extraBlocks.map((block) =>
        `${String(block.index)}:${String(block.type)}:${String(block.name ?? '')}:${String(block.bytes ?? '')}`).join(',')
      // The signature carries whether the markdown path was used: installing or
      // removing the markdown bubble plugin must redraw this bubble too.
      const markdownSignature = signature + '|md:' + (markdownBubbleInstalled() ? '1' : '0')
      if (bubble.dataset.dshetRevisionContent !== markdownSignature) {
        const previous = revisionRoots.get(bubble)
        if (previous !== undefined && typeof previous.unmount === 'function') previous.unmount()
        revisionRoots.delete(bubble)
        bubble.textContent = ''
        if (!renderRevisionText(bubble, text)) {
          const textNode = document.createElement('span')
          textNode.className = 'dshet-revision-text'
          textNode.textContent = text
          bubble.appendChild(textNode)
        }
        const files = revisionAttachments(entry, controller)
        if (files !== null) bubble.appendChild(files)
        bubble.dataset.dshetRevisionContent = markdownSignature
      }
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
          // The bar that survived still holds the host's own copy button, and it
          // reads the message this row was drawn for - the wording the user just
          // replaced. This row's text is the bubble above it, so the press is
          // answered here (`takeOverRowCopy`).
          takeOverRowCopy(row, text, t)
        } else {
          injectRowAction(bubble, editTarget, controller, t, { gutter: true })
          removeRowAction(row)
          bubble.classList.add('dshet-revision-action')
          releaseRowCopy(row)
        }
      } else {
        removeRowAction(bubble)
        bubble.classList.remove('dshet-revision-action')
        releaseRowCopy(row)
      }
      return true
    }

    /**
     * The non-text blocks of a rewritten prompt, drawn under its text.
     *
     * These are the same blocks the editor lists as chips; the bytes come from
     * this plugin's attachment route, so a thumbnail works without a host API.
     */
    function revisionAttachments(entry, controller) {
      if (!entry || !Array.isArray(entry.blocks)) return null
      const blocks = entry.blocks.filter((block) => block.type !== 'text')
      if (blocks.length === 0) return null
      const strip = document.createElement('div')
      strip.className = 'dshet-revision-files'
      for (const block of blocks) {
        const item = document.createElement('div')
        item.className = 'dshet-revision-file'
        if (block.preview === true && typeof block.index === 'number') {
          const image = document.createElement('img')
          image.className = 'dshet-thumb'
          image.alt = ''
          image.src = previewUrl(controller.sessionId, entry.seq, block.index)
          image.addEventListener('error', () => {
            if (typeof image.remove === 'function') image.remove()
          })
          item.appendChild(image)
        }
        const label = document.createElement('span')
        label.className = 'dshet-chip-label'
        label.textContent = typeof block.name === 'string' && block.name !== '' ? block.name : block.type
        item.appendChild(label)
        strip.appendChild(item)
      }
      return strip
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

    // --- the rewritten row answers its own copy -------------------------------
    //
    // The platform's copy action hands over the text of the message it DREW the
    // row for. A prompt this plugin rewrote in place never gets a row of its own:
    // the host draws transcript rows for append-origin surface events only
    // (`isAppendSurfaceEvent` in dsh-client-ui-chat), and a rewrite is a
    // replacement, so the row that stands in for the message is the ORIGINAL one
    // and still carries the wording the user replaced. Pressing copy on a
    // rewritten prompt therefore pastes what the user was trying to get rid of:
    // rewrite 回复1 into 回复2, press copy, paste 回复1.
    //
    // The button cannot be repaired from here - its text is read off the host's
    // projection node, while the rewritten wording is the textContent of a bubble
    // this half owns - and it must not be taken out either: the host owns that
    // node and unmounts it through its own reconciler, and a bundle that goes
    // away has to leave a working button behind, not a dead one. What this half
    // CAN do is answer the press first: the listener is planted in the CAPTURE
    // phase, the host listens for clicks at its root in the bubble phase, so this
    // runs ahead of the host's handler and stops it, and the text it writes is
    // the text this row actually shows.
    //
    // Everything the listener needs is read off the BUTTON when the press
    // happens - the text, the label, the writer - never captured in the closure.
    // A reloaded bundle finds the button by its marker, refreshes that state, and
    // a listener the instance before it planted goes on working (the rule
    // `wireAction` follows for the pencil).
    const COPY_TEXT = 'dshetCopyText'
    const COPY_FLASH = 'dshetCopyFlash'
    const COPY_LABEL = 'dshetCopyLabel'
    const COPY_OWN = 'dshetCopyOwn'
    /** The live state of one press; a name no sibling plugin uses. */
    const COPY_PRESS = 'dshetCopyPress'
    const COPY_TIMER = 'dshetCopyTimer'
    /** The host draws its own check for a second; this is the same second. */
    const COPY_FEEDBACK_MS = 1000

    /**
     * A button another plugin put in this bar.
     *
     * Every injected action in this family carries its own namespace marker (the
     * three sibling plugins do, by contract), and the host's own actions carry no
     * `data-*` of their own at all. This plugin's four markers are excluded:
     * they are written on the HOST's button, not on one of ours.
     */
    function pluginOwned(button) {
      const data = button.dataset
      if (data === undefined || data === null) return false
      for (const key of Object.keys(data)) {
        if (key === COPY_TEXT || key === COPY_FLASH || key === COPY_LABEL || key === COPY_OWN) continue
        if (key !== '') return true
      }
      return false
    }

    /**
     * The platform's own copy button in a row's action bar, or null when the bar
     * holds none of its own to answer for.
     *
     * The host draws the clock, then the copy button, and gives a user row neither
     * a branch action nor an extra strip - so the bar's FIRST button is the copy
     * button. The CSS-module class the host's icons carry is deliberately not
     * required: it is a build hash that can be renamed, and a rule that reads it
     * would go quietly dead on the day it is (the pencil placement still matches
     * that suffix, which is a different, visible contract). A sibling plugin's
     * button is skipped: it carries its own namespace marker, and a sibling's is
     * never this half's to answer for. A button this half already answers is
     * found by ITS marker alone (I3), however the bar has been rebuilt around it.
     */
    function nativeCopyButton(row, t) {
      if (row === null || row === undefined || typeof row.querySelector !== 'function') return null
      const bar = row.querySelector('[class*="_actions"]')
      if (bar === null || bar === undefined) return null
      // The host's own wording for the two states of its copy button. It resolves
      // through the same namespace -> shared `common` fallback the host's own
      // lookup uses, so this names the button rather than guessing at it; a host
      // that cannot resolve them simply falls through to the rule below.
      const copy = typeof t === 'function' ? t('copy') : null
      const copied = typeof t === 'function' ? t('copied') : null
      let unclaimed = null
      for (const child of bar.children) {
        if (child.tagName !== 'BUTTON') continue
        if (child.dataset !== undefined && child.dataset[COPY_OWN] === '1') return child
        if (pluginOwned(child)) continue
        const label = typeof child.getAttribute === 'function' ? child.getAttribute('aria-label') : null
        if (typeof label === 'string' && label !== '' && (label === copy || label === copied)) return child
        if (unclaimed === null) unclaimed = child
      }
      return unclaimed
    }

    /**
     * Hand a rewritten row's copy press to this half.
     *
     * The button is left exactly as the host rendered it - not removed, not
     * hidden, not disabled; only this half's own markers go on it. Without the
     * host's own clipboard writer the button keeps the host's behaviour too: a
     * takeover that cannot copy is worse than none.
     */
    function takeOverRowCopy(row, text, t) {
      const button = nativeCopyButton(row, t)
      if (button === null) return
      const write = primitives !== null && primitives !== undefined && typeof primitives.writeClipboard === 'function'
        ? primitives.writeClipboard
        : null
      if (write === null) return
      if (button.dataset !== undefined && button.dataset[COPY_OWN] !== '1') {
        button.dataset[COPY_OWN] = '1'
        if (typeof button.addEventListener === 'function') {
          // Capture: this runs ahead of the host's own click handling, which
          // listens at the root and would write the message the row was drawn for.
          // Stopping the event there is also what keeps that handler from running
          // at all, so the host's own follow-up (its tooltip withdraw, its check)
          // does not happen for this press - which is why the check is drawn here.
          button.addEventListener('click', (event) => pressRowCopy(button, event), true)
        }
      }
      if (button.dataset !== undefined) {
        // The host's own wording, kept to give back: what the button said before
        // this half drew its check over it.
        if (button.dataset[COPY_LABEL] === undefined) {
          const label = typeof button.getAttribute === 'function' ? button.getAttribute('aria-label') : null
          if (typeof label === 'string' && label !== '') button.dataset[COPY_LABEL] = label
        }
        if (button.dataset[COPY_TEXT] !== text) button.dataset[COPY_TEXT] = text
      }
      button[COPY_PRESS] = { done: t('action.copied'), write }
    }

    /**
     * The press itself.
     *
     * No text marker means the row is not (or no longer) a rewritten prompt, and
     * the press is left completely alone: the host's own handler answers it, and a
     * released row behaves like every other row.
     */
    function pressRowCopy(button, event) {
      const data = button.dataset
      if (data === undefined || typeof data[COPY_TEXT] !== 'string') return
      if (event !== null && event !== undefined) {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
      }
      // One copy per check, the way the host paces its own button.
      if (data[COPY_FLASH] === '1') return
      const press = button[COPY_PRESS]
      if (press === null || press === undefined || typeof press.write !== 'function') return
      let pending = null
      try {
        pending = press.write(data[COPY_TEXT])
      } catch {
        return
      }
      if (pending === null || pending === undefined || typeof pending.then !== 'function') return
      pending.then(
        (ok) => {
          if (ok === true) flashRowCopy(button, press.done)
        },
        () => {},
      )
    }

    /**
     * The host's own "copied" moment, drawn on the button it belongs to.
     *
     * The host shows it by swapping its icon and its label. On this row its own
     * React state never hears about the press, so this half draws the same thing
     * from its stylesheet (`[data-dshet-copy-flash="1"]`) and gives the borrowed
     * label back when the moment is over. Both are this half's own writes, and
     * both are taken back on release (I4).
     */
    function flashRowCopy(button, done) {
      const data = button.dataset
      if (data === undefined) return
      data[COPY_FLASH] = '1'
      if (typeof done === 'string' && done !== '' && typeof button.setAttribute === 'function') {
        button.setAttribute('aria-label', done)
      }
      if (button[COPY_TIMER] !== undefined && button[COPY_TIMER] !== null) {
        if (typeof window.clearTimeout === 'function') window.clearTimeout(button[COPY_TIMER])
      }
      if (typeof window.setTimeout !== 'function') return
      button[COPY_TIMER] = window.setTimeout(() => {
        button[COPY_TIMER] = null
        clearRowCopyFlash(button)
      }, COPY_FEEDBACK_MS)
    }

    /**
     * Take the check back.
     *
     * `data-dshet-copy-label` is what the host's own button said before this half
     * drew its check on it; the host never wrote it, so giving it back is this
     * half returning its own change (I4).
     */
    function clearRowCopyFlash(button) {
      if (button[COPY_TIMER] !== undefined && button[COPY_TIMER] !== null) {
        if (typeof window.clearTimeout === 'function') window.clearTimeout(button[COPY_TIMER])
        button[COPY_TIMER] = null
      }
      const data = button.dataset
      if (data === undefined) return
      delete data[COPY_FLASH]
      const label = data[COPY_LABEL]
      if (typeof label === 'string' && label !== '' && typeof button.setAttribute === 'function') {
        button.setAttribute('aria-label', label)
      }
    }

    /** Hand one platform copy button back: nothing of ours is left WRITTEN on it. */
    function releaseCopyButton(button) {
      if (button === null || button === undefined || typeof button !== 'object') return
      clearRowCopyFlash(button)
      const data = button.dataset
      if (data !== undefined) {
        delete data[COPY_TEXT]
        delete data[COPY_LABEL]
      }
      button[COPY_PRESS] = undefined
      // `data-dshet-copy-own` stays, and so does the listener: neither claims
      // anything about the message any more, and that marker is what stops a
      // reloaded bundle from planting a second listener on the same button. A
      // press with no text marker returns above and reaches the host's own
      // handler - exactly the behaviour the row had before this plugin saw it.
    }

    /** The copy handover of a row, wherever the last pass left it. */
    function releaseRowCopy(row) {
      const button = nativeCopyButton(row)
      if (button !== null) releaseCopyButton(button)
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
    /**
     * The host's own message markup inside a row - the stack / bubble / markdown
     * the transcript draws the text in. That subtree is the ONLY thing the
     * collapse walk may hide: a sibling that does not contain it belongs to
     * somebody else (another plugin's injected button, a portal), and hiding it
     * is issue #1 - `dsh-rewind-pro`'s button stayed in the DOM, stayed
     * clickable, and was `display:none` on screen with no console error to
     * notice. Null when the host shape is not one we recognise; the walk then
     * keeps its old "everything but ours" behaviour instead of leaving a
     * rewritten prompt on screen.
     */
    function messageContentRoot(row) {
      const selectors = ['[class*="_bubble"]', '[class*="userStack"]', '[class*="_markdown"]', '[class*="_stack"]', '[class*="messageBody"]']
      for (const selector of selectors) {
        let found = null
        try {
          found = row.querySelector(selector)
        } catch {
          found = null
        }
        if (found === null || found === undefined) continue
        if (typeof found.closest === 'function' && found.closest('.dshet-editor') !== null) continue
        return found
      }
      return null
    }

    function collapseRowContent(row, hide) {
      const strip = row.querySelector('[class*="_actions"]')
      if (strip === null) return false
      // Only consulted while hiding: the restore pass goes by the marker this
      // plugin wrote, so a node an older build had hidden is still restored.
      const contentRoot = hide ? messageContentRoot(row) : null
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
          // I5 / issue #1: another plugin's node beside the message is not ours
          // to hide. Only a sibling that holds the message content is.
          if (
            hide &&
            contentRoot !== null &&
            typeof child.contains === 'function' &&
            child.contains(contentRoot) !== true
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
      button[ACTIVATE] = (event) => controller.open({
        ...entry.target,
        // The editor belongs beside the pencil the user just pressed, not at the
        // top of a row that may be taller than the screen.
        anchor: event !== undefined && event !== null && event.currentTarget !== undefined
          ? event.currentTarget
          : button,
      })
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
    // Some host skins mark their editor chrome `!important`; only an inline
    // `!important` outranks that. The stub DOM has no `setProperty`, so it falls
    // back to a plain assignment there.
    function forceStyle(element, property, value) {
      if (element === null || element === undefined || element.style === undefined) return
      if (typeof element.style.setProperty === 'function') {
        element.style.setProperty(property, value, 'important')
        return
      }
      element.style[property] = value
    }

    /**
     * The surface an in-place editor paints itself with, so the recorded text
     * underneath cannot show through the draft.
     *
     * The skin's own panel colour comes first. A skin that paints the app on
     * artwork usually leaves `body` transparent (the artwork is a layer behind
     * it), and the white fallback then put a white box on a night sky. The
     * palette keeps the skin's hue and drops its transparency, so what comes back
     * here is opaque by construction.
     *
     * @returns a CSS colour for the editor's own background.
     */
    function pageBackground() {
      try {
        if (typeof getComputedStyle === 'function' && typeof document !== 'undefined' && document.body) {
          const panel = String(getComputedStyle(document.body).getPropertyValue('--dshet-panel') || '').trim()
          const match = /rgba?\(([^)]+)\)/.exec(panel)
          if (match !== null) {
            const parts = match[1].split(',').map((value) => Number.parseFloat(value))
            const opaque = parts.length >= 3 && parts.every((value) => Number.isFinite(value)) && (parts.length < 4 || parts[3] >= 0.9)
            if (opaque) return panel
          }
          const value = getComputedStyle(document.body).backgroundColor
          if (value && value !== 'transparent' && !/rgba?\(0, 0, 0, 0\)/.test(value)) return value
        }
      } catch {
        /* fall through */
      }
      return '#ffffff'
    }

    function viewportSize() {
      const win = typeof window === 'undefined' ? undefined : window
      const doc = typeof document === 'undefined' ? undefined : document
      const width = (win !== undefined && win.innerWidth) ||
        (doc !== undefined && doc.documentElement && doc.documentElement.clientWidth) || 0
      const height = (win !== undefined && win.innerHeight) ||
        (doc !== undefined && doc.documentElement && doc.documentElement.clientHeight) || 0
      return { width, height }
    }

    // Put the box under the row it belongs to: same width, just below its lower
    // edge. The layer is fixed to the viewport, so a row near the bottom (or one
    // taller than the screen) used to push the footer - and its save button -
    // past the bottom edge where nothing could reach it. Flip above the row when
    // there is room, otherwise pin the box to the bottom of the viewport and let
    // its own scrollbar carry the content; the footer stays sticky either way.
    /**
     * The bubble the editor stands in for.
     *
     * A prompt is a right-aligned input bubble; a reply is the output content
     * block. The editor takes that element's width and left edge and overlays its
     * position, so it reads as the message being edited instead of a floating
     * panel. Class hashes change between builds, so the suffixes are matched.
     */
    function bubbleFor(row, mode, blockKind = null) {
      let selectors
      if (mode === 'reply' && blockKind === 'reasoning') {
        selectors = ['details', '[class*="_reasoning"]', '[class*="_thinking"]', '[class*="reasoning"]']
      } else if (mode === 'reply') {
        selectors = ['[class*="_markdown"]', '[class*="_bubble"]', '[class*="messageBody"]']
      } else {
        selectors = ['[class*="_bubble"]', '[class*="userStack"]', '[class*="_markdown"]']
      }
      for (const selector of selectors) {
        let nodes = []
        try {
          nodes = [...row.querySelectorAll(selector)]
        } catch {
          nodes = []
        }
        let best = null
        for (const element of nodes) {
          if (typeof element.closest === 'function' && element.closest('.dshet-editor') !== null) continue
          const rect = element.getBoundingClientRect()
          if (rect.width < 80 || rect.height <= 0) continue
          if (best === null || rect.width * rect.height > best.rect.width * best.rect.height) best = { element, rect }
        }
        if (best !== null) return best
      }
      const rect = row.getBoundingClientRect()
      return { element: row, rect }
    }

    /**
     * Which row an editor should attach to when several cover the edited seq.
     *
     * A reply's seq appears in both the assistant-step row and the turn-tail
     * row that carries its action strip; the tail also covers the reply, so a
     * last-write-wins loop handed the editor the tail's little action bar and
     * the box came out message-sized instead of bubble-sized. The message row
     * always wins.
     */
    function editorRowRank(row, mode) {
      const kind = row.getAttribute('data-chat-flow-kind')
      if (mode === 'prompt') {
        if (kind === 'user') return 4
        if (kind === 'revision' || kind === 'user-revision') return 3
        if (kind === 'turn-tail' || kind === 'turn-process') return 1
        return 2
      }
      if (kind === 'assistant-step') return 4
      if (kind === 'turn-tail' || kind === 'turn-process') return 1
      return 2
    }

    /**
     * The vertical band the conversation owns: below its top, above the composer.
     *
     * This runs on every scroll frame, so the lookups are cached briefly: the
     * composer element and the conversation top do not move between frames, and
     * a global `[class*=...]` scan per frame is what made scrolling feel heavy.
     */
    let conversationBoundsCache = null
    let conversationBoundsAt = 0
    let composerElementCache = null
    function conversationBounds(row = null) {
      const now = Date.now()
      if (conversationBoundsCache !== null && now - conversationBoundsAt < 250) return conversationBoundsCache
      const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 0
      const bounds = { top: 0, bottom: viewportHeight, composerLeft: 0, composerWidth: 0 }
      try {
        const conversation = document.querySelector('[data-slot="main.conversation"]')
        if (conversation !== null && typeof conversation.getBoundingClientRect === 'function') {
          bounds.top = conversation.getBoundingClientRect().top
        }
      } catch {}
      // The real scroll area is the nearest scrollable ancestor of the edited
      // row; the slot wrapper can start above the header, which let the box
      // cover the tab bar.
      try {
        let node = row !== null && row !== undefined ? row.parentElement : null
        while (node !== null && node !== undefined && node !== document.body) {
          const style = getComputedStyle(node)
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.getBoundingClientRect().height > 120) {
            bounds.top = Math.max(bounds.top, node.getBoundingClientRect().top)
            break
          }
          node = node.parentElement
        }
      } catch {}
      // The composer stack has several wrappers with "composer" in the class;
      // the boundary is the LOWEST one that still sits above the viewport edge,
      // otherwise the box runs under the input box.
      try {
        // The composer CARD is the rounded surface that owns the input, not the
        // outer seat (which is wider and made the editor overhang). Walk up from
        // the input element to the first rounded, painted ancestor.
        let card = document.querySelector('textarea[placeholder], [contenteditable="true"]')
        while (card !== null && card !== undefined && card !== document.body) {
          const style = getComputedStyle(card)
          const radius = Number.parseFloat(style.borderTopLeftRadius)
          if (radius > 6 && style.backgroundColor !== 'rgba(0, 0, 0, 0)') break
          card = card.parentElement
        }
        let lowest = 0
        let lowestRect = null
        if (card !== null && card !== undefined && card !== document.body && typeof card.getBoundingClientRect === 'function') {
          const rect = card.getBoundingClientRect()
          if (rect.top > 0 && (viewportHeight === 0 || rect.top < viewportHeight)) {
            lowest = rect.top
            lowestRect = rect
          }
        }
        if (lowestRect === null) {
          const candidates = document.querySelectorAll('[data-slot="conversation.input"], [class*="composerSeat"], [class*="composer"]')
          for (const candidate of candidates) {
            if (typeof candidate.getBoundingClientRect !== 'function') continue
            const rect = candidate.getBoundingClientRect()
            if (rect.top > lowest && (viewportHeight === 0 || rect.top < viewportHeight - 40)) {
              lowest = rect.top
              lowestRect = rect
            }
          }
        }
        bounds.bottom = lowest > 0 ? lowest : Math.min(viewportHeight, viewportHeight - 120)
        if (lowestRect !== null) {
          bounds.composerLeft = lowestRect.left
          bounds.composerWidth = lowestRect.width
        }
      } catch {
        bounds.bottom = viewportHeight > 0 ? viewportHeight - 120 : viewportHeight
      }
      conversationBoundsCache = bounds
      conversationBoundsAt = now
      return bounds
    }

    function placeEditor(row, box, mode = 'reply', style = 'frame', blockKind = null, blocks = null, controller = null) {
      const layer = ensureEditorLayer()
      if (box.parentElement !== layer) layer.appendChild(box)
      const placement = readStoredEditorPlacement() ?? 'overlay'
      const legacy = placement === 'legacy'
      const inline = placement === 'inline'
      // Every fixed mode is clamped to the conversation band by default; the
      // in-page mode keeps its page coordinates and page scroll.
      const clamped = !inline
      if (legacy) style = 'frame'
      if (inline) layer.dataset.dshetInline = '1'
      else delete layer.dataset.dshetInline
      const rowRect = row.getBoundingClientRect()
      const bubble = bubbleFor(row, mode, blockKind)
      const storedStyle = readStoredEditorStyle()
      if (storedStyle !== null) style = storedStyle
      const chipsInBox = typeof box.querySelector === 'function' ? box.querySelector('.dshet-chips') : null
      const minimumHeight = chipsInBox !== null && chipsInBox !== undefined ? 190 : 150
      const viewport = viewportSize()
      const margin = 8
      const area = typeof box.querySelector === 'function' ? box.querySelector('textarea') : null
      const frame = typeof box.querySelector === 'function' ? box.querySelector('.dshet-frame') : null
      const allBox = typeof box.querySelector === 'function' ? box.querySelector('.dshet-all') : null
      const heightMode = readStoredEditorHeight() ?? 'fill'
      if (frame !== null && frame !== undefined) frame.style.display = style === 'frame' ? '' : 'none'
      box.style.boxShadow = 'none'
      const footerEl = typeof box.querySelector === 'function' ? box.querySelector('.dshet-footer') : null
      if (footerEl !== null && footerEl !== undefined && !(style === 'center' && !inline)) {
        footerEl.style.position = ''
        footerEl.style.height = ''
        footerEl.style.marginTop = ''
        footerEl.style.borderRadius = ''
      }
      if (style === 'center' && !inline) {
        // A large centred panel, the first shape that shipped. The textarea
        // grows with its content; the original message stays where it is.
        delete box.dataset.dshetInplace
        if (area !== null && area !== undefined) {
          area.style.position = ''
          area.style.left = ''
          area.style.top = ''
          area.style.width = ''
          area.style.height = ''
          area.style.maxHeight = ''
          area.style.background = ''
          area.style.paddingBottom = '16px'
          fitEditorHeight(area)
          const centerFooter = typeof box.querySelector === 'function' ? box.querySelector('.dshet-footer') : null
          if (centerFooter !== null && centerFooter !== undefined) {
            centerFooter.style.position = 'static'
            centerFooter.style.height = '46px'
            centerFooter.style.marginTop = '0'
            centerFooter.style.borderRadius = '0 0 16px 16px'
          }
        }
        const width = viewport.width > 0 ? Math.max(320, Math.min(1400, viewport.width - margin * 2)) : Math.max(320, rowRect.width)
        box.style.boxSizing = 'border-box'
      box.style.width = `${Math.round(width)}px`
        box.style.left = `${Math.round(viewport.width > 0 ? (viewport.width - width) / 2 : rowRect.left)}px`
        const bounds = conversationBounds(row)
        const topLimit = bounds.top + margin
        const bottomLimit = (bounds.bottom > 0 ? bounds.bottom : viewport.height) - margin
        const usable = bottomLimit > topLimit ? bottomLimit - topLimit : 0
        box.style.height = ''
        box.style.maxHeight = usable > 0
          ? `${Math.max(180, usable)}px`
          : viewport.height > 0
            ? `${Math.max(180, viewport.height - margin * 2)}px`
            : ''
        const measured = box.getBoundingClientRect()
        const height = (measured && measured.height) || box.offsetHeight || 0
        const top = usable > 0 && height > 0
          ? Math.round(Math.max(topLimit, Math.min(topLimit + (usable - height) / 2, bottomLimit - height)))
          : viewport.height > 0 && height > 0
            ? Math.round(Math.max(margin, Math.min((viewport.height - height) / 2, viewport.height - height - margin)))
            : Math.round((rowRect.bottom || 0) + 6)
        box.style.top = `${top}px`
        return
      }
      // `bubble` and `frame` both paint over the message, so the textarea gets
      // an opaque surface: the recorded text underneath must not show through
      // the draft. `frame` outlines the whole row; `bubble` outlines just the
      // message block.
      box.dataset.dshetInplace = '1'
      // A full opaque backdrop: the frame covers the whole row, so the host's
      // status line and action bar underneath must not show through either.
      const opaque = pageBackground()
      box.style.background = opaque
      if (area !== null && area !== undefined) {
        area.style.background = opaque
      }
      // A reply edit is scoped to the selected block (answer text or reasoning),
      // not to the whole assistant row: the other blocks stay out of the frame.
      const base = legacy ? rowRect : mode === 'reply' ? bubble.rect : style === 'frame' ? rowRect : bubble.rect
      let width = base.width
      let alignedLeft = null
      const fillAllView = allBox !== null && allBox !== undefined && heightMode !== 'content'
      if (fillAllView) {
        // The all-blocks page lines up with the composer card: same left edge,
        // same width, so the two boxes read as one column.
        const aligned = conversationBounds(row)
        if (aligned.composerWidth > 0) {
          width = aligned.composerWidth
          alignedLeft = aligned.composerLeft
        }
      }
      if (!fillAllView && mode === 'reply' && typeof rowRect.width === 'number' && rowRect.width > width) {
        // A reply block is narrower than the conversation row; the editor gets
        // the full row width so the text is not squeezed into the bubble.
        width = rowRect.width
      }
      let left = alignedLeft === null ? base.left : alignedLeft
      if (inline) {
        const pageX = typeof window !== 'undefined' && typeof window.scrollX === 'number' ? window.scrollX : 0
        left += pageX
        if (viewport.width > 0) width = Math.min(width, viewport.width - margin * 2)
      } else if (viewport.width > 0) {
        width = Math.min(width, viewport.width - margin * 2)
        left = Math.max(margin, Math.min(left, viewport.width - width - margin))
      }
      box.style.boxSizing = 'border-box'
      box.style.width = `${Math.round(width)}px`
      box.style.left = `${Math.round(left)}px`
      // The host's action strip sits under the reported bubble. Extend the
      // editor down to the row's bottom so that strip is covered, and the
      // footer controls end up where those host buttons used to be.
      const baseBottom = typeof base.bottom === 'number' ? base.bottom : base.top + base.height
      const rowBottom = typeof rowRect.bottom === 'number' ? rowRect.bottom : rowRect.top + rowRect.height
      // The action strip can be a sibling of the row (the turn-tail row), not
      // its child. Find the nearest one from our own injected action buttons
      // and include its bottom in the cover.
      let actionBottom = 0
      if (legacy) try {
        const actions = document.querySelectorAll('.dshet-action')
        for (const action of actions) {
          const bar = action.parentElement
          if (bar === null || bar === undefined || typeof bar.getBoundingClientRect !== 'function') continue
          const rect = bar.getBoundingClientRect()
          if (rect.top >= rowRect.top - 8 && rect.top <= rowRect.bottom + 160) {
            actionBottom = Math.max(actionBottom, rect.bottom)
          }
        }
      } catch {}
      // The action strip is rendered as its own turn-tail row under the
      // message row. Use that row's bottom; if the host renders it in a shape
      // we cannot identify, reserve one action-band height so the buttons can
      // never peek out underneath the opaque editor.
      let tailBottom = 0
      if (legacy) try {
        const tails = document.querySelectorAll('[data-chat-flow-kind="turn-tail"]')
        for (const tail of tails) {
          if (typeof tail.getBoundingClientRect !== 'function') continue
          const rect = tail.getBoundingClientRect()
          if (rect.top >= rowRect.top - 8 && rect.top <= rowRect.bottom + 200) {
            tailBottom = Math.max(tailBottom, rect.bottom)
          }
        }
      } catch {}
      const coverBottom = Math.max(rowBottom, actionBottom, tailBottom)
      const coveredHeight = Math.max(base.height, coverBottom - base.top + 48)
      // Non-legacy modes hug the content: the box ends right after the last
      // line plus the control band, instead of stretching to the row bottom.
      const FOOTER_BAND = 46
      const boxRect0 = typeof box.getBoundingClientRect === 'function' ? box.getBoundingClientRect() : { top: base.top }
      const chipStrip0 = typeof box.querySelector === 'function' ? box.querySelector('.dshet-chips') : null
      const chipBottom0 = chipStrip0 === null || chipStrip0 === undefined || typeof chipStrip0.getBoundingClientRect !== 'function'
        ? 0
        : Math.max(0, chipStrip0.getBoundingClientRect().bottom - boxRect0.top + 8)
      const headerOffset = Math.max(38, chipBottom0, bubble.rect.top - base.top)
      let contentHeight = Math.round(base.height)
      if (area !== null && area !== undefined && (allBox === null || allBox === undefined)) {
        try {
          const previousValue = area.value
          const previousHeight = area.style.height
          // Assigning `value` drops a textarea's scroll position to the top -
          // even when the assignment is only a measuring detour. Verified in
          // Chromium: the SAME string keeps the scroll, a DIFFERENT string
          // resets it to 0, and putting the original back does not bring it
          // back. The "turn max" pass below writes every other block's text into
          // this field, so every cache-miss layout (the first one, a page
          // switch, and every pass while the turn's blocks change - i.e. while
          // the model streams) threw the reader back to the top. That is what
          // "the 思维链/正文 page cannot be scrolled down" was: the wheel worked,
          // the position did not survive the next layout.
          const previousScroll = typeof area.scrollTop === 'number' ? area.scrollTop : 0
          const measure = (text) => {
            area.value = text
            // The settled height: one pass reads a line short (see
            // settleAreaHeight), and this number decides the whole box. The
            // scroller is the box itself, so its position is kept too.
            return Math.round(withScrollKept(box, () => settleAreaHeight(area)))
          }
          const own = measure(previousValue)
          if (own > 0) contentHeight = own
          // "Turn max" pins the box to the tallest block of the turn, so
          // switching between a short answer and a long thought does not resize
          // the frame under the user's hands. The measurement is cached: doing
          // it for every block on every scroll frame is what made the editor
          // drag while the conversation moved.
          if (heightMode !== 'content' && Array.isArray(blocks)) {
            const key = `${Math.round(area.clientWidth || 0)}|${blocks.map((block) => `${block.seq ?? ''}:${block.index}:${typeof block.text === 'string' ? block.text.length : 0}`).join(',')}`
            if (maxHeightCache.key === key) {
              contentHeight = Math.max(contentHeight, maxHeightCache.value)
            } else {
              let tallest = 0
              for (const block of blocks) {
                if (block === null || block === undefined || typeof block.text !== 'string') continue
                const measured = measure(block.text)
                if (measured > tallest) tallest = measured
              }
              maxHeightCache = { key, value: tallest }
              if (tallest > contentHeight) contentHeight = tallest
            }
          }
          area.value = previousValue
          area.style.height = previousHeight
          if (typeof area.scrollTop === 'number' && area.scrollTop !== previousScroll) {
            area.scrollTop = previousScroll
          }
        } catch {}
      }
      // Every mode hugs the measured content; `coveredHeight` is only a
      // fallback for a host whose textarea cannot be measured.
      // While the editor is open its height FOLLOWS the draft: more lines grow
      // the box, deleting lines shrinks it - but never below the height it had
      // when it opened, and never past the composer below or the conversation
      // top above. The floor belongs to the whole edit (a page switch keeps it)
      // and only a save or a cancel ends it.
      const baseHeight =
        controller !== null &&
        controller !== undefined &&
        typeof controller.editorBaseHeight === 'number' &&
        controller.editorBaseHeight > 0
          ? controller.editorBaseHeight
          : null
      let height = Math.max(minimumHeight, contentHeight + headerOffset + FOOTER_BAND, baseHeight === null ? 0 : baseHeight)
      let clampedTop = null
      if (clamped) {
        const bounds = conversationBounds(row)
        const bottomLimit = (bounds.bottom > 0 ? bounds.bottom : viewport.height) - margin
        const topLimit = bounds.top + margin
        if (bottomLimit > topLimit) {
          // All-blocks mode shows one page of blocks behind ONE scrollbar: it
          // fills the WHOLE band (not just the message's own position), so the
          // top touches the conversation edge and the bottom the composer.
          const fillAll = allBox !== null && allBox !== undefined && heightMode !== 'content'
          const band = bottomLimit - topLimit
          if (fillAll) {
            clampedTop = topLimit
            height = Math.max(minimumHeight, band)
          } else if (height <= band) {
            // It fits: grow DOWN from the row while there is room for it, and
            // when there is not, keep the bottom at the composer edge and grow
            // UP instead - the direction follows the space, the box never covers
            // the composer and never leaves the conversation's top.
            const room = bottomLimit - Math.max(base.top, topLimit)
            clampedTop = height <= room ? Math.max(base.top, topLimit) : Math.max(topLimit, bottomLimit - height)
            height = Math.min(height, band)
          } else {
            // Taller than the whole band: fill it and let the field scroll.
            clampedTop = topLimit
            height = Math.max(minimumHeight, band)
          }
        }
      }
      if (!inline && !clamped && viewport.height > 0) height = Math.min(height, Math.max(minimumHeight, viewport.height - margin * 2))
      height = Math.max(minimumHeight, height)
      if (baseHeight === null && controller !== null && controller !== undefined) {
        // The first layout of this open fixes the floor: from here on the box
        // may grow and shrink with the draft, but not below this.
        controller.editorBaseHeight = height
      }
      box.style.height = `${height}px`
      box.style.maxHeight = ''
      let top = clampedTop === null ? base.top : clampedTop
      if (inline) {
        const pageY = typeof window !== 'undefined' && typeof window.scrollY === 'number' ? window.scrollY : 0
        top += pageY
      } else if (viewport.height > 0) {
        top = Math.max(margin, Math.min(top, viewport.height - height - margin))
      }
      box.style.top = `${Math.round(top)}px`
      if (allBox !== null && allBox !== undefined) {
        allBox.style.position = 'absolute'
        allBox.style.left = '8px'
        allBox.style.right = '8px'
        // The all-blocks page has its own sticky outline, so it does not need
        // the 38px control header the single-block editor reserves.
        allBox.style.top = '6px'
        allBox.style.bottom = `${FOOTER_BAND + 8}px`
        allBox.style.overflowY = 'auto'
        // The container is now laid out; re-measure each block so the document
        // is exactly as tall as its text and the ONE scrollbar appears when it
        // overflows the band.
        if (typeof allBox.querySelectorAll === 'function') {
          withScrollKept(allBox, () => {
            for (const blockArea of allBox.querySelectorAll('.dshet-all-area')) settleAreaHeight(blockArea)
          })
        }
      } else if (area !== null && area !== undefined) {
        const offsetLeft = Math.max(0, bubble.rect.left - base.left)
        // Reserve a header band for the controls; when the prompt carries image
        // chips they sit above the text, so the text starts below them too.
        const offsetTop = headerOffset
        // The control band is painted over the box's bottom edge, so the field
        // has to stop above it: the old `height - offsetTop - 8` let the field
        // run 40px under the footer, and the last lines of a long block were
        // covered for good (the field scrolled, the footer never moved).
        const footerHeight =
          footerEl !== null && footerEl !== undefined && typeof footerEl.offsetHeight === 'number' && footerEl.offsetHeight > 0
            ? footerEl.offsetHeight
            : FOOTER_BAND
        const available = Math.max(40, height - offsetTop - footerHeight)
        area.style.position = 'absolute'
        area.style.boxSizing = 'border-box'
        area.style.left = `${Math.round(offsetLeft)}px`
        area.style.top = `${Math.round(offsetTop)}px`
        area.style.width = `${Math.round(mode === 'reply' ? Math.max(80, width - offsetLeft - 8) : Math.max(80, Math.min(bubble.rect.width, width - offsetLeft)))}px`
        // Never let the textarea paint outside the box: when the measured
        // content is taller than the box (viewport-capped overlay), it scrolls
        // inside instead of spilling past the border.
        area.style.height = `${Math.round(Math.max(32, Math.min(contentHeight, available)))}px`
        area.style.maxHeight = 'none'
        area.style.padding = ''
        area.style.paddingBottom = '8px'
      }
      box.style.borderRadius = ''
      try {
        const skin = getComputedStyle(bubble.element)
        if (skin.borderRadius && skin.borderRadius !== '0px') box.style.borderRadius = skin.borderRadius
      } catch {
        /* a detached node keeps the stylesheet skin */
      }
    }

    /**
     * Run `work` without losing the reader's place.
     *
     * Measuring a textarea means collapsing it (`height: auto`), which shrinks
     * the document; the browser then clamps the scroller's `scrollTop` to the
     * new maximum, and the position is gone even though the heights come back.
     * The host re-renders constantly (a streaming turn, a state refresh), so
     * this is what "scroll down and it jumps back up" was. The position is
     * captured before the work and put back after.
     *
     * @param scroller - the scrolling element that holds the textareas.
     * @param work - the measuring pass.
     * @returns whatever `work` returned.
     */
    function withScrollKept(scroller, work) {
      const keep =
        scroller !== null && scroller !== undefined && typeof scroller.scrollTop === 'number'
          ? scroller.scrollTop
          : null
      const result = work()
      if (keep !== null && scroller.scrollTop !== keep) scroller.scrollTop = keep
      return result
    }

    /**
     * The content height of one textarea, SETTLED and applied.
     *
     * One measurement is not enough. With the height reset to `auto`, the first
     * read comes back exactly one line short - the wrap is resolved after the
     * style write - and the element is then pinned to that height with
     * `overflow:hidden`. In the all-blocks page that made the last line of a
     * long body unreachable: the surrounding scroller's height is computed from
     * the pinned value, so it cannot scroll to a line the textarea is hiding
     * (reported from the field: a long 正文 could not be scrolled past).
     *
     * Measured live: first read 2392, second read 2415, line height 23px.
     *
     * @param area - the textarea to measure and size.
     * @returns the applied height in CSS pixels, or 0 when unmeasurable.
     */
    function settleAreaHeight(area) {
      if (area === null || area === undefined || typeof area.scrollHeight !== 'number') return 0
      area.style.height = 'auto'
      const first = area.scrollHeight
      if (!(typeof first === 'number' && first > 0)) return 0
      area.style.height = `${first}px`
      const settled = area.scrollHeight
      const height = typeof settled === 'number' && settled > first ? settled : first
      area.style.height = `${height}px`
      return height
    }

    /**
     * One block's identity inside the editor's draft store.
     *
     * A turn's blocks are addressed by (seq, index): the same block reached from
     * the 正文 page and from its sub-page inside 全部 must resolve to the SAME
     * key, or an unsaved edit disappears when the user switches pages.
     *
     * @param block - an editor block (seq, index).
     * @returns the stable key.
     */
    function blockDraftKey(block) {
      if (block === null || block === undefined) return ''
      return `${typeof block.seq === 'number' ? block.seq : ''}:${block.index}`
    }

    // Grow the textarea to its content, the way a normal input box behaves.
    // Without this it sits at a fixed `rows` height and a two-line edit floats
    // in half an empty box. The stylesheet owns the limits (`min-height`,
    // `max-height`); the element only ever gets the measured height, and the
    // `+2` is the top and bottom border `scrollHeight` does not count.
    let maxHeightCache = { key: '', value: 0 }

    function fitEditorHeight(area) {
      if (typeof area.closest === 'function' && area.closest('[data-dshet-inplace="1"]') !== null) return
      const scroller =
        typeof area.closest === 'function'
          ? area.closest('.dshet-all') ?? area.closest('.dshet-editor')
          : null
      const height = withScrollKept(scroller, () => settleAreaHeight(area))
      if (height > 0) area.style.height = `${height + 2}px`
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
        action(event)
      }
      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (pressed) {
          pressed = false
          return
        }
        action(event)
      }
    }

    // The editor is plain DOM on purpose: the host row is a React subtree and
    // injecting a second controlled tree into it would fight its reconciler.
    // The draft is mirrored into the controller on every input event, so a
    // host re-render that wipes the textarea cannot lose what was typed.
    // --- block chips ----------------------------------------------------------
    //
    // A message's non-text blocks, as the editor shows them: one chip per block,
    // each with what the block itself reported about itself (a name, a size, and
    // whether its bytes are reachable) and a remove button. Nothing here reads a
    // block TYPE: a chip is drawn from the fields a block carries, so a block
    // kind the platform adds later shows up with its own name and needs no
    // change in this file.

    /** One chip's display fields, taken from whatever the block said about itself. */
    function chipOf(block) {
      const name = typeof block.name === 'string' && block.name !== '' ? block.name : null
      const mediaType = typeof block.mediaType === 'string' && block.mediaType !== '' ? block.mediaType : null
      const type = typeof block.type === 'string' && block.type !== '' ? block.type : 'block'
      const bytes = typeof block.bytes === 'number' ? block.bytes : null
      return { label: name !== null ? name : mediaType !== null ? mediaType : type, bytes }
    }

    /**
     * The block list an editor starts from: every block of the message, kept.
     *
     * A reply starts from none. What a reply carries beside its text - tool
     * calls, reasoning - cannot survive a replacement (their results no longer
     * hold), so offering a chip for them would promise something the edit cannot
     * keep; the editor warns about them instead.
     */
    function blocksToParts(target, sessionId) {
      if (!target || target.mode !== 'prompt') return []
      const blocks = Array.isArray(target.blocks) ? target.blocks : []
      const parts = []
      for (const block of blocks) {
        if (!block || typeof block.index !== 'number') continue
        const chip = chipOf(block)
        parts.push({
          keep: block.index,
          key: `k${block.index}`,
          label: chip.label,
          bytes: chip.bytes,
          thumbnail: block.preview === true ? previewUrl(sessionId, target.seq, block.index) : null,
        })
      }
      return parts
    }

    /** Where one stored block's bytes are read from, for its thumbnail. */
    function previewUrl(sessionId, seq, index) {
      return `${ROUTE_PREFIX}/attachment?sessionId=${encodeURIComponent(sessionId)}&seq=${seq}&index=${index}`
    }

    /** A byte count a human reads at a glance. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB']
      let value = bytes / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
    }

    /**
     * One picked file's bytes, base64, without the Data URL prefix.
     *
     * Read here rather than at save time so a save is one request: the payload
     * travels with the revision the user committed to.
     */
    function readAsBase64(file, done) {
      if (typeof FileReader !== 'function') {
        done(null)
        return
      }
      try {
        const reader = new FileReader()
        reader.onload = () => {
          const result = typeof reader.result === 'string' ? reader.result : ''
          const comma = result.indexOf(',')
          done(comma === -1 ? null : result.slice(comma + 1))
        }
        reader.onerror = () => done(null)
        reader.readAsDataURL(file)
      } catch {
        done(null)
      }
    }

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
        // Whether chips are drawn at all: a host that cannot admit blocks asks
        // for the warning instead, and the box has to change with that answer.
        view.attachmentsOk === true ? 'A' : 'a',
        // The block list itself. Removing a chip and adding one both change what
        // saving would write, so both have to redraw the strip - and the chip
        // keys are enough to tell one list from another.
        view.parts.map((part) => part.key).join('.'),
        // The mode itself: leaving the all-blocks view must rebuild even when the
        // single block that comes back is the one that was selected before it.
        view.allBlocks === true ? 'all' : 'one',
        // The selected reply block: switching blocks has to rebuild the box.
        view.blockIndex === null || view.blockIndex === undefined ? '' : String(view.blockIndex),
        view.targetSeq === null || view.targetSeq === undefined ? '' : String(view.targetSeq),
      ].join('|')
    }

    // Every string the editor shows depends on what is being edited: a prompt is
    // re-run, a reply is replaced. Keeping them in one place keeps the two modes
    // from drifting apart in wording.
    function editorTexts(t, target) {
      const reply = target.mode === 'reply'
      const block = reply && target.patch === true
      return {
        title: t(reply ? 'editor.title-reply' : 'editor.title'),
        placeholder: t(block ? 'editor.placeholder-block' : reply ? 'editor.placeholder-reply' : 'editor.placeholder'),
        warn: t(reply ? 'editor.warn-reply' : 'editor.warn.attachments'),
        // Saving writes the revision into the context; only the opt-in config asks
        // the model again, and the button says which one will happen.
        save: t(reply ? 'editor.save-reply' : 'editor.save'),
      }
    }

    /**
     * The chips: one per block on the block list.
     *
     * A chip IS the block's presence in the edit. Removing it takes the block
     * off the list, and a block that is not on the list is not written when the
     * carrier is rebuilt - the whole mechanism, and the same one for a picture,
     * a file and whatever the platform carries next. A chip draws itself from
     * the bytes the block already has, and gives up on its thumbnail when the
     * browser says they are not a picture: no type is consulted either way.
     */
    function editorChips(controller, view, t) {
      const strip = document.createElement('div')
      strip.className = 'dshet-chips'
      for (const part of view.parts) {
        const chip = document.createElement('div')
        chip.className = 'dshet-chip'
        chip.dataset.dshetChip = part.key
        const drawable = typeof part.thumbnail === 'string' && part.thumbnail !== '' &&
          (typeof part.bytes !== 'number' || part.bytes <= MAX_THUMB_BYTES)
        if (drawable) {
          const image = document.createElement('img')
          image.className = 'dshet-thumb'
          image.alt = ''
          image.src = part.thumbnail
          image.addEventListener('error', () => {
            const parent = image.parentElement
            if (typeof image.remove === 'function') image.remove()
            else if (parent !== null && parent !== undefined && typeof parent.removeChild === 'function') parent.removeChild(image)
          })
          chip.appendChild(image)
        }
        const label = document.createElement('span')
        label.className = 'dshet-chip-label'
        label.textContent = part.label
        chip.appendChild(label)
        const size = formatBytes(part.bytes)
        if (size !== '') {
          const measured = document.createElement('span')
          measured.className = 'dshet-chip-size'
          measured.textContent = size
          chip.appendChild(measured)
        }
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'dshet-chip-remove'
        remove.textContent = '×'
        remove.title = t('editor.attach.remove')
        remove.setAttribute('aria-label', t('editor.attach.remove'))
        remove.disabled = view.pending
        pressable(remove, () => controller.removePart(part.key))
        chip.appendChild(remove)
        strip.appendChild(chip)
      }
      return strip
    }

    /** The FileList of a paste/drop payload, without assuming the event shape. */
    function filesFromData(data) {
      if (data === null || data === undefined) return []
      try {
        return data.files === null || data.files === undefined ? [] : Array.prototype.slice.call(data.files)
      } catch {
        return []
      }
    }

    /**
     * The add/replace entry: a picker that puts a block on the list.
     *
     * Drawn only when the host answered that it can admit a block. A deployment
     * with no attachment store gets no picker, because a picker that cannot be
     * honoured is worse than none - the warning below says what a save will
     * drop instead.
     */
    function attachEntry(controller, view, t) {
      const row = document.createElement('div')
      row.className = 'dshet-attach-row'
      const picker = document.createElement('input')
      picker.type = 'file'
      picker.multiple = true
      picker.className = 'dshet-attach-input'
      picker.style.display = 'none'
      picker.addEventListener('change', () => {
        controller.attachFiles(picker.files)
        // Cleared so the same file can be picked again after a removal.
        try {
          picker.value = ''
        } catch {
          /* not every input lets this be written */
        }
      })
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'dshet-attach'
      add.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1.3"><path d="M8 2V14" stroke="currentColor"></path><path d="M2 8H14" stroke="currentColor"></path></svg>'
      add.setAttribute('aria-haspopup', 'listbox')
      add.title = t('editor.attach.add')
      add.setAttribute('aria-label', t('editor.attach.add'))
      add.disabled = view.pending
      pressable(add, () => {
        if (typeof picker.click === 'function') picker.click()
      })
      row.appendChild(picker)
      row.appendChild(add)
      return row
    }

    function renderEditor(row, controller, view, t) {
      const target = view.editing
      const texts = editorTexts(t, target)
      const marker = editorMarker(target, view)
      const existing = controller.editorBox !== null && controller.editorBox.isConnected === true
        ? controller.editorBox
        : null
      if (existing && existing.dataset.dshetFor === marker) {
        placeEditor(row, existing, controller.editorMode, controller.editorStyle, controller.editorBlockKind, controller.editorBlocks, controller)
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
      // The frame is a child, not the box's own border: host skins mark the
      // editor chrome `!important` and win the cascade against the box itself,
      // but they cannot name this child. It draws the blue outline of the
      // reference UI on top of whatever border the skin puts on the box.
      const frame = document.createElement('span')
      frame.className = 'dshet-frame'
      frame.style.position = 'absolute'
      frame.style.inset = '-1px'
      frame.style.border = '2px solid #4a7dff'
      frame.style.borderRadius = 'inherit'
      frame.style.boxSizing = 'border-box'
      frame.style.pointerEvents = 'none'
      frame.style.zIndex = '3'
      box.appendChild(frame)

      // A reply on the patch path may carry several editable blocks (answer
      // text and reasoning). The picker chooses which one this save targets;
      // every option carries the block's CURRENT projected text, so switching
      // never shows the recorded original over a landed patch.
      if (target.mode === 'reply' && target.patch === true && Array.isArray(target.blocks) && target.blocks.length >= 1) {
        const picker = document.createElement('label')
        picker.className = 'dshet-pick'
        const caption = document.createElement('span')
        caption.className = 'dshet-sr-only'
        caption.textContent = t('editor.block')
        const select = document.createElement('select')
        select.className = 'dshet-select'
        select.disabled = view.pending || view.confirming
        select.setAttribute('aria-label', t('editor.block'))
        // A single reply can carry several answer texts and several reasoning
        // blocks; number the labels so each one is addressable in the picker.
        const totals = {}
        for (const block of target.blocks) totals[block.kind] = (totals[block.kind] ?? 0) + 1
        const seen = {}
        for (const block of target.blocks) {
          const option = document.createElement('option')
          option.value = typeof block.seq === 'number' ? `${block.seq}:${block.index}` : String(block.index)
          const kind = block.kind === 'reasoning' ? 'editor.block.reasoning' : 'editor.block.text'
          seen[block.kind] = (seen[block.kind] ?? 0) + 1
          option.textContent = totals[block.kind] > 1 ? `${t(kind)} ${seen[block.kind]}` : t(kind)
          option.selected = block.index === view.blockIndex
          select.appendChild(option)
        }
        // "All blocks" is always offered for a multi-block turn, not only once
        // it is already active - otherwise there is no way to select it.
        if (target.blocks.length > 1) {
          const allOption = document.createElement('option')
          allOption.value = 'all'
          allOption.textContent = t('editor.block.all')
          select.appendChild(allOption)
        }
        if (view.allBlocks === true) {
          select.value = 'all'
        } else if (view.blockIndex !== null && view.blockIndex !== undefined) {
          const current = target.blocks.find((block) => block.index === view.blockIndex && (view.targetSeq === null || view.targetSeq === undefined || block.seq === undefined || block.seq === view.targetSeq))
          select.value = current !== undefined && typeof current.seq === 'number' ? `${current.seq}:${current.index}` : String(view.blockIndex)
        }
        select.addEventListener('change', () => controller.selectBlock(select.value))
        picker.appendChild(caption)
        picker.appendChild(select)
        box.appendChild(picker)

        // Adding a block of either kind, right after the one being edited. The
        // block is a draft until the save, and saving it blank simply does not
        // record it.
        const addBar = document.createElement('span')
        addBar.className = 'dshet-addbar'
        for (const kind of ['text', 'reasoning']) {
          const add = document.createElement('button')
          add.type = 'button'
          add.className = 'dshet-addblock dshet-tail-action'
          add.setAttribute('data-dshet-add', kind)
          add.textContent = t(kind === 'reasoning' ? 'editor.add-reasoning-short' : 'editor.add-short')
          add.title = t(kind === 'reasoning' ? 'editor.add-reasoning' : 'editor.add-text')
          add.disabled = view.pending || view.confirming
          add.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            controller.addBlock(kind)
          })
          addBar.appendChild(add)
        }
        box.appendChild(addBar)
      }

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
        const row = controller.editorRow
        const box = controller.editorBox
        if (row !== null && box !== null && box.isConnected === true) placeEditor(row, box, controller.editorMode, controller.editorStyle, controller.editorBlockKind, controller.editorBlocks, controller)
      })
      area.addEventListener('compositionend', () => {
        fitEditorHeight(area)
        const row = controller.editorRow
        const box = controller.editorBox
        if (row !== null && box !== null && box.isConnected === true) placeEditor(row, box, controller.editorMode, controller.editorStyle, controller.editorBlockKind, controller.editorBlocks, controller)
      })
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
          const live = liveView()
          if (live !== null && live !== undefined && live.confirming === true) controller.confirm()
          else controller.review()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          const live = liveView()
          if (live !== null && live !== undefined && live.confirming === true) controller.back()
          else controller.close()
        }
      })
      box.appendChild(area)

      // "All blocks": every reasoning and text block of the turn on one page,
      // each in its own textarea under a light separator.
      if (view.allBlocks === true && Array.isArray(target.blocks)) {
        const allBox = document.createElement('div')
        allBox.className = 'dshet-all'
        // A sticky outline over the page: one chip per block that scrolls the
        // container to it, so the document keeps its single scrollbar and still
        // has navigation.
        const nav = document.createElement('div')
        nav.className = 'dshet-all-nav'
        const totals = {}
        for (const block of target.blocks) totals[block.kind] = (totals[block.kind] ?? 0) + 1
        const seen = {}
        for (const block of target.blocks) {
          const key = `${typeof block.seq === 'number' ? block.seq : ''}:${block.index}`
          const section = document.createElement('div')
          section.className = 'dshet-all-block'
          const head = document.createElement('div')
          head.className = 'dshet-all-head'
          const label = document.createElement('span')
          seen[block.kind] = (seen[block.kind] ?? 0) + 1
          const kindKey = block.kind === 'reasoning' ? 'editor.block.reasoning' : 'editor.block.text'
          const labelText = totals[block.kind] > 1 ? `${t(kindKey)} ${seen[block.kind]}` : t(kindKey)
          label.textContent = labelText
          const navButton = document.createElement('button')
          navButton.type = 'button'
          navButton.textContent = labelText
          navButton.addEventListener('click', () => {
            if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'start' })
            else allBox.scrollTop = section.offsetTop ?? 0
          })
          nav.appendChild(navButton)
          const line = document.createElement('span')
          line.className = 'dshet-all-line'
          head.appendChild(label)
          head.appendChild(line)
          const blockArea = document.createElement('textarea')
          blockArea.className = 'dshet-all-area'
          blockArea.rows = 1
          blockArea.spellcheck = false
          blockArea.style.overflow = 'hidden'
          blockArea.style.position = 'static'
          blockArea.style.left = 'auto'
          blockArea.style.top = 'auto'
          blockArea.value = controller.draftOfBlock(block)
          blockArea.disabled = view.pending || view.confirming
          const grow = () =>
            withScrollKept(
              typeof blockArea.closest === 'function' ? blockArea.closest('.dshet-all') : null,
              () => settleAreaHeight(blockArea),
            )
          blockArea.addEventListener('input', () => {
            controller.setDraftFor(block, blockArea.value)
            grow()
          })
          section.appendChild(head)
          section.appendChild(blockArea)
          allBox.appendChild(section)
          // Only now is the textarea in the document, so `scrollHeight` is the
          // real content height; measuring before the append returned 0 and the
          // block stayed 32px tall with its text clipped.
          grow()
        }
        allBox.insertBefore(nav, allBox.firstChild)
        box.appendChild(allBox)
        area.style.display = 'none'
      }

      // Input parity with the composer: a screenshot pasted from the clipboard
      // and files dropped onto the box join the same chip list as the picker.
      // Reply edits cannot carry blocks, so the handlers exist only for prompts
      // whose host proved it can keep them.
      if (target.mode === 'prompt' && view.attachmentsOk === true) {
        area.addEventListener('paste', (event) => {
          const files = filesFromData(event.clipboardData)
          if (files.length === 0) return
          event.preventDefault()
          controller.attachFiles(files)
        })
        box.addEventListener('dragover', (event) => {
          event.preventDefault()
          box.dataset.dshetDrop = '1'
        })
        box.addEventListener('dragleave', () => {
          delete box.dataset.dshetDrop
        })
        box.addEventListener('drop', (event) => {
          event.preventDefault()
          delete box.dataset.dshetDrop
          const files = filesFromData(event.dataTransfer)
          if (files.length > 0) controller.attachFiles(files)
        })
      }

      // The blocks this message carries, each one a chip the user can remove,
      // and the entry that adds another. Drawn only when the host answered that
      // it can admit what a chip promises - otherwise the warning below states
      // what a save would drop, which is exactly what this editor did before
      // blocks travelled at all. A reply never gets chips: what it carries
      // beside its text cannot survive a replacement.
      const chips = target.mode === 'prompt' && view.attachmentsOk === true
      if (chips) {
        if (view.parts.length > 0) box.appendChild(editorChips(controller, view, t))
        box.appendChild(attachEntry(controller, view, t))
      }

      // Only what the user has to know right now: what the replacement will
      // discard, and what went wrong. The running explanation lives in the
      // README and in the buttons' tooltips, the way a normal input box does it.
      if (view.confirming) {
        const note = document.createElement('p')
        note.className = 'dshet-note'
        note.textContent = t(target.mode === 'reply' && target.patch === true ? 'confirm.body-block' : 'confirm.body')
        box.appendChild(note)
      }
      // Shown when saving really would drop something: a reply's tool calls
      // always, and a prompt's blocks when this host cannot carry them.
      if (target.attachments > 0 && !chips && !(target.mode === 'reply' && target.patch === true)) {
        const warn = document.createElement('p')
        warn.className = 'dshet-warn'
        warn.textContent = texts.warn
        box.appendChild(warn)
      }
      // A running turn only blocks the paths that move the surface (a prompt
      // rewrite, or a reply edit on a host without the in-place record). The
      // in-place record appends one event and changes nothing that is already
      // on the surface, so waiting for the agent to finish is not required -
      // the model picks the edit up on its next fold.
      const inPlaceEdit = target.mode === 'reply' && target.patch === true
      const busyBlocked = view.busy === true && !inPlaceEdit
      const failureCode = typeof view.failure === 'string' && view.failure !== ''
        ? view.failure
        : busyBlocked
          ? 'busy'
          : null
      if (failureCode !== null) {
        const error = document.createElement('p')
        error.className = 'dshet-error'
        error.setAttribute('role', 'status')
        const detail = typeof view.failureDetail === 'string' && view.failureDetail !== '' ? view.failureDetail : null
        // The host's own reason is always shown: "invalid" without the sentence
        // that explains it sent the reader back to the UI with nothing to act on.
        error.textContent = detail === null
          ? errorText(t, failureCode)
          : `${errorText(t, failureCode)}（${detail.slice(0, 300)}）`
        box.appendChild(error)
      }

      // Handlers must read the CURRENT controller state: the host may not have
      // rebuilt the button after the first press, and a stale `view.confirming`
      // made the confirmation step a dead end (press again -> review again).
      const liveView = () => (typeof controller.getSnapshot === 'function' ? controller.getSnapshot() : view)

      const footer = document.createElement('div')
      footer.className = 'dshet-footer'
      const footerActions = document.createElement('div')
      footerActions.className = 'dshet-footer-actions'

      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'dshet-btn dshet-btn-icon dshet-btn-cancel'
      const cancelLabel = t('editor.cancel')
      cancel.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9" stroke="currentColor"/><path d="M12.5 3.5l-9 9" stroke="currentColor"/></svg>'
      const cancelText = document.createElement('span')
      cancelText.className = 'dshet-sr-only'
      cancelText.textContent = cancelLabel
      cancel.appendChild(cancelText)
      cancel.title = `${cancelLabel} (Esc)`
      cancel.setAttribute('aria-label', cancelLabel)
      cancel.disabled = view.pending
      pressable(cancel, () => {
        if (view.confirming) controller.back()
        else controller.close()
      })

      const submit = document.createElement('button')
      submit.type = 'button'
      submit.className = 'dshet-btn dshet-btn-primary dshet-btn-save'
      const submitLabel = view.pending
        ? t('editor.pending')
        : view.confirming
          ? t('editor.review')
          : texts.save
      // The official composer uses a bare double-check for confirm, not a black
      // pill. The label stays in the accessible name (and in the test-visible
      // textContent) through a visually hidden span.
      submit.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12.5l4.5 4.5L18 6.5"/><path d="M10 12.5l4.5 4.5L24 6.5"/></svg>'
      const submitText = document.createElement('span')
      submitText.className = 'dshet-sr-only'
      submitText.textContent = submitLabel
      submit.appendChild(submitText)
      submit.title = `${submitLabel} (Enter)`
      submit.setAttribute('aria-label', submitLabel)
      submit.disabled = view.pending || busyBlocked
      pressable(submit, () => {
        const live = liveView()
        if (live !== null && live !== undefined && live.confirming === true) controller.confirm()
        else controller.review()
      })
      if (view.confirming === true) {
        // The save label is visually hidden, so the confirmation step needs a
        // visible state of its own or the first press looks like nothing.
        submit.classList.add('dshet-btn-confirm')
      }

      footerActions.appendChild(cancel)
      // The re-run button belongs to the sibling (dsh-rerun-turn): it appears
      // only when that plugin is mounted, only for a prompt edit, and only
      // outside the confirmation step - the intent is carried through it. Save
      // first, re-run second, always. A reply edit has no re-run here: the
      // action strip of the reply carries the sibling's own button.
      if (target.mode === 'prompt' && view.siblingRerun === 'present' && view.confirming !== true) {
        const rerun = document.createElement('button')
        rerun.type = 'button'
        rerun.className = 'dshet-btn dshet-btn-icon dshet-rerun'
        const rerunLabel = t('editor.rerun')
        rerun.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke-width="1.2"><path d="M13.65 2.6v2.9h-2.9" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M13.3 8a5.3 5.3 0 1 1-1.55-3.75l1.9 1.25" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path></svg>'
        const rerunText = document.createElement('span')
        rerunText.className = 'dshet-sr-only'
        rerunText.textContent = rerunLabel
        rerun.appendChild(rerunText)
        rerun.title = rerunLabel
        rerun.setAttribute('aria-label', rerunLabel)
        rerun.disabled = view.pending
        pressable(rerun, () => controller.reviewRerun())
        footerActions.appendChild(rerun)
      }
      footerActions.appendChild(submit)
      footer.appendChild(footerActions)
      const attachRow = typeof box.querySelector === 'function' ? box.querySelector('.dshet-attach-row') : null
      if (attachRow !== null && attachRow !== undefined) {
        attachRow.style.position = 'static'
        attachRow.style.left = ''
        attachRow.style.bottom = ''
        attachRow.style.margin = '0'
        footer.insertBefore(attachRow, footer.firstChild)
      }
      // The block picker shares the control band and sits at its far right.
      const pickerEl = typeof box.querySelector === 'function' ? box.querySelector('.dshet-pick') : null
      if (pickerEl !== null && pickerEl !== undefined) {
        pickerEl.style.position = 'static'
        pickerEl.style.left = ''
        pickerEl.style.top = ''
        pickerEl.style.marginLeft = 'auto'
        pickerEl.style.marginRight = '0'
        pickerEl.style.display = 'flex'
        pickerEl.style.flex = '0 0 auto'
        pickerEl.style.visibility = ''
        footer.appendChild(pickerEl)
      }
      box.appendChild(footer)

      controller.editorBox = box
      controller.editorRow = row
      controller.editorElement = area
      placeEditor(row, box, controller.editorMode, controller.editorStyle, controller.editorBlockKind, controller.editorBlocks, controller)
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

    // --- projected reply display ---------------------------------------------
    //
    // The host draws a reply from the recorded event, not from the projected
    // message, so a landed patch would be invisible in the transcript. The
    // projection is the model's copy; this is the reader's copy. Text blocks are
    // replaced in place inside the host's own markdown container (the row,
    // actions and tool cards stay untouched); a patched reasoning block gets a
    // small note under the reply, because the host renders reasoning as a
    // collapsed panel that may not be in the DOM at all.

    const PATCH_ATTR = 'data-dshet-patch'
    const patchOriginals = new WeakMap()
    // The text this plugin last painted for a key, so a second edit of the same
    // block can still find the element after the first text replaced the
    // recorded original in the DOM.
    const patchedTexts = new Map()
    // React may re-render the assistant container and reset its attributes and
    // style while leaving the text node we replaced. Remember the element by
    // seq:block so the next pass can restore the marker and, on a later edit,
    // update it without having to re-find the original text (which is gone).
    /**
     * seq -> the container this plugin appended for the blocks the user ADDED to
     * that reply. Kept as a registry rather than found by selector: the host
     * rebuilds rows and a stub/older DOM shape may not answer attribute queries.
     */
    const addedContainers = new Map()

    const patchedElements = new Map()

    function normalizedText(value) {
      return String(value ?? '').replace(/\s+/g, ' ').trim()
    }

    // Markdown syntax is not part of the rendered textContent. Strip the
    // structural characters before comparing, so a reply that uses **bold** or
    // a fenced block still matches its own recorded text.
    function plainText(value) {
      return normalizedText(String(value ?? '').replace(/[`*_#>~[\]()!|]/g, ' ').replace(/\s+/g, ' '))
    }

    // Identity, not display: markdown emphasis (`**1**`) renders as `1。`, and
    // the spaces left by stripping the markers must not defeat the comparison.
    // Whitespace carries no block identity here, so remove it entirely.
    function matchText(value) {
      return plainText(value).replace(/\s+/g, '')
    }

    // What the reader sees for a patched block. The model context keeps the
    // raw Markdown the editor wrote; the transcript should not show the markers
    // as literal text (`**1**`), which is what made a successful edit look like
    // an unrendered draft. This is deliberately minimal: bold, inline code and
    // headings are unwrapped; everything else stays as written.
    function displayText(value) {
      return String(value ?? '')
        .replace(/```[\s\S]*?```/g, (fence) => fence.replace(/^```[^\n]*\n?/gm, '').replace(/```$/gm, ''))
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
    }

    function isMarkdownContainer(el) {
      if (el === null || el === undefined || !el.children) return false
      const kids = el.children
      if (kids.length === 0) return false
      let blocks = 0
      for (const kid of kids) {
        try {
          if (kid.matches && kid.matches('p, pre, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, table')) blocks += 1
        } catch {
          return false
        }
      }
      return blocks >= 1 && blocks * 2 >= kids.length
    }

    function conversationRootForPatches() {
      const root = document.querySelector('[data-slot="main.conversation"], [data-slot="conversation"]')
      return root ?? document.body
    }

    function restorePatchedBlock(el) {
      const saved = patchOriginals.get(el)
      if (saved !== null && saved !== undefined) {
        try {
          if (typeof saved.html === 'string' && saved.html !== '') el.innerHTML = saved.html
          else if (typeof saved.text === 'string') el.textContent = saved.text
        } catch {
          /* a detached row is not worth a throw */
        }
      }
      el.removeAttribute(PATCH_ATTR)
      el.style.whiteSpace = ''
    }

    // A short reply can be a bare text node (or a span) rather than the
    // block-level markdown container the picker looks for. Match the deepest
    // element in the owning row whose whole text is exactly the recorded text;
    // never a button, a timestamp, our own chrome, or an ancestor that merely
    // contains the text.
    function findPatchTextFallback(owner, wanted, previousText = '') {
      if (owner === null || owner === undefined || typeof owner.querySelectorAll !== 'function') return null
      const original = matchText(wanted.original)
      const previous = matchText(previousText)
      if (original === '' && previous === '') return null
      let scope = owner
      try {
        const node = owner.querySelector('[data-slot="conversation.chat.node"]')
        if (node !== null && node !== undefined) scope = node
      } catch {
        /* keep the row as the scope */
      }
      for (const el of scope.querySelectorAll('*')) {
        if (el === scope) continue
        if (el.getAttribute(PATCH_ATTR) !== null) continue
        try {
          if (el.closest('.dshet-editor, .dshet-action, .dshet-pick, button, time') !== null) continue
        } catch {
          continue
        }
        const text = matchText(el.textContent)
        if (text !== original && !(previous !== '' && text === previous)) continue
        let deeper = false
        for (const child of el.children ?? []) {
          if (matchText(child.textContent) === text) {
            deeper = true
            break
          }
        }
        if (!deeper) return el
      }
      return null
    }

    /**
     * The collapsed reasoning header draws its own truncation of the RECORDED
     * text ("思考 · ..."), and when the panel is closed the body is not in the
     * DOM at all - so a patch of the reasoning body alone leaves the edit
     * invisible. Rewrite that snippet too, keeping whatever the host appended
     * (its ellipsis) and its own truncation length.
     */
    function patchReasoningSummary(owner, wanted) {
      if (owner === null || owner === undefined || typeof owner.querySelectorAll !== 'function') return false
      const original = String(wanted.original ?? '')
      const patched = String(wanted.text ?? '')
      if (original === '' || patched === '') return false
      const head = original.slice(0, 12)
      let changed = false
      const apply = (get, set) => {
        const data = String(get() ?? '')
        if (data === '' || !data.includes(head)) return
        // A node holding the whole text gets the whole replacement; a truncated
        // snippet keeps the host's length and gains an ellipsis when the new
        // text is longer.
        const next = data.length >= original.length ? patched : `${patched.slice(0, data.length)}${patched.length > data.length ? '…' : ''}`
        if (next === data) return
        set(next)
        changed = true
      }
      const walk = (node) => {
        for (const child of node.childNodes ?? []) {
          const type = child.nodeType
          if (type === 3) {
            apply(() => child.data, (value) => { child.data = value })
            continue
          }
          if (type !== 1) continue
          try {
            if (typeof child.closest === 'function' && child.closest('.dshet-editor, .dshet-action, .dshet-pick, button, time') !== null) continue
          } catch {
            /* a node without closest is walked anyway */
          }
          const kids = child.childNodes ?? []
          if (kids.length === 0) {
            apply(() => child.textContent, (value) => { child.textContent = value })
            continue
          }
          walk(child)
        }
      }
      walk(owner)
      return changed
    }

    /**
     * The reasoning body on this host is its own row (the flow key carries a
     * `,reasoning` group part), so neither the answer row nor the first chat node
     * the shared fallback picks contains it. Search the whole conversation for
     * the deepest element whose text is the recorded original (or what we last
     * painted there).
     */
    /**
     * EVERY element that shows this reasoning text.
     *
     * Plural on purpose: the host keeps more than one copy of a turn's reasoning.
     * The collapsed process row stays in the DOM with `display: none`, and opening
     * the panel renders a second, visible body. Patching only the first one left
     * the copy the user was looking at showing the recorded text.
     *
     * @param root - the conversation root to search.
     * @param wanted - the patch (`original` text, new `text`).
     * @param previousText - what the patch showed before this pass, if anything.
     * @returns the deepest matching elements, best match first.
     */
    function findReasoningElements(root, wanted, previousText) {
      if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return []
      const original = matchText(wanted.original)
      const previous = matchText(previousText)
      if (original === '' && previous === '') return []
      const found = []
      for (const el of root.querySelectorAll('*')) {
        if (el.getAttribute(PATCH_ATTR) !== null) continue
        try {
          if (el.closest('.dshet-editor, .dshet-action, .dshet-pick, button, time') !== null) continue
        } catch {
          /* a detached node is still a candidate */
        }
        const text = matchText(el.textContent)
        if (text === '') continue
        if (text !== original && !(previous !== '' && text === previous)) continue
        let deeper = false
        for (const child of el.children ?? []) {
          if (matchText(child.textContent) === text) {
            deeper = true
            break
          }
        }
        if (deeper) continue
        found.push({ el, score: Math.abs(text.length - original.length) })
      }
      found.sort((a, b) => a.score - b.score)
      return found.map((entry) => entry.el)
    }

    function findReasoningElement(root, wanted, previousText) {
      if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return null
      const original = matchText(wanted.original)
      const previous = matchText(previousText)
      if (original === '' && previous === '') return null
      let best = null
      let bestScore = Infinity
      for (const el of root.querySelectorAll('*')) {
        if (el.getAttribute(PATCH_ATTR) !== null) continue
        try {
          if (el.closest('.dshet-editor, .dshet-action, .dshet-pick, button, time') !== null) continue
        } catch {
          /* a detached node is still a candidate */
        }
        const text = matchText(el.textContent)
        if (text === '') continue
        if (text !== original && !(previous !== '' && text === previous)) continue
        let deeper = false
        for (const child of el.children ?? []) {
          if (matchText(child.textContent) === text) {
            deeper = true
            break
          }
        }
        if (deeper) continue
        const score = Math.abs(text.length - original.length)
        if (score < bestScore) {
          best = el
          bestScore = score
        }
      }
      return best
    }

    function applyPatchDisplay(snapshot, view, t) {
      // Map a reply seq to the host row that draws it, so a short answer like
      // "好的" cannot be matched in a different row. Fall back to a global
      // search when the row is not mounted (virtualised histories).
      const rowBySeq = new Map()
      // A turn-process row also covers the turn's assistant seq (seqsFor reads
      // its anchor), and it comes before the assistant row in document order.
      // First-win mapping therefore pointed the patch at the process row, whose
      // subtree has no message body: zero matches. Prefer the row that actually
      // draws the message; the process/tail rows are only a last resort.
      const rowRank = new Map()
      try {
        for (const row of document.querySelectorAll('[data-chat-flow-key]')) {
          const key = row.getAttribute('data-chat-flow-key')
          if (!key || !snapshot || !snapshot.nodes || typeof snapshot.nodes.get !== 'function') continue
          const node = snapshot.nodes.get(key)
          if (!node) continue
          const rank = node.kind === 'assistant-step' ? 0 : node.kind === 'user' ? 1 : 2
          for (const seq of seqsFor(node)) {
            const previous = rowRank.get(seq)
            if (previous === undefined || rank < previous) {
              rowBySeq.set(seq, row)
              rowRank.set(seq, rank)
            }
          }
        }
      } catch {
        /* a host shape this pass cannot read falls back below */
      }
      const root = conversationRootForPatches()
      if (root === null) return
      const replies = view.replies instanceof Map ? view.replies : new Map()
      const wantedText = new Map()
      const wantedReasoning = new Map()
      // Blocks the user inserted. A rewrite is drawn OVER the node the host
      // rendered; an insertion has no such node, so one is created below.
      const wantedInserts = new Map()
      for (const patch of Array.isArray(view.patches) ? view.patches : []) {
        if (typeof patch.insertId !== 'string' || patch.removed === true) continue
        const list = wantedInserts.get(patch.seq)
        if (list === undefined) wantedInserts.set(patch.seq, [patch])
        else list.push(patch)
      }
      // Creation order is the order the blocks were added in, which is what
      // blockIndex carries for an inserted block.
      for (const list of wantedInserts.values()) list.sort((a, b) => a.blockIndex - b.blockIndex)
      for (const patch of Array.isArray(view.patches) ? view.patches : []) {
        // Find the block by (seq, index) AND the entry that carries it.
        //
        // One reply entry carries its whole TURN's blocks, so several blocks
        // share an index - the first step's reasoning and the fourth step's
        // reasoning are both "index 0" - and a later step's block lives in the
        // entry keyed by the ANSWER's seq, not by its own. Keying the lookup by
        // `patch.seq` alone found no entry, and `find(index === ...)` alone found
        // the wrong block: either way the patch matched nothing in the DOM and
        // the reasoning body kept the recorded text until a reload (reported from
        // the field for the 思维链 page; a save on another step's reasoning wrote
        // the record and /state reported it, yet the transcript did not move).
        let reply = replies.get(patch.seq)
        let block = Array.isArray(reply?.blocks)
          ? reply.blocks.find(
              (entry) =>
                entry.index === patch.blockIndex &&
                (entry.seq === undefined || patch.seq === undefined || entry.seq === patch.seq),
            )
          : undefined
        if (block === undefined) {
          for (const candidate of replies.values()) {
            if (!Array.isArray(candidate?.blocks)) continue
            const found = candidate.blocks.find(
              (entry) => entry.index === patch.blockIndex && entry.seq === patch.seq,
            )
            if (found !== undefined) {
              reply = candidate
              block = found
              break
            }
          }
        }
        if (block === undefined) continue
        if (patch.kind === 'text') {
          wantedText.set(`${patch.seq}:${patch.blockIndex}`, {
            key: `${patch.seq}:${patch.blockIndex}`,
            seq: patch.seq,
            original: String(block.original ?? ''),
            text: String(patch.text ?? ''),
          })
        } else if (patch.kind === 'reasoning') {
          wantedReasoning.set(`${patch.seq}:${patch.blockIndex}`, {
            key: `${patch.seq}:${patch.blockIndex}`,
            seq: patch.seq,
            original: String(block.original ?? ''),
            text: String(patch.text ?? ''),
            reply,
            block,
          })
        }
      }

      // A patch that no longer exists must give the host's recorded text back,
      // even when a re-render already stripped our marker from the element.
      for (const [key, el] of [...patchedElements]) {
        if (wantedText.has(key) || wantedReasoning.has(key)) continue
        patchedElements.delete(key)
        if (el.isConnected === true) restorePatchedBlock(el)
      }
      // Remove overrides whose patch is gone (or was superseded by a prompt
      // rollback). The original HTML is what the host rendered.
      for (const el of [...root.querySelectorAll(`[${PATCH_ATTR}]`)]) {
        const key = el.getAttribute(PATCH_ATTR)
        const wanted = wantedText.get(key)
        if (wanted === undefined) {
          restorePatchedBlock(el)
          continue
        }
        const shown = displayText(wanted.text)
        if (normalizedText(el.textContent) !== normalizedText(shown)) {
          el.textContent = shown
        }
      }
      // A row whose insertions are all gone keeps nothing of ours - and this has
      // to happen before the "nothing to draw" return below, or a turn whose
      // blocks were all removed would keep its drawn copy for ever.
      for (const [seq, el] of [...addedContainers]) {
        // A disconnected container is a row the host rebuilt: forget it, the
        // pass below creates a fresh one for whatever is still wanted.
        if (!wantedInserts.has(seq) || el.isConnected !== true) {
          addedContainers.delete(seq)
          if (el.isConnected === true) el.remove()
        }
      }
      if (wantedText.size === 0 && wantedReasoning.size === 0 && wantedInserts.size === 0) return

      const nodes = [...root.querySelectorAll('[data-slot="conversation.chat.node"]')]
      const containers = []
      for (const node of nodes) {
        for (const el of node.querySelectorAll('*')) {
          try {
            if (isMarkdownContainer(el) && el.closest('.dshet-editor, .dshet-pick') === null) containers.push(el)
          } catch {
            /* a detached node is skipped */
          }
        }
      }
      for (const [key, wanted] of wantedText) {
        const owner = rowBySeq.get(wanted.seq)
        const remembered = patchedElements.get(key)
        if (remembered !== undefined) {
          const stillThere = remembered.isConnected === true &&
            (owner === undefined || remembered.closest('[data-chat-flow-key]') === owner)
          if (!stillThere) {
            patchedElements.delete(key)
          } else {
            const shown = displayText(wanted.text)
            if (normalizedText(remembered.textContent) !== normalizedText(shown)) {
              remembered.textContent = shown
            }
            if (remembered.getAttribute(PATCH_ATTR) !== key) remembered.setAttribute(PATCH_ATTR, key)
            remembered.style.whiteSpace = 'pre-wrap'
            continue
          }
        }
        const done = [...root.querySelectorAll(`[${PATCH_ATTR}]`)].find((el) => el.getAttribute(PATCH_ATTR) === key)
        if (done !== undefined) {
          patchedElements.set(key, done)
          if (done.style.whiteSpace !== 'pre-wrap') done.style.whiteSpace = 'pre-wrap'
          continue
        }
        const original = matchText(wanted.original)
        const previous = matchText(patchedTexts.get(key) ?? '')
        if (original === '' && previous === '') continue
        let best = null
        let bestScore = Infinity
        for (const el of containers) {
          if (el.getAttribute(PATCH_ATTR) !== null) continue
          if (owner !== undefined) {
            try {
              if (el.closest('[data-chat-flow-key]') !== owner) continue
            } catch {
              /* no closest on this node: keep the global match */
            }
          }
          const text = matchText(el.textContent)
          if (text === '') continue
          const exact = text === original || (previous !== '' && text === previous)
          const prefix = text.startsWith(original.slice(0, 60)) || original.startsWith(text.slice(0, 60))
          if (!exact && !prefix) continue
          // Prefer the exact match, then the container closest in length: a
          // nested paragraph and the whole markdown body can both match a
          // prefix, and the paragraph is the one to rewrite.
          const score = (exact ? 0 : 1000) + Math.abs(text.length - original.length)
          if (score < bestScore) {
            best = el
            bestScore = score
          }
        }
        if (best === null) best = findPatchTextFallback(owner, wanted, patchedTexts.get(key) ?? '')
        if (best === null) continue
        patchOriginals.set(best, { html: best.innerHTML, text: best.textContent })
        best.textContent = displayText(wanted.text)
        best.setAttribute(PATCH_ATTR, key)
        best.style.whiteSpace = 'pre-wrap'
        patchedElements.set(key, best)
        patchedTexts.set(key, wanted.text)
      }

      // A reasoning patch is drawn in place when the host renders that
      // reasoning body; the note is only the fallback for a panel that is not
      // in the DOM (or is drawn as a short summary without the full text).
      for (const [key, wanted] of wantedReasoning) {
        const owner = rowBySeq.get(wanted.seq)
        const shown = displayText(wanted.text)
        const previousText = patchedTexts.get(key) ?? ''
        const original = matchText(wanted.original)
        const previous = matchText(previousText)
        // EVERY copy of this reasoning, not just the one this pass remembers.
        //
        // The host keeps the collapsed process row in the DOM with `display:
        // none` and renders a SECOND body when the panel is opened. Trusting the
        // remembered element because it is still `isConnected` meant the copy the
        // user was looking at kept the recorded text until a reload - which is
        // exactly the reported "思维链页保存后不能马上渲染".
        const targets = new Set()
        const remembered = patchedElements.get(key)
        if (remembered !== undefined) {
          if (remembered.isConnected === true) targets.add(remembered)
          else patchedElements.delete(key)
        }
        for (const el of root.querySelectorAll(`[${PATCH_ATTR}]`)) {
          if (el.getAttribute(PATCH_ATTR) === key) targets.add(el)
        }
        if (original !== '' || previous !== '') {
          // The owning row first (a host that draws the reasoning inside the
          // answer row), then the whole conversation: on this host the reasoning
          // is its own row, so the answer row holds no reasoning text at all.
          // EVERY scope is merged, never just the first one that matched: the
          // point of this pass is to catch all copies at once.
          for (const scope of owner === undefined ? [null] : [owner, null]) {
            let foundInScope = false
            for (const el of containers) {
              if (el.getAttribute(PATCH_ATTR) !== null) continue
              if (scope !== null) {
                try {
                  if (el.closest('[data-chat-flow-key]') !== scope) continue
                } catch {
                  /* keep the global match */
                }
              }
              const text = matchText(el.textContent)
              if (text === '') continue
              if (text !== original && !(previous !== '' && text === previous)) continue
              targets.add(el)
              foundInScope = true
            }
            if (foundInScope) break
          }
          const fallback = findPatchTextFallback(owner ?? null, wanted, previousText)
          if (fallback !== null) targets.add(fallback)
          for (const el of findReasoningElements(root, wanted, previousText)) targets.add(el)
        }
        if (targets.size === 0) {
          // No body in the DOM (the panel is closed): the header snippet is the
          // only place the edit can show.
          if (owner !== undefined) patchReasoningSummary(owner, wanted)
          patchReasoningSummary(root, wanted)
          continue
        }
        for (const el of targets) {
          if (!patchOriginals.has(el)) patchOriginals.set(el, { html: el.innerHTML, text: el.textContent })
          if (normalizedText(el.textContent) !== normalizedText(shown)) el.textContent = shown
          if (el.getAttribute(PATCH_ATTR) !== key) el.setAttribute(PATCH_ATTR, key)
          el.style.whiteSpace = 'pre-wrap'
          patchedElements.set(key, el)
        }
        patchedTexts.set(key, wanted.text)
        if (owner !== undefined) patchReasoningSummary(owner, wanted)
        patchReasoningSummary(root, wanted)
      }

      // --- blocks the user added -------------------------------------------
      //
      // The host renders the recorded message, so an inserted block has no node
      // to draw over: the node is created here, inside the row that owns the
      // seq, and marked so a re-render, a removal or a teardown takes it away
      // again. Nothing is injected outside that row.
      for (const [seq, list] of wantedInserts) {
        const owner = rowBySeq.get(seq)
        if (owner === undefined) continue
        // The document to build nodes with: the row's own when it has one (the
        // real page), else the ambient one. A stub or a detached row is not a
        // reason to skip the block.
        const doc = owner.ownerDocument ?? (typeof document === 'undefined' ? null : document)
        if (doc === null || doc === undefined || typeof doc.createElement !== 'function') continue
        let host = addedContainers.get(seq)
        if (host === undefined || host.isConnected !== true) {
          host = doc.createElement('div')
          host.className = 'dshet-added'
          host.setAttribute('data-dshet-added', String(seq))
          owner.appendChild(host)
          addedContainers.set(seq, host)
        }
        const seen = new Set()
        for (const patch of list) {
          seen.add(patch.insertId)
          const selector = '[data-dshet-added-block="' + patch.insertId + '"]'
          let node = host.querySelector(selector)
          if (node === null) {
            node = doc.createElement(patch.kind === 'reasoning' ? 'div' : 'div')
            node.className = 'dshet-added-block dshet-added-' + (patch.kind === 'reasoning' ? 'reasoning' : 'text')
            node.setAttribute('data-dshet-added-block', patch.insertId)
            node.setAttribute('title', t === undefined || t === null ? '' : t('added.block'))
            host.appendChild(node)
          }
          const shown = displayText(String(patch.text ?? ''))
          if (normalizedText(node.textContent) !== normalizedText(shown)) node.textContent = shown
        }
        for (const node of [...host.querySelectorAll('[data-dshet-added-block]')]) {
          if (!seen.has(node.getAttribute('data-dshet-added-block'))) node.remove()
        }
        if (host.children.length === 0) host.remove()
      }


    }

    function applyDom(snapshot, view, controller, t) {
      if (!snapshot || !snapshot.nodes || typeof snapshot.nodes.get !== 'function') return
      const animate = controller.consumeAnimate()
      const rows = document.querySelectorAll('[data-chat-flow-key]')
      syncEditableSet(controller, rows.length)
      let editorCandidate = null
      let editorRank = -1
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
          const rank = editorRowRank(row, editing.mode)
          if (rank > editorRank) {
            editorRank = rank
            editorCandidate = row
          }
        }
      }
      if (view.editing !== null) {
        if (editorCandidate !== null) {
          renderEditor(editorCandidate, controller, view, t)
        } else {
          clearEditor()
          controller.editorBox = null
          controller.editorRow = null
        }
      }
      if (view.editing === null) {
        clearEditor()
        controller.editorBox = null
        controller.editorRow = null
      }
      // Draw the projected reply text last: the host has just rebuilt the rows,
      // and an override applied before that would be wiped by the rebuild.
      try {
        applyPatchDisplay(snapshot, view, t)
      } catch (error) {
        console.error('[dsh-edit-turn] patch display failed:', error)
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
          anchor: event.currentTarget,
          seq: entry.seq,
          mode: 'reply',
          turn: entry.turn,
          messageId: entry.messageId,
          text: typeof entry.text === 'string' ? entry.text : '',
          attachments: typeof entry.attachments === 'number' ? entry.attachments : 0,
          // On the in-place path the reply keeps its tool calls and other
          // blocks, so the editor can offer each editable block (output text
          // and reasoning). On the replay path there is no block picker: the
          // whole reply is replaced.
          ...(Array.isArray(entry.blocks) ? { blocks: entry.blocks, patch: true } : { blocks: [] }),
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

    // --- the fallback strip ---------------------------------------------------
    //
    // TurnTailNodeView, when a turn's model reply has no closing body
    // (`closing === null`), returns the turnTail slot alone and never renders
    // `conversation.chat.assistant-actions`. Every action on that row goes with
    // it - this plugin's pencil, and the platform's own copy, branch, feedback
    // and usage buttons too. Nothing a plugin registers inside a strip that is
    // not rendered can bring those back, so the fallback lives in the one slot
    // that branch DOES render.
    //
    // It is not a second bar for every turn: the host puts `data-actions-reveal`
    // on the tail container only on the branch that draws its own strip, and one
    // CSS rule hides this one wherever that attribute is present.

    /**
     * The reply this turn's fallback strip acts on.
     *
     * A turn runs several steps and the strip belongs at the end of the turn,
     * so the LAST rewriteable reply of that turn wins - the same row the host
     * would have hung its own strip on.
     *
     * @param view - the controller snapshot (see readReplyView).
     * @param turn - the TurnLocation the slot hands over.
     * @returns the reply entry, or undefined when this turn has none.
     */
    function replyForTurn(view, turn) {
      if (view === null || view === undefined || typeof turn !== 'number') return undefined
      const replies = view.replies
      if (replies === null || replies === undefined || typeof replies.values !== 'function') return undefined
      if (view.hidden === null || view.hidden === undefined || typeof view.hidden.has !== 'function') return undefined
      let best
      for (const reply of replies.values()) {
        if (reply === null || typeof reply !== 'object') continue
        if (typeof reply.seq !== 'number' || reply.turn !== turn) continue
        if (view.hidden.has(reply.seq)) continue
        if (best === undefined || reply.seq > best.seq) best = reply
      }
      return best
    }

    /**
     * What a copy press on the fallback strip writes.
     *
     * The model's own answer when the turn has one, and its reasoning when the
     * whole reply went into thinking - the case this strip exists for. Blocks
     * are joined the way they read, blank ones dropped so a trailing empty
     * block does not become a trailing newline.
     *
     * @param entry - one reply entry.
     * @returns the text to copy; empty when there is nothing readable.
     */
    function replyCopyText(entry) {
      const blocks = entry !== null && entry !== undefined && Array.isArray(entry.blocks) ? entry.blocks : []
      const gather = (kind) =>
        blocks
          .filter((block) => block !== null && typeof block === 'object' && block.kind === kind)
          .map((block) => (typeof block.text === 'string' ? block.text : ''))
          .filter((text) => text.trim() !== '')
          .join('\n\n')
      const answer = gather('text')
      return answer !== '' ? answer : gather('reasoning')
    }

    function CopyIcon() {
      return jsx('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        children: [
          jsx('rect', { x: 5.2, y: 5.2, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.2 }, 0),
          jsx('path', { d: 'M10.8 5.2V3.6A1.6 1.6 0 0 0 9.2 2H3.6A1.6 1.6 0 0 0 2 3.6v5.6a1.6 1.6 0 0 0 1.6 1.6h1.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }, 1),
        ],
      })
    }

    function CheckIcon() {
      return jsx('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        children: jsx('path', { d: 'M3.2 8.4l3.2 3.2 6.4-6.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }, 0),
      })
    }

    /**
     * The fallback strip for a turn the host draws no action row for.
     *
     * @param props - the slot's owner props ({ turn, seq, openFile }) plus the
     *   injected controller, the standard `useChat` and this plugin's `t`.
     */
    function TailActionEntry(input) {
      const props = input !== null && typeof input === 'object' ? input : {}
      const turn = props.turn
      const controller = props.controller
      const t = typeof props.t === 'function' ? props.t : null
      const useChat = props.useChat
      const [view, setView] = react.useState(() => {
        try {
          return readReplyView(controller)
        } catch {
          return null
        }
      })
      const [copied, setCopied] = react.useState(false)
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
      // The host reveals the latest turn's row always and older ones on hover.
      // The same rule, from the same source it uses (the last turn in the
      // timeline), so the strip does not behave differently from the row it
      // stands in for.
      const lastTurn = typeof useChat === 'function'
        ? useChat((state) => {
            if (state === null || typeof state !== 'object') return undefined
            const timeline = state.timeline
            const order = timeline === null || timeline === undefined ? null : timeline.turnOrder
            if (!Array.isArray(order) || order.length === 0) return undefined
            return order[order.length - 1]
          })
        : undefined
      const entry = replyForTurn(view, turn)
      // Nothing this plugin can act on: the strip stays out of the way rather
      // than drawing an empty row.
      if (entry === undefined) return null
      const label = t === null ? '' : t('action.edit-reply')
      const copyLabel = t === null ? '' : t(copied ? 'action.copied' : 'action.copy')
      const open = (event) => {
        event.preventDefault()
        event.stopPropagation()
        controller.open({
          anchor: event.currentTarget,
          seq: entry.seq,
          mode: 'reply',
          turn: entry.turn,
          messageId: entry.messageId,
          text: typeof entry.text === 'string' ? entry.text : '',
          attachments: typeof entry.attachments === 'number' ? entry.attachments : 0,
          ...(Array.isArray(entry.blocks) ? { blocks: entry.blocks, patch: true } : { blocks: [] }),
        })
      }
      const copy = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const text = replyCopyText(entry)
        if (text === '') return
        const write = primitives !== null && primitives !== undefined && typeof primitives.writeClipboard === 'function'
          ? primitives.writeClipboard
          : typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
            ? (value) => navigator.clipboard.writeText(value)
            : null
        if (write === null) return
        Promise.resolve()
          .then(() => write(text))
          .then(
            () => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            },
            () => {},
          )
      }
      return jsxs('div', {
        className: 'dshet-tail',
        'data-reveal': lastTurn === turn ? 'always' : 'hover',
        role: 'toolbar',
        'aria-label': t === null ? undefined : t('action.tail-actions'),
        children: [
          jsx('button', {
            type: 'button',
            className: 'dshet-action dshet-tail-action',
            'aria-label': label,
            title: label,
            onClick: open,
            key: 'edit',
            children: jsx(PencilIcon, {}),
          }),
          jsx('button', {
            type: 'button',
            className: 'dshet-action dshet-tail-action',
            'data-copied': copied ? '1' : undefined,
            'aria-label': copyLabel,
            title: copyLabel,
            onClick: copy,
            key: 'copy',
            children: copied ? jsx(CheckIcon, {}) : jsx(CopyIcon, {}),
          }),
        ],
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
        let placementScheduled = false
        let lastPlacementKey = ''
        const keepPlaced = () => {
          if (placementScheduled) return
          placementScheduled = true
          const run = () => {
            placementScheduled = false
            const row = controller.editorRow
            const box = controller.editorBox
            if (row === null || box === null || box.isConnected !== true) return
            const rect = row.getBoundingClientRect()
            const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 0
            const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 0
            const key = `${Math.round(rect.top)}:${Math.round(rect.height)}:${Math.round(typeof window !== 'undefined' && typeof window.scrollY === 'number' ? window.scrollY : 0)}:${viewportWidth}x${viewportHeight}:${controller.editorBlockKind}:${controller.editorAll === true ? 'all' : ''}`
            if (key === lastPlacementKey) return
            lastPlacementKey = key
            placeEditor(row, box, controller.editorMode, controller.editorStyle, controller.editorBlockKind, controller.editorBlocks, controller)
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
          else window.setTimeout(run, 16)
        }
        const onResize = () => {
          // A window resize (or a fullscreen toggle / zoom) moves the composer
          // and the conversation edges; the cached band must not survive it.
          conversationBoundsCache = null
          keepPlaced()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        // Scroll events do not bubble; capture reaches the inner scroller too.
        document.addEventListener('scroll', keepPlaced, { capture: true, passive: true })
        window.addEventListener('resize', onResize)
        let resizeObserver = null
        if (typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(onResize)
          try { resizeObserver.observe(document.body) } catch {}
        }
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('scroll', keepPlaced, true)
          window.removeEventListener('resize', onResize)
          if (resizeObserver !== null) resizeObserver.disconnect()
        }
      }, [controller])

      useBrowserLayoutEffect(() => {
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
        const observer = new MutationObserver((records) => {
          // Our own editor writes attributes and text while the user types;
          // feeding those back into a full document pass is what made typing
          // and streaming compete for the same frames.
          let relevant = false
          let lostOurAction = false
          for (const record of records) {
            const target = record.target
            if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('.dshet-layer') !== null) continue
            relevant = true
            if (record.removedNodes && record.removedNodes.length > 0) {
              for (const node of record.removedNodes) {
                if (node === null || node === undefined) continue
                if (typeof node.closest === 'function' && node.closest('.dshet-action') !== null) lostOurAction = true
                else if (typeof node.querySelector === 'function' && node.querySelector('.dshet-action') !== null) lostOurAction = true
              }
            }
            break
          }
          if (!relevant) return
          // The host rebuilt a row and our button went with it: put it back in
          // the same task instead of waiting a frame for the rAF pass.
          if (lostOurAction) {
            scheduled = false
            run()
            return
          }
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
      // A row's copy button was answering for this half; that handover is this
      // half's own write on a HOST node and goes back the same way (I4). The
      // button itself stays where the host owns it - it simply copies its own
      // message again, through the host's handler.
      each('[data-dshet-copy-text]', (button) => releaseCopyButton(button))
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

    // --- editor-style preference ----------------------------------------------
    //
    // The style is a browser preference so the manager page and the editor read
    // one value with no host round-trip. The host config's editorStyle is the
    // default when nothing has been chosen here.
    const EDITOR_STYLE_KEY = 'dsh-edit-turn/editorStyle'
    const EDITOR_STYLES = ['frame', 'bubble', 'center']

    function readStoredEditorStyle() {
      try {
        if (typeof localStorage === 'undefined') return null
        const value = localStorage.getItem(EDITOR_STYLE_KEY)
        return EDITOR_STYLES.includes(value) ? value : null
      } catch {
        return null
      }
    }

    let editorStylePreference = readStoredEditorStyle() ?? 'frame'
    const EDITOR_PLACEMENT_KEY = 'dsh-edit-turn/editorPlacement'
    const EDITOR_PLACEMENTS = ['overlay', 'inline', 'legacy']

    function readStoredEditorPlacement() {
      try {
        if (typeof localStorage === 'undefined') return null
        const value = localStorage.getItem(EDITOR_PLACEMENT_KEY)
        return EDITOR_PLACEMENTS.includes(value) ? value : null
      } catch {
        return null
      }
    }

    let editorPlacementPreference = readStoredEditorPlacement() ?? 'overlay'
    const EDITOR_HEIGHT_KEY = 'dsh-edit-turn/editorHeight'
    const EDITOR_HEIGHTS = ['max', 'content', 'fill']

    function readStoredEditorHeight() {
      try {
        if (typeof localStorage === 'undefined') return null
        const value = localStorage.getItem(EDITOR_HEIGHT_KEY)
        return EDITOR_HEIGHTS.includes(value) ? value : null
      } catch {
        return null
      }
    }

    let editorHeightPreference = readStoredEditorHeight() ?? 'fill'
    const editorHeightListeners = new Set()

    function subscribeEditorHeight(listener) {
      editorHeightListeners.add(listener)
      return () => editorHeightListeners.delete(listener)
    }

    function setEditorHeightPreference(mode) {
      if (!EDITOR_HEIGHTS.includes(mode)) return
      editorHeightPreference = mode
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(EDITOR_HEIGHT_KEY, mode)
      } catch {}
      for (const listener of [...editorHeightListeners]) {
        try { listener() } catch {}
      }
    }

    const editorPlacementListeners = new Set()

    function subscribeEditorPlacement(listener) {
      editorPlacementListeners.add(listener)
      return () => editorPlacementListeners.delete(listener)
    }

    function setEditorPlacementPreference(placement) {
      if (!EDITOR_PLACEMENTS.includes(placement)) return
      editorPlacementPreference = placement
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(EDITOR_PLACEMENT_KEY, placement)
      } catch {
        /* private mode keeps the in-memory choice */
      }
      for (const listener of [...editorPlacementListeners]) {
        try {
          listener()
        } catch {}
      }
    }

    const editorStyleListeners = new Set()

    function subscribeEditorStyle(listener) {
      editorStyleListeners.add(listener)
      return () => editorStyleListeners.delete(listener)
    }

    function setEditorStylePreference(style) {
      if (!EDITOR_STYLES.includes(style)) return
      editorStylePreference = style
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(EDITOR_STYLE_KEY, style)
      } catch {
        /* private mode keeps the in-memory choice */
      }
      for (const listener of [...editorStyleListeners]) {
        try {
          listener()
        } catch {}
      }
    }

    /**
     * The component row's configure page (`plugins.row.config`), the same slot
     * dsh-delete-turn uses. The manager's summary asks for a one-liner; the page
     * itself renders the three-way picker.
     */
    function EditorStyleOption({ view, t }) {
      const tr = typeof t === 'function' ? t : (key) => key
      const [style, setStyle] = react.useState(editorStylePreference)
      const [placement, setPlacement] = react.useState(editorPlacementPreference)
      const [heightMode, setHeightMode] = react.useState(editorHeightPreference)
      react.useEffect(() => subscribeEditorStyle(() => setStyle(editorStylePreference)), [])
      react.useEffect(() => subscribeEditorPlacement(() => setPlacement(editorPlacementPreference)), [])
      react.useEffect(() => subscribeEditorHeight(() => setHeightMode(editorHeightPreference)), [])
      const summaryKey = style === 'bubble' ? 'config.summary.bubble' : style === 'center' ? 'config.summary.center' : 'config.summary.frame'
      if (view === 'summary') return `${tr(summaryKey)} · ${tr(placement === 'inline' ? 'config.summary.inline' : placement === 'legacy' ? 'config.summary.legacy' : 'config.summary.overlay')} · ${tr(heightMode === 'content' ? 'config.summary.height.content' : heightMode === 'fill' ? 'config.summary.height.fill' : 'config.summary.height.max')}`
      const hintKey = style === 'bubble' ? 'config.hint.bubble' : style === 'center' ? 'config.hint.center' : 'config.hint.frame'
      const placementHint = placement === 'inline' ? 'config.hint.inline' : placement === 'legacy' ? 'config.hint.legacy' : 'config.hint.overlay'
      const heightHint = heightMode === 'content' ? 'config.hint.height.content' : heightMode === 'fill' ? 'config.hint.height.fill' : 'config.hint.height.max'
      const choices = [
        ['frame', 'style.frame'],
        ['bubble', 'style.bubble'],
        ['center', 'style.center'],
      ]
      return jsxs('div', {
        className: 'dshet-config',
        children: [
          jsxs('label', {
            className: 'dshet-config-row',
            children: [
              jsx('span', { children: tr('config.style') }),
              jsx('select', {
                className: 'dshet-select',
                value: style,
                onChange: (event) => setEditorStylePreference(event.target.value),
                children: choices.map(([value, key]) => jsx('option', { value, children: tr(key) }, value)),
              }),
            ],
          }),
          jsx('p', { className: 'dshet-config-hint', children: tr(hintKey) }),
          jsxs('label', {
            className: 'dshet-config-row',
            children: [
              jsx('span', { children: tr('config.placement') }),
              jsx('select', {
                className: 'dshet-select',
                value: placement,
                onChange: (event) => setEditorPlacementPreference(event.target.value),
                children: [
                  jsx('option', { value: 'overlay', children: tr('placement.overlay') }),
                  jsx('option', { value: 'inline', children: tr('placement.inline') }),
                  jsx('option', { value: 'legacy', children: tr('placement.legacy') }),
                ],
              }),
            ],
          }),
          jsx('p', { className: 'dshet-config-hint', children: tr(placementHint) }),
          jsxs('label', {
            className: 'dshet-config-row',
            children: [
              jsx('span', { children: tr('config.height') }),
              jsx('select', {
                className: 'dshet-select',
                value: heightMode,
                onChange: (event) => setEditorHeightPreference(event.target.value),
                children: [
                  jsx('option', { value: 'max', children: tr('height.max') }),
                  jsx('option', { value: 'content', children: tr('height.content') }),
                  jsx('option', { value: 'fill', children: tr('height.fill') }),
                ],
              }),
            ],
          }),
          jsx('p', { className: 'dshet-config-hint', children: tr(heightHint) }),
        ],
      })
    }

    // --- plugin ---------------------------------------------------------------

    function apply(ctx) {
      // Diagnostic only: the host restart does not reload the page's JS, so a
      // stale client bundle and a live host can coexist. This marker says which
      // browser half actually ran (the old bundle has none).
      try {
        document.documentElement.dataset.dshetVersion = PLUGIN_VERSION
      } catch {
        /* a non-DOM host is not worth failing over */
      }
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
      // The active skin repaints its surfaces at any time (switching one
      // rewrites body's attributes and inline variables), so the palette is
      // resolved once and then again on every theme or skin change.
      ctx.effect(() => {
        const run = () => {
          try {
            resolveSkinPalette()
          } catch {
            /* the stylesheet defaults stand */
          }
        }
        run()
        const observer =
          typeof MutationObserver === 'function' && document && document.body
            ? new MutationObserver(run)
            : null
        if (observer !== null) {
          observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] })
          if (document.documentElement) observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
        }
        return () => {
          if (observer !== null) observer.disconnect()
        }
      }, 'dsh-edit-turn:skin-palette')

      // Appended blocks are DOM of this plugin's own making: when the fiber that
      // drew them goes away, they go away with it. A rewrite can be restored from
      // the recorded text; an appended block has nothing to restore FROM, so it
      // must not outlive the plugin.
      ctx.effect(() => () => {
        for (const el of addedContainers.values()) {
          if (el.isConnected === true) el.remove()
        }
        addedContainers.clear()
      }, 'dsh-edit-turn: added blocks')

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

      // The row's configure arrow in the plugin manager. Without this the
      // component page is a read-only overview (the card cannot be opened); the
      // key is the manager's `<bundle package>#<row id>` contract.
      // The fallback strip, for turns the host draws no action row for (see
      // TailActionEntry). Order 40 keeps it after the shipped contributors
      // (schedule sits at 20). It is hidden by CSS wherever the host's own strip
      // exists, so ordering only matters on the turns it appears at all.
      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'edit-turn-tail',
            order: 40,
            locale: NS,
            inject: (sessionId) => ({ controller: controllerFor(sessionId) }),
          },
          TailActionEntry,
        ),
      )

      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.row.config',
            key: 'dsh-edit-turn#dsh-edit-turn',
            locale: NS,
          },
          EditorStyleOption,
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
    // The settings card, exported so a composing bundle (dsh-as-aistudio) can
    // render THE SAME component on its own page instead of re-implementing it:
    // one source of truth for 编辑与重跑 settings.
    exports.ConfigCard = EditorStyleOption
    exports.inject = ['slots', 'locale']
    exports.PLUGIN_VERSION = PLUGIN_VERSION
    return module.exports
  },
})
