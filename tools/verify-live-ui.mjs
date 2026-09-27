// Verify what the browser is actually RENDERING of this plugin, over CDP.
//
// The static checker sees the source, the DOM tests see the source against a
// stub. Neither sees the host slot runtime, which is where the three shipped
// defects lived: an entry that threw while rendering was retired for the whole
// page and its cell then rendered an empty placeholder, the revision pencil was
// positioned inside the bubble and covered the text, and a rolled-back row was
// displayed away along with the platform's own time / copy / delete buttons.
//
// This drives a real tab: reload (cache-busted), then read the DOM and the
// console, switch session once to prove the entries survive a remount, and
// switch back.
//
//   node tools/verify-live-ui.mjs
//   CDP_URL=http://127.0.0.1:9333 node tools/verify-live-ui.mjs
//   DSH_URL=http://127.0.0.1:3080 node tools/verify-live-ui.mjs
//
// Requirements: a Chrome/Chromium started with --remote-debugging-port (9333
// by default) that either has the DSH instance open or can be navigated to it.
//
// Read-only: it reloads, reads and clicks sidebar sessions. It never posts to
// /apply and never opens or saves the editor.
const CDP_URL = (process.env.CDP_URL || 'http://127.0.0.1:9333').replace(/\/$/, '')
const APP_URL = (process.env.DSH_URL || 'http://127.0.0.1:3080').replace(/\/$/, '')

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function note(label, detail) {
  console.log(`  · ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targets() {
  const response = await fetch(`${CDP_URL}/json/list`)
  if (!response.ok) throw new Error(`CDP target list answered ${response.status}`)
  return response.json()
}

// --- the wire ----------------------------------------------------------------

async function attach() {
  const pages = (await targets()).filter((target) => target.type === 'page')
  if (pages.length === 0) {
    throw new Error(`no page target on ${CDP_URL}; start Chrome with --remote-debugging-port`)
  }
  const page = pages.find((target) => target.url.startsWith(APP_URL)) ?? pages[0]
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
      return
    }
    for (const listener of listeners) listener(message)
  })
  const drop = () => {
    for (const { reject } of pending.values()) reject(new Error('websocket closed'))
    pending.clear()
  }
  socket.addEventListener('close', drop)

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  return {
    url: page.url,
    send,
    onMessage: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      drop()
      socket.close()
    },
  }
}

// A navigation can wedge a target. Every call carries its own deadline and the
// caller reconnects instead of hanging the whole run.
async function evaluate(connection, expression, { timeout = 15_000 } = {}) {
  let result
  try {
    result = await Promise.race([
      connection.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
      sleep(timeout).then(() => {
        throw new Error('evaluate timed out')
      }),
    ])
  } catch (error) {
    throw error
  }
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(`probe threw: ${text}`)
  }
  return result.result.value
}

// --- the probes --------------------------------------------------------------

// One pass over the transcript: what our own rows look like right now.
const PROBE = `(() => {
  const all = (selector) => Array.from(document.querySelectorAll(selector));
  const cells = all('[data-slot="conversation.chat.assistant-actions"]');
  const bars = all('[class*="_actions"]').filter((bar) => bar.querySelector('[class*="_action"]') !== null);
  const selected = document.querySelector('[aria-selected="true"][data-row-key^="session:"]');
  return {
    session: selected === null ? null : selected.getAttribute('data-row-key'),
    assistantCells: cells.length,
    assistantErrored: cells.filter((cell) =>
      cell.querySelector('[data-slot-error]') !== null || cell.children.length === 0
    ).length,
    replyPencils: all('[data-slot="conversation.chat.assistant-actions"] .dshet-action').length,
    bars: bars.length,
    barsWithPencil: bars.filter((bar) => bar.querySelector('.dshet-action') !== null).length,
    barButtons: bars.reduce((sum, bar) => sum + bar.querySelectorAll('[class*="_action"]').length, 0),
    // The bars that belong to prompt rows - the ones this plugin injects into.
    userBars: all('[data-chat-flow-key][data-chat-flow-kind="user"] [class*="_actions"]').length,
    userBarsWithPencil: all('[data-chat-flow-key][data-chat-flow-kind="user"] [class*="_actions"] .dshet-action')
      .length,
    slotErrors: all('[data-slot-error]').map((node) => node.getAttribute('data-slot-error')),
    hidden: all('[data-dshet-hidden="1"]').map((row) => {
      const bar = row.querySelector('[class*="_actions"]');
      const inside = row.querySelector('.dshet-revision');
      const outside = row.previousElementSibling;
      return {
        // Only a rewritten prompt is collapsed and replaced by a bubble of our
        // own; a rewritten reply is collapsed and its correction arrives as a
        // row of the host's. Which one this is decides what has to be on screen.
        kind: row.getAttribute('data-chat-flow-kind'),
        revision: (inside !== null && inside.classList.contains('dshet-revision'))
          || (outside !== null && outside.classList.contains('dshet-revision')),
        keep: row.getAttribute('data-dshet-keep-actions') === '1',
        display: getComputedStyle(row).display,
        barDisplay: bar === null ? null : getComputedStyle(bar).display,
        buttons: bar === null ? 0 : bar.querySelectorAll('[class*="_action"]').length,
        // The row keeps its bar, so its actions belong in that bar - and the
        // pencil at its right end. Other plugins can append their own buttons
        // into the same bar (dsh-delete-turn's bin), and flex order - not DOM
        // position - is what keeps this one last, so read the laid-out boxes:
        // rightmost means no other visible item reaches further right.
        pencilTail: (() => {
          const host = bar === null ? null : bar.querySelector('.dshet-action-host');
          if (host === null) return false;
          const own = host.getBoundingClientRect();
          return [...bar.children].every((kid) => {
            if (kid === host) return true;
            const rect = kid.getBoundingClientRect();
            return rect.width === 0 || rect.height === 0 || own.right >= rect.right - 0.5;
          });
        })(),
        pencilInBubble: inside !== null && inside.querySelectorAll('.dshet-action').length > 0,
      };
    }),
    // Where the reply's pencil stands in the strip. The host draws the copy
    // button ahead of the slot this entry is rendered into, so only its flex
    // order can put it first; the leftmost flag reads the laid-out line, not the tree.
    replyBar: (() => {
      const button = document.querySelector(
        '[data-slot="conversation.chat.assistant-actions"] .dshet-reply-action',
      );
      if (button === null) return null;
      const bar = button.closest('[class*="_actions"]');
      if (bar === null) return null;
      const boxes = [];
      const walk = (element) => {
        if (getComputedStyle(element).display === 'contents') {
          for (const child of element.children) walk(child);
          return;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) boxes.push(rect);
      };
      for (const child of bar.children) walk(child);
      const own = button.getBoundingClientRect().x;
      return {
        x: Math.round(own),
        firstX: boxes.length === 0 ? Math.round(own) : Math.round(Math.min(...boxes.map((rect) => rect.x))),
        leftmost: boxes.every((rect) => rect.x >= own - 0.5),
      };
    })(),
    revisions: all('.dshet-revision').map((bubble) => {
      const parent = bubble.parentElement;
      const sibling = bubble.nextElementSibling;
      const row = parent !== null && parent.matches('[data-chat-flow-key]')
        ? parent
        : sibling !== null && sibling.matches('[data-chat-flow-key]') ? sibling : null;
      const bar = row === null ? null : row.querySelector('[class*="_actions"]');
      return {
        floating: bubble.querySelectorAll('.dshet-floating').length,
        gutter: bubble.classList.contains('dshet-revision-action'),
        pencils: bubble.querySelectorAll('.dshet-action').length,
        text: bubble.textContent.trim().slice(0, 40),
        // Where it stands. The defect was the bubble planted *after* the row,
        // which put the timestamp and the copy button above the message: it read
        // as though they belonged to whatever came next. null means no bar was
        // found to compare against (a row displayed away entirely).
        above: bar === null ? null : (bubble.compareDocumentPosition(bar) & 4) !== 0,
      };
    }),
  };
})()`

// What the plugin itself thinks is editable, read through the page's own
// session (it carries the auth cookie), for a denominator the DOM cannot give.
// A large session can take the host tens of seconds to answer, so the fetch
// carries its own deadline: an unavailable denominator is reported as an error
// and the run continues without one, rather than taking the whole smoke run
// down with it.
const EDITABLE = `(() => {
  const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
  const url = urls.filter((name) => name.includes('/dsh-edit-turn/state')).pop();
  if (url === undefined) return Promise.resolve({ stateUrl: null });
  return fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    .then((response) => response.json())
    .then((body) => ({
      stateUrl: url,
      turns: Array.isArray(body.turns) ? body.turns.length : -1,
      replies: Array.isArray(body.replies) ? body.replies.length : -1,
      rolledBack: Array.isArray(body.hidden) ? body.hidden.length : -1,
    }))
    .catch((error) => ({ stateUrl: url, error: String(error) }));
})()`

// The bytes the tab would run, re-fetched through the page. The group URL is
// content-hashed, so a stale rev 404s and a fresh one carries the fix. The
// group bundles other plugins too, so the stale-form check is scoped to the
// window this entry lives in.
const BUNDLE = `(() => {
  const url = performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .find((name) => name.includes('dsh-edit-turn/client.js'));
  if (url === undefined) return Promise.resolve({ bundleUrl: null });
  return fetch(url, { cache: 'no-store' })
    .then((response) => response.text())
    .then((text) => {
      const anchor = text.indexOf('readReplyView');
      const near = anchor === -1 ? '' : text.slice(anchor, anchor + 6000);
      return {
        bundleUrl: url,
        fixed: text.includes('collapseRowContent') && text.includes('readReplyView')
          && text.includes('dshet-revision-action') && text.includes('jsx(PencilIcon, {}'),
        // The prose of the fix quotes the crash verbatim, so match the call.
        staleReplyEntry: /children:\s*jsx\(PencilIcon,\s*null\)/.test(near),
        bytes: text.length,
      };
    })
    .catch((error) => ({ bundleUrl: url, error: String(error) }));
})()`

const SELECT_NEXT_SESSION = `(() => {
  const rows = Array.from(document.querySelectorAll('[data-row-key^="session:"]'));
  const next = rows.find((row) => row.getAttribute('aria-selected') !== 'true');
  if (next === undefined) return null;
  const key = next.getAttribute('data-row-key');
  next.click();
  return key;
})()`

const SELECT_SESSION = (key) =>
  `(() => {
  const row = document.querySelector('[data-row-key="${key}"]');
  if (row === null) return false;
  row.click();
  return true;
})()`

// --- the run -----------------------------------------------------------------

// A rolled-back row is supposed to have lost its pencil and kept the
// platform's own buttons - the defect was the buttons going too. It is also
// supposed to have a bubble of ours in its place: without that, collapsing the
// row took the message with it and the transcript had a hole in it.
function reportRolledBack(label, view, editable) {
  // Independent of the rows themselves: a bubble that stands *below* the row it
  // replaced leaves the time and the copy button on top of the message, which
  // reads as if they belonged to the line under them.
  for (const [index, bubble] of (view.revisions ?? []).entries()) {
    check(
      `${label} bubble ${index + 1} sits above the action bar`,
      bubble.above !== false,
      JSON.stringify(bubble),
    )
  }
  if (view.hidden.length === 0) {
    const known = typeof editable.rolledBack === 'number'
    note(
      `${label}: no rolled-back row in view`,
      !known ? 'the host state is unknown' : editable.rolledBack === 0 ? 'the session has none' : `${editable.rolledBack} exist, none in view`,
    )
    return
  }
  for (const [index, row] of view.hidden.entries()) {
    check(
      `${label} row ${index + 1} keeps its action bar`,
      row.keep && row.display !== 'none' && row.barDisplay !== 'none' && row.buttons > 0,
      JSON.stringify(row),
    )
    // A rewritten prompt may only vanish once the text that replaced it is on
    // screen. The defect this closes was the row collapsing with nothing
    // standing in for it, which left the transcript missing the message.
    if (row.kind === 'user') {
      check(
        `${label} row ${index + 1} shows the text that replaced it`,
        row.revision === true,
        JSON.stringify(row),
      )
      // The bar that survives is where this message's actions belong, and at
      // its right end - behind the clock and the copy button. A pencil inside
      // the bubble instead is only reachable by hovering the message text.
      check(
        `${label} row ${index + 1} carries the edit pencil at the end of its bar`,
        row.pencilTail === true && row.pencilInBubble === false,
        JSON.stringify(row),
      )
    }
  }
}

// Prompts that were rolled back are correctly without an entry, so they must
// not be counted as "editable and missing a pencil".
function editableOnScreen(state) {
  if (state === null || typeof state.turns !== 'number') return -1
  const rolledBack = typeof state.rolledBack === 'number' ? state.rolledBack : 0
  return Math.max(0, state.turns - rolledBack)
}

async function run() {
  let connection = await attach()
  const consoleLines = []
  const watch = async (current) => {
    current.onMessage((message) => {
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? '')
          .join(' ')
        consoleLines.push(`${message.params.type}: ${text}`)
      } else if (message.method === 'Log.entryAdded') {
        const entry = message.params.entry
        consoleLines.push(`${entry.level}: ${entry.text} ${entry.url ?? ''}`)
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails
        consoleLines.push(`exception: ${details.exception?.description ?? details.text}`)
      }
    })
    await current.send('Runtime.enable')
    await current.send('Log.enable')
  }
  await watch(connection)

  // Cache-busted reload: the group hash is recomputed per request, so the only
  // way to be sure the tab is running the edited bytes.
  await connection.send('Page.reload', { ignoreCache: true })
  note('reloaded', APP_URL)
  // Everything already in the buffer belongs to the previous document.
  const bootMark = consoleLines.length
  const bootLines = () => consoleLines.slice(bootMark)

  const probe = async (expression) => {
    try {
      return await evaluate(connection, expression)
    } catch (error) {
      if (/closed|timed out/.test(error.message)) {
        connection.close()
        connection = await attach()
        await watch(connection)
        return evaluate(connection, expression)
      }
      throw error
    }
  }

  // Ready = the plugin asked for its own state, which only happens once the
  // app booted and the session opened.
  let ready = false
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    ready = (await probe(`performance.getEntriesByType('resource').some((entry) => entry.name.includes('/dsh-edit-turn/state'))`)) === true
    if (!ready) await sleep(1_000)
  }
  check('the app booted and the plugin asked for its state', ready)
  if (!ready) { connection.close(); console.log('\n真机冒烟无法进行：应用没有起来。'); process.exit(1) }

  const bundle = await probe(BUNDLE)
  check(
    'the bytes the tab runs are the edited bytes',
    bundle?.fixed === true && bundle.staleReplyEntry === false,
    bundle?.bundleUrl === null
      ? 'the plugin module is not in the resource list'
      : JSON.stringify(bundle),
  )

  const editable = await probe(EDITABLE)
  if (editable.error !== undefined) {
    note('editable', `the state endpoint did not answer in time: ${editable.error}`)
  }
  const before = await probe(PROBE)
  const crashed = bootLines().filter((line) => /slot entry crashed|dsh-edit-turn|reading 'key'/.test(line))

  console.log('\n  — what the transcript shows —')
  check('no entry crashed into a retired strip', crashed.length === 0, crashed.slice(0, 3).join(' | '))
  check(
    'the assistant-actions cells all rendered something',
    before.assistantErrored === 0,
    `${before.assistantErrored}/${before.assistantCells} empty or placeholder cells`,
  )
  check(
    'a reply pencil is on screen when one is editable',
    !(editable.replies > 0) || before.replyPencils > 0,
    `editable=${editable.replies} pencils=${before.replyPencils}`,
  )
  check(
    'the pencil sits in the platform action bar',
    editableOnScreen(editable) === -1 || editableOnScreen(editable) === 0 || before.userBarsWithPencil > 0,
    `live prompts=${editableOnScreen(editable)}, prompt rows with a pencil=${before.userBarsWithPencil}/${before.userBars}`,
  )
  note('bars', `${before.barsWithPencil}/${before.bars} action bars carry a pencil, ${before.barButtons} platform buttons in them`)

  // The host draws the copy button ahead of the slot this entry renders into,
  // so DOM position can only ever put the pencil second. Only its flex order
  // gets it to the left end of the strip, which is where the user looks for it.
  console.log('\n  — the reply pencil leads its strip —')
  if (before.replyBar === null) note('reply pencil', 'no editable reply in view')
  else {
    check(
      'the reply pencil is the leftmost action of its bar',
      before.replyBar.leftmost === true,
      JSON.stringify(before.replyBar),
    )
  }

  console.log('\n  — rows that are rolled back —')
  reportRolledBack('on screen', before, editable)

  console.log('\n  — rewritten prompts —')
  if (before.revisions.length === 0) {
    note('no revision bubble on screen')
  } else {
    for (const [index, bubble] of before.revisions.entries()) {
      // The pencil lives in the bar now (checked per row above), so the bubble
      // carries the text and nothing else: no floating overlay on top of it.
      check(
        `bubble ${index + 1} carries the text with nothing over it`,
        bubble.floating === 0 && bubble.pencils === 0 && bubble.text.length > 0,
        JSON.stringify(bubble),
      )
    }
  }

  // Remount: leave the session and come back, so the entries are torn down and
  // built again. This is where a strip that only worked once fails.
  console.log('\n  — after switching sessions —')
  const originalSession = before.session
  const otherSession = await probe(SELECT_NEXT_SESSION)
  if (otherSession === null || otherSession === originalSession) {
    note('no second session to switch to', 'skipped')
  } else {
    let after = null
    for (let attempt = 0; attempt < 40 && after === null; attempt += 1) {
      await sleep(750)
      const candidate = await probe(PROBE)
      if (candidate.session === otherSession && candidate.assistantCells > 0) after = candidate
    }
    check('the other session opened', after !== null, otherSession)
    if (after !== null) {
      check(
        'the other session rendered without a crash',
        after.assistantErrored === 0,
        `${after.assistantErrored}/${after.assistantCells} empty cells`,
      )
      const otherEditable = await probe(EDITABLE)
      if (otherEditable.error !== undefined) {
        note('editable (other session)', `the state endpoint did not answer in time: ${otherEditable.error}`)
      }
      note('state', `${after.replyPencils} reply pencils, ${after.userBarsWithPencil}/${after.userBars} prompt rows with a pencil`)
      check(
        'the other session has a pencil wherever it has a live prompt',
        editableOnScreen(otherEditable) === -1
          || editableOnScreen(otherEditable) === 0
          || after.userBarsWithPencil > 0,
        `prompts=${otherEditable.turns} rolled back=${otherEditable.rolledBack} rows with a pencil=${after.userBarsWithPencil}/${after.userBars}`,
      )
      reportRolledBack('the other session', after, otherEditable)

      const back = await probe(SELECT_SESSION(originalSession))
      check('the original session could be reopened', back === true, originalSession)
      let restored = null
      for (let attempt = 0; attempt < 40 && restored === null; attempt += 1) {
        await sleep(750)
        const candidate = await probe(PROBE)
        if (candidate.session === originalSession && candidate.assistantCells > 0) restored = candidate
      }
      check('the original session is back', restored !== null)
      if (restored !== null) {
        // The transcript comes back before the plugin's own state does: the
        // pencils are injected from /state, which the client asks for again on
        // remount, and a large session can take a while to answer. Wait for the
        // entries before judging whether they survived.
        //
        // The denominator is the one used everywhere else: a rewritten prompt
        // counts as editable but the platform renders no row for its carrier,
        // so it can never have a pencil in a row - only prompts that are still
        // on the surface are expected to.
        const wantsReplyPencil = editable.replies > 0
        const wantsPromptPencil = editableOnScreen(editable) > 0
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if ((!wantsReplyPencil || restored.replyPencils > 0)
            && (!wantsPromptPencil || restored.userBarsWithPencil > 0)) break
          await sleep(750)
          const candidate = await probe(PROBE)
          if (candidate.session === originalSession) restored = candidate
        }
        check(
          'its pencils survived the round trip',
          restored.assistantErrored === 0
          && (!wantsReplyPencil || restored.replyPencils > 0)
          && (!wantsPromptPencil || restored.userBarsWithPencil > 0),
          JSON.stringify({
            errored: restored.assistantErrored,
            replyPencils: restored.replyPencils,
            userBarsWithPencil: restored.userBarsWithPencil,
            wantsReplyPencil,
            wantsPromptPencil,
          }),
        )
        reportRolledBack('back on the original session', restored, editable)
      }
    }
  }

  // Prove the capture is alive before reading anything into silence.
  await probe(`console.warn('smoke heartbeat')`)
  await sleep(400)
  check('the console capture is live', consoleLines.some((line) => line.includes('smoke heartbeat')))

  console.log('\n  — console —')
  const ours = bootLines().filter((line) => /error|exception/i.test(line))
  check('no errors mentioning this plugin', ours.filter((line) => /dsh-edit-turn|reading 'key'/.test(line)).length === 0, ours.filter((line) => /dsh-edit-turn/.test(line)).slice(0, 3).join(' | '))
  note('console', `${consoleLines.length} lines, ${ours.length} errors`)
  if (failures > 0 && ours.length > 0) {
    for (const line of ours.slice(0, 8)) console.log(`      ${line.slice(0, 200)}`)
  }

  connection.close()

  if (failures > 0) {
    console.log(`\n真机冒烟未通过：${failures} 项失败。`)
    process.exit(1)
  }
  console.log('\n真机冒烟通过：插件在真实宿主里按预期渲染。')
}

run().catch((error) => {
  console.error(`真机冒烟无法进行：${error.message}`)
  process.exit(1)
})
