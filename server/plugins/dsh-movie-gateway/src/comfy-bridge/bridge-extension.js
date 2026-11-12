/**
 * dsh_movie canvas bridge extension (Phase-2 M5, Phase-3 §3).
 *
 * This file runs INSIDE the pinned ComfyUI frontend iframe. It is our own code
 * (not ComfyUI source) served by the DSH host gateway at
 * `/comfy/extensions/dsh-movie-bridge.js` and listed by `/comfy/api/extensions`.
 * No ComfyUI code is vendored into our bundle; we only consume the frontend's
 * public `window.comfyAPI` surface.
 *
 * It implements the iframe side of the versioned postMessage bridge whose
 * contract is the single source of truth in `@dsh-movie/protocol/bridge`
 * (`{ v: 1, txn?, type, payload }`). Parent -> iframe commands mutate/paint the
 * LiteGraph graph; iframe -> parent events report readiness, selection, edits,
 * and painted execution status. The movie-step node TYPES themselves come from
 * `/comfy/api/object_info` (generated from the protocol node registry), so
 * ComfyUI registers them natively; this extension only wires the bridge.
 */
(() => {
  'use strict'

  const BRIDGE_VERSION = 1
  const PARENT_ORIGIN = window.location.origin // same-origin deployment

  /** Resolve the ComfyUI app/LiteGraph handles from the frontend's public API. */
  function getApp() {
    return (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) || null
  }
  function getLiteGraph() {
    return (window.comfyAPI && window.comfyAPI.litegraph && window.comfyAPI.litegraph.LiteGraph) || window.LiteGraph || null
  }

  /** Node header color per run status (a visible, dependency-free status badge). */
  const STATUS_COLOR = {
    idle: undefined,
    queued: '#8a8a8a',
    running: '#2f7fd6',
    progress: '#e0a020',
    success: '#2fae5f',
    error: '#d64545',
  }

  let ready = false
  const pending = []

  /** Post an iframe -> parent event over the versioned envelope. */
  function emit(type, payload, txn) {
    const message = { v: BRIDGE_VERSION, type, payload }
    if (txn !== undefined) message.txn = txn
    try {
      window.parent.postMessage(message, PARENT_ORIGIN)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[dsh-bridge] postMessage failed', error)
    }
  }

  function emitError(code, message, txn) {
    emit('bridgeError', { code, message }, txn)
  }

  /* ----------------------------- command impls ---------------------------- */

  function findNode(app, id) {
    const graph = app.graph
    if (!graph) return null
    return graph.getNodeById(Number(id))
  }

  const commands = {
    'hello/version': (app, payload) => {
      // Re-assert readiness in case the parent (re)handshakes after a reload.
      emit('ready', { version: BRIDGE_VERSION })
      if (payload && payload.version !== BRIDGE_VERSION) {
        emitError('version-mismatch', `parent v${payload.version} vs bridge v${BRIDGE_VERSION}`)
      }
    },
    'graph.load': (app, payload) => {
      const graph = payload && payload.graph
      if (!graph) throw new Error('graph.load requires payload.graph')
      if (typeof app.loadGraphData === 'function') app.loadGraphData(graph)
      else app.graph.configure(graph)
      if (app.canvas && typeof app.canvas.zoomToFitNodes === 'function') {
        try { app.canvas.zoomToFitNodes() } catch { /* best effort */ }
      }
      return { nodes: (app.graph && app.graph._nodes ? app.graph._nodes.length : 0) }
    },
    'graph.export': (app) => ({ graph: app.graph ? app.graph.serialize() : null }),
    'node.add': (app, payload) => {
      const LG = getLiteGraph()
      if (!LG) throw new Error('LiteGraph unavailable')
      const node = LG.createNode(payload.nodeType)
      if (!node) throw new Error(`unknown node type: ${payload.nodeType}`)
      if (payload.pos) node.pos = payload.pos
      if (payload.id !== undefined) node.id = Number(payload.id)
      if (payload.props) {
        for (const key of Object.keys(payload.props)) {
          const widget = (node.widgets || []).find((w) => w.name === key)
          if (widget) widget.value = payload.props[key]
        }
      }
      app.graph.add(node)
      app.graph.setDirtyCanvas(true, true)
      return { id: node.id }
    },
    'node.remove': (app, payload) => {
      const node = findNode(app, payload.id)
      if (!node) throw new Error(`no node ${payload.id}`)
      app.graph.remove(node)
      app.graph.setDirtyCanvas(true, true)
      return { id: Number(payload.id) }
    },
    'node.move': (app, payload) => {
      const node = findNode(app, payload.id)
      if (!node) throw new Error(`no node ${payload.id}`)
      node.pos = [payload.x, payload.y]
      app.graph.setDirtyCanvas(true, true)
      return { id: node.id }
    },
    'node.setWidget': (app, payload) => {
      const node = findNode(app, payload.id)
      if (!node) throw new Error(`no node ${payload.id}`)
      const widget = (node.widgets || []).find((w) => w.name === payload.key)
      if (!widget) throw new Error(`no widget ${payload.key} on node ${payload.id}`)
      widget.value = payload.value
      app.graph.setDirtyCanvas(true, true)
      return { id: node.id, key: payload.key }
    },
    'node.setStatus': (app, payload) => {
      const status = paintStatus(app, payload.id, payload.status)
      return { id: Number(payload.id), status }
    },
    'edge.add': (app, payload) => {
      const from = findNode(app, payload.fromId)
      const to = findNode(app, payload.toId)
      if (!from || !to) throw new Error('edge.add: missing endpoint node')
      const link = from.connect(payload.fromSlot, to, payload.toSlot)
      app.graph.setDirtyCanvas(true, true)
      return { link: link ? (link.id !== undefined ? link.id : link) : null }
    },
    'edge.remove': (app, payload) => {
      const graph = app.graph
      if (graph && typeof graph.removeLink === 'function') graph.removeLink(Number(payload.id))
      app.graph.setDirtyCanvas(true, true)
      return { id: Number(payload.id) }
    },
    'group.collapse': (app, payload) => {
      const groups = (app.graph && app.graph._groups) || []
      const group = groups.find((g) => g.title === payload.title)
      if (!group) throw new Error(`no group ${payload.title}`)
      if (typeof group.collapse === 'function') {
        if (payload.collapsed && !group.collapsed) group.collapse()
        else if (!payload.collapsed && group.collapsed) group.uncollapse && group.uncollapse()
      } else {
        group.collapsed = !!payload.collapsed
      }
      app.graph.setDirtyCanvas(true, true)
      return { title: payload.title, collapsed: !!payload.collapsed }
    },
    'view.fit': (app, payload) => {
      const canvas = app.canvas
      if (!canvas) return {}
      if (typeof canvas.zoomToFitNodes === 'function') canvas.zoomToFitNodes()
      else if (typeof canvas.fitToView === 'function') canvas.fitToView()
      return { ids: (payload && payload.ids) || null }
    },
    'setReadonly': (app, payload) => {
      const readonly = !!(payload && payload.readonly)
      const canvas = app.canvas
      if (canvas) {
        // LGraphCanvas gate: disables drag/connect/edit while locked.
        canvas.allow_interaction = !readonly
        if (typeof canvas.setDirty === 'function') canvas.setDirty(true, true)
      }
      // Belt-and-braces: block pointer events on the canvas element too.
      const el = canvas && canvas.canvas
      if (el && el.style) el.style.pointerEvents = readonly ? 'none' : ''
      return { readonly }
    },
  }

  /** Paint a run-status badge on a node; returns the status actually applied. */
  function paintStatus(app, id, status) {
    const node = findNode(app, id)
    if (!node) return status
    const color = STATUS_COLOR[status]
    if (color === undefined) delete node.boxcolor
    else node.boxcolor = color
    node.dshStatus = status
    if (app.graph && typeof app.graph.setDirtyCanvas === 'function') app.graph.setDirtyCanvas(true, true)
    emit('execPainted', { id: Number(id), status })
    return status
  }

  /* --------------------------- command dispatch --------------------------- */

  function runCommand(app, message) {
    const handler = commands[message.type]
    if (!handler) {
      emitError('unknown-command', `no handler for ${message.type}`, message.txn)
      return
    }
    try {
      const data = handler(app, message.payload || {})
      if (message.txn !== undefined) {
        emit('commandResult', { txn: message.txn, ok: true, data: data === undefined ? null : data }, message.txn)
      }
    } catch (error) {
      const text = error && error.message ? error.message : String(error)
      if (message.txn !== undefined) emit('commandResult', { txn: message.txn, ok: false, error: text }, message.txn)
      else emitError('command-failed', `${message.type}: ${text}`, message.txn)
    }
  }

  function onMessage(event) {
    if (event.origin !== PARENT_ORIGIN) return // same-origin guard
    const message = event.data
    if (!message || message.v !== BRIDGE_VERSION || typeof message.type !== 'string') return
    // Only handle parent -> iframe commands (ignore our own echoed events).
    if (!Object.prototype.hasOwnProperty.call(commands, message.type)) return
    const app = getApp()
    if (!app || !ready) {
      pending.push(message)
      return
    }
    runCommand(app, message)
  }

  function flushPending(app) {
    while (pending.length > 0) runCommand(app, pending.shift())
  }

  /* --------------------- Leg B lifecycle -> status paint ------------------- */

  function wireExecEvents(app) {
    const api = app.api
    if (!api || typeof api.addEventListener !== 'function') return
    // ComfyUI's api.js dispatches differing `detail` shapes per event:
    //  - `executing`: detail IS the node id (string|null); null means "finished".
    //  - `progress` / `executed`: detail is the message data object ({ node, ... }).
    //  - `execution_error`: detail is the data object carrying `node_id`.
    // Normalize all of them to a node id before painting.
    function nodeIdOf(detail, key) {
      if (detail === null || detail === undefined) return null
      if (typeof detail === 'string' || typeof detail === 'number') return detail
      const value = key !== undefined ? detail[key] : undefined
      if (value === null || value === undefined) return typeof detail.node !== 'undefined' ? detail.node : null
      return value
    }
    const paint = (nodeId, status) => {
      if (nodeId === null || nodeId === undefined || nodeId === '') return
      paintStatus(app, nodeId, status)
    }
    api.addEventListener('executing', (e) => {
      const node = nodeIdOf(e ? e.detail : null, 'node')
      // ComfyUI sends executing(null) when the whole prompt finishes.
      if (node === null || node === undefined) return
      paint(node, 'running')
    })
    api.addEventListener('progress', (e) => {
      paint(nodeIdOf(e ? e.detail : null, 'node'), 'progress')
    })
    api.addEventListener('executed', (e) => {
      paint(nodeIdOf(e ? e.detail : null, 'node'), 'success')
    })
    api.addEventListener('execution_error', (e) => {
      paint(nodeIdOf(e ? e.detail : null, 'node_id'), 'error')
    })
  }

  /* ------------------------- selection + edit events ---------------------- */

  function wireSelection(app) {
    const canvas = app.canvas
    if (!canvas) return
    const prevSelected = canvas.onNodeSelected
    const prevDeselected = canvas.onNodeDeselected
    canvas.onNodeSelected = (node) => {
      emit('nodeSelected', { id: node ? Number(node.id) : null })
      if (typeof prevSelected === 'function') prevSelected(node)
    }
    canvas.onNodeDeselected = (node) => {
      emit('nodeSelected', { id: null })
      if (typeof prevDeselected === 'function') prevDeselected(node)
    }
  }

  let graphChangedTimer = null
  function wireGraphChanged(app) {
    const graph = app.graph
    if (!graph) return
    const schedule = () => {
      if (graphChangedTimer) clearTimeout(graphChangedTimer)
      graphChangedTimer = setTimeout(() => {
        graphChangedTimer = null
        try {
          emit('graphChanged', { graph: graph.serialize(), rev: Date.now() })
        } catch { /* ignore serialize races */ }
      }, 400)
    }
    // LiteGraph exposes an onGraphChanged hook on newer builds; wrap if present.
    const prev = graph.onGraphChanged
    graph.onGraphChanged = (...args) => {
      schedule()
      if (typeof prev === 'function') prev.apply(graph, args)
    }
  }

  /* ------------------------------- register ------------------------------- */

  window.addEventListener('message', onMessage)

  const app = getApp()
  if (app && typeof app.registerExtension === 'function') {
    app.registerExtension({
      name: 'dsh.movie.bridge',
      async setup() {
        try {
          wireExecEvents(app)
          wireSelection(app)
          wireGraphChanged(app)
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[dsh-bridge] wiring failed', error)
        }
        ready = true
        emit('ready', { version: BRIDGE_VERSION })
        flushPending(app)
      },
    })
  } else {
    // Fallback: the app handle was not ready at import time. Poll briefly, then
    // mark ready so a parent that only needs status/selection still works.
    let tries = 0
    const poll = setInterval(() => {
      const lateApp = getApp()
      tries += 1
      if (lateApp) {
        clearInterval(poll)
        try {
          wireExecEvents(lateApp)
          wireSelection(lateApp)
          wireGraphChanged(lateApp)
        } catch { /* ignore */ }
        ready = true
        emit('ready', { version: BRIDGE_VERSION })
        flushPending(lateApp)
      } else if (tries > 100) {
        clearInterval(poll)
        emitError('no-app', 'ComfyUI app handle never became available')
      }
    }, 100)
  }
})()
