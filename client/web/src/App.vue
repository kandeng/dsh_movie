<script setup>
import { ref } from 'vue'
import * as sdk from 'matrix-js-sdk'
import { config } from './config.js'

// The live matrix-js-sdk client is intentionally non-reactive: it is a large,
// self-referential object that Vue should not proxy.
let matrixClient = null
const seenEventIds = new Set()

const user = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

const loggedIn = ref(false)
const userId = ref('')
const principal = ref(null)
const principalId = ref('')
const principalError = ref('')
const roomId = ref('')
const messages = ref([])
const draft = ref('')

/** Classify a sender relative to the logged-in user and the bot. */
function kindOf(sender) {
  if (sender === userId.value) return 'me'
  if (sender === config.botUserId) return 'bot'
  return 'other'
}

/** Push one timeline event into the message list, de-duplicated by event id. */
function ingest(event) {
  if (event.getType() !== 'm.room.message') return
  const id = event.getId()
  if (id && seenEventIds.has(id)) return
  if (id) seenEventIds.add(id)
  const content = event.getContent() ?? {}
  if (content.msgtype !== 'm.text') return
  const sender = event.getSender() ?? ''
  messages.value.push({
    id: id ?? `${messages.value.length}`,
    sender,
    name: event.sender?.name ?? sender,
    body: content.body ?? '',
    kind: kindOf(sender),
  })
}

/** Load the room's existing timeline after the initial sync completes. */
function loadRoom() {
  const room = matrixClient?.getRoom(roomId.value)
  if (!room) return
  for (const event of room.timeline) ingest(event)
}

/** Prove the browser->host principal path via the identity plugin's /auth listener. */
async function provePrincipal(accessToken) {
  try {
    const resp = await fetch(`${config.authUrl}/auth/principal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: accessToken }),
    })
    const data = await resp.json()
    if (resp.ok && data.ok) {
      principal.value = data.principal
      principalId.value = data.principalId
      principalError.value = ''
    } else {
      principalError.value = data.error ?? `host responded ${resp.status}`
    }
  } catch (err) {
    principalError.value = `unreachable: ${String(err)}`
  }
}

async function onLogin() {
  busy.value = true
  error.value = ''
  try {
    matrixClient = sdk.createClient({ baseUrl: config.homeserverUrl })
    const res = await matrixClient.loginWithPassword(user.value.trim(), password.value)
    const accessToken = res.access_token ?? matrixClient.getAccessToken()
    userId.value = res.user_id

    // Mode-B trust anchor: hand the Synapse token to the DSH host, which
    // introspects it and maps it back to a principal.
    await provePrincipal(accessToken)

    // Resolve the one room: a pre-seeded id, or a fresh room inviting the bot.
    if (config.demoRoomId) {
      roomId.value = config.demoRoomId
      await matrixClient.joinRoom(roomId.value)
    } else {
      const created = await matrixClient.createRoom({
        name: 'Movie Room',
        preset: 'private_chat',
        invite: [config.botUserId],
      })
      roomId.value = created.room_id
    }

    matrixClient.on(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) return
      if (room && room.roomId !== roomId.value) return
      ingest(event)
    })
    matrixClient.on(sdk.ClientEvent.Sync, (state) => {
      if (state === sdk.SyncState.Prepared) loadRoom()
    })

    await matrixClient.startClient({ initialSyncLimit: 50 })
    loggedIn.value = true
  } catch (err) {
    error.value = String(err?.message ?? err)
  } finally {
    busy.value = false
  }
}

async function sendMessage() {
  const text = draft.value.trim()
  if (text === '' || !matrixClient) return
  draft.value = ''
  try {
    await matrixClient.sendTextMessage(roomId.value, text)
  } catch (err) {
    error.value = String(err?.message ?? err)
  }
}

function logout() {
  try {
    matrixClient?.stopClient()
    matrixClient?.removeAllListeners()
  } catch {
    // best-effort teardown
  }
  matrixClient = null
  seenEventIds.clear()
  loggedIn.value = false
  userId.value = ''
  principal.value = null
  principalId.value = ''
  principalError.value = ''
  roomId.value = ''
  messages.value = []
  draft.value = ''
  error.value = ''
}
</script>

<template>
  <main>
    <section v-if="!loggedIn" class="card">
      <h1>DSH Movie — Matrix client</h1>
      <p class="sub">Phase-1 minimal client: Synapse login (Mode B) + one room with the agent bot.</p>

      <label for="user">Matrix user (localpart or full mxid)</label>
      <input id="user" v-model="user" autocomplete="username" placeholder="movie_demo" />

      <label for="password">Password</label>
      <input id="password" v-model="password" type="password" autocomplete="current-password" placeholder="••••••••" />

      <button :disabled="busy" @click="onLogin">{{ busy ? 'Signing in…' : 'Sign in' }}</button>

      <p v-if="error" class="error">{{ error }}</p>

      <div class="hint">
        <div>homeserver: <span class="badge">{{ config.homeserverUrl }}</span></div>
        <div>host /auth: <span class="badge">{{ config.authUrl }}</span></div>
        <div>bot: <span class="badge">{{ config.botUserId }}</span></div>
      </div>
    </section>

    <section v-else class="card">
      <header class="room-head">
        <div>
          <h1>{{ userId }}</h1>
          <p class="sub">room <span class="badge">{{ roomId }}</span></p>
        </div>
        <button class="secondary" @click="logout">Sign out</button>
      </header>

      <div class="meta">
        <div v-if="principalId">
          host principal: <span class="badge">{{ principalId }}</span>
          <template v-if="principal">
            (verified <code>{{ principal.userId }}</code>, device <code>{{ principal.deviceId ?? '—' }}</code>)
          </template>
        </div>
        <div v-else class="error">principal path failed: {{ principalError }}</div>
      </div>

      <div class="timeline" style="margin-top: 12px">
        <div v-for="m in messages" :key="m.id" :class="['msg', m.kind]">
          <div class="who">{{ m.name }}</div>
          <div>{{ m.body }}</div>
        </div>
        <div v-if="messages.length === 0" class="sub">No messages yet — say hello to the bot.</div>
      </div>

      <div class="composer">
        <input v-model="draft" placeholder="Write a message…" @keyup.enter="sendMessage" />
        <button @click="sendMessage">Send</button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
    </section>
  </main>
</template>
