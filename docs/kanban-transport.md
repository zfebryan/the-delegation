# Integrasi event kanban eksternal (WebSocket) — the-delegation

Implementasi Seam A (ingress) + Seam C (disarm) dari
`docs/research/the-delegation-integration.md`. Layer 3D
(`SceneManager`, `CharacterController`, `NpcAgentDriver`) **tidak diubah**: karakter tetap
bergerak sebagai refleks dari `coreStore.tasks` dan `uiStore.agentStatuses`.

## 1. Mode runtime

| Env var | Arti |
|---|---|
| `VITE_KANBAN_WS_URL` | URL WebSocket bridge (mis. `ws://127.0.0.1:8000/ws`). Terisi → **mode remote**. Kosong → mode lokal. |
| `VITE_KANBAN_TRANSPORT_MODE` | Paksa `remote`/`local` (opsional). |
| `VITE_KANBAN_WS_RECONNECT_MIN_MS` / `_MAX_MS` | Batas backoff reconnect (default 500 / 15000). |
| `VITE_KANBAN_WS_HEARTBEAT_MS` / `_TIMEOUT_MS` | Interval ping dan ambang pong (default 15000 / 10000). |
| `VITE_KANBAN_WS_DEDUPE_SIZE` | Ukuran cache id event (default 500). |
| `VITE_KANBAN_AGENT_MAP` | Tabel `assignee` → `agentIndex` (default `dev:2,qa:3`), lihat §7.1. |
| `VITE_KANBAN_BRIDGE_ADAPTER` | `auto` (default) = frame `kanban-ws-bridge` diterjemahkan adapter; `off` = hanya amplop §6.2. |
| `VITE_KANBAN_BACKLOG_MODE` | `snapshot` (default) = frame `backlog` dirangkum jadi `board.snapshot`; `ignore` = dibuang. |

`vite.config.ts` juga menerima nama tanpa prefix (`KANBAN_WS_URL`, `KANBAN_TRANSPORT_MODE`)
sehingga nilai yang hanya ada di shell/CI tetap ikut ter-bundle. Lihat `.env.example`.

**Mode lokal tetap seperti semula**: loop Gemini, heartbeat 5 detik, spark, BYOK — semuanya
hanya aktif bila `mode === 'local'`.

## 2. Yang dimatikan di mode remote (disarm)

| Titik | File | Guard |
|---|---|---|
| Heartbeat 5s + subscribe `coreStore`/`uiStore` | `src/simulation/core/AgentSimulation.ts` | `startStateMonitoring()` early return |
| Eksekusi task / spark / conclude | `AgentSimulation.ts` | `processScheduledTasks`, `triggerAutonomousStrategy`, `checkProjectCompletion` |
| Chat user ke brain lokal | `AgentSimulation.handleUserMessage` | return `null` |
| Panggilan Gemini | `src/core/agent/AgentBrain.ts` | `think()` early return **sebelum** cek API key → modal BYOK tidak muncul |
| Generasi aset final | `AgentBrain.ts` | `handleFinalAssetGeneration`, `processFinalAsset` |

Akibatnya `debugLog` tetap kosong dan tidak ada request keluar ke Gemini di mode remote.

## 3. Ingress: event → aksi store

Alur: `wsClient` → **`BridgeAdapter`** (frame datar `kanban-ws-bridge` → amplop §6.2) → `EventDedupe`
(id + gap `seq`) → `KanbanEventMapper` → aksi store.
Gap `seq`, reconnect, dan pergantian tim memicu `board.snapshot.request` (resync).
Adapter hanya menyentuh frame yang dikenal sebagai milik bridge; amplop §6.2 apa adanya
dilewatkan tanpa perubahan (`passthrough`), jadi server §6.2 sungguhan tetap bisa dipakai
(`VITE_KANBAN_BRIDGE_ADAPTER=off` untuk memaksa jalur itu).

| Event | Aksi store |
|---|---|
| `project.brief_received {brief}` | `startProject(brief)` |
| `project.phase_changed {phase}` | `setPhase` |
| `project.final_output {output}` | `setFinalOutput` + `setPhase('done')` |
| `project.asset_ready {type,content}` | `setFinalAsset` (`music` → `audio`) + `setPhase('done')` |
| `board.snapshot {tasks,phase,brief,agentStatuses}` | `applySnapshot` (aksi baru; id task eksternal dipakai apa adanya) |
| `task.created {task}` | `addTask` (menerima `id` eksternal; id duplikat diabaikan) |
| `task.status_changed {taskId,status}` | `updateTaskStatus(..., {force:true})`, atau `reopenTask` bila `done → in_progress/on_hold` |
| `task.output_ready {taskId,output}` | `setTaskOutput` |
| `task.review_requested {taskId,draft}` | `submitTaskForReview` |
| `task.approved {taskId}` | `approveTask` |
| `task.rejected {taskId,comments}` | `rejectTask(..., {writeHistory:false})` — server pemilik riwayat |
| `agent.status_changed {agentIndex,status}` | `uiStore.setAgentStatus` (index harus ada di tim aktif) |
| `agent.message {agentIndex,role,content}` | `appendAgentHistory` |
| `agent.replace_history {agentIndex,messages}` | `setAgentHistory` |
| `action_log.appended {agentIndex,action,taskId}` | `addLogEntry` |
| `llm.usage {...}` | `addResponseLog` |

Event/field yang tidak dikenal **diabaikan** (dicatat sebagai `ignored`/`rejected`), tidak
memicu error. Event untuk `agentIndex` di luar tim aktif ditolak (bukan ditulis ke store).

## 4. Egress (persiapan)

`kanbanTransport.sendCommand(type, payload)` sudah dipakai untuk `board.snapshot.request` dan
siap dipakai fase berikutnya (`chat.send`, `board.approve_task`, `board.reject_task`).
Pengiriman perintah dari UI (AuditModal/KanbanPanel/chat) **belum** dialihkan — itu fase 3 di
dokumen riset.

## 5. Heartbeat & liveness (penting untuk bridge)

`wsClient` mengirim `{type:'ping'}` tiap `VITE_KANBAN_WS_HEARTBEAT_MS`. Aturan liveness:

- setiap frame masuk (event, `pong`, `keepalive`) menyegarkan jam liveness;
- `heartbeatTimeoutMs` **hanya** menutup socket bila peer pernah menjawab `ping` dengan `pong`
  (bukti peer memang bicara protokol ini). Peer yang hanya diam atau mengirim `keepalive`
  sendiri tidak pernah dianggap mati karena pong yang hilang — deteksi mati diserahkan ke
  `onclose`/`onerror`, supaya tidak terjadi loop reconnect.

Alasannya konkret: bridge `kanban-ws-bridge` tidak membalas `ping` (loop-nya hanya
`receive_text()`), sehingga socket yang sehat akan ditutup paksa tiap siklus heartbeat dan
selalu memicu `board.snapshot.request` baru.

Terukur ulang pada bridge nyata di `ws://127.0.0.1:8000/ws` (Node 26, ping 1s, timeout 800ms,
reconnect 300ms, 8 detik): aturan lama → **6 close paksa / 6 reconnect**; aturan sekarang →
**0 close paksa** (socket tetap `online`). Reproduksi tanpa menyentuh kode app:

```bash
node scripts/kanban-transport/old-rule-probe.mjs ws://127.0.0.1:8000/ws
```

## 6. Verifikasi (tanpa `npm run build`/`tsc` di lingkungan ini)

Host ini hanya punya 4 GB RAM (`tsc --noEmit` dan `vite build` pernah OOM di sini), jadi
verifikasi dilakukan dengan membaca ulang kode + harness Node yang dibundel `esbuild`
(dependensi transitif vite, tanpa `npm install` tambahan):

```bash
# 1) config + dedupe + mapper murni, store palsu (29 assertion)
./node_modules/.bin/esbuild scripts/kanban-transport/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-smoke.mjs && node /tmp/kb-smoke.mjs

# 2) adapter bridge → §6.2: pemetaan assignee/status, backlog, NACK, dedupe (36 assertion)
./node_modules/.bin/esbuild scripts/kanban-transport/bridge-smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-bridge.mjs && node /tmp/kb-bridge.mjs

# 3) klien nyata terhadap bridge nyata melalui adapter (butuh bridge jalan di :8000)
./node_modules/.bin/esbuild scripts/kanban-transport/live.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-live.mjs && node /tmp/kb-live.mjs ws://127.0.0.1:8000/ws

# 4) heartbeat dengan WebSocket palsu (peer diam vs peer yang menjawab pong)
./node_modules/.bin/esbuild scripts/kanban-transport/heartbeat.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-hb.mjs && node /tmp/kb-hb.mjs
```

Keempat harness TypeScript di `scripts/kanban-transport/` memakai `@ts-nocheck` supaya tidak ikut
menambah diagnostik ke `npm run lint`, dan tidak menarik dependensi baru (`esbuild` ikut bersama
vite). `old-rule-probe.mjs` (JS murni, `node` langsung) hanya untuk mereproduksi aturan liveness
lama; lihat §5.

Hasil terakhir (host 4 GB, bridge hidup di `ws://127.0.0.1:8000/ws`): harness (1)
`ALL CHECKS PASSED` (29 assertion); (2) `ALL CHECKS PASSED` (36 assertion, adapter); (3) lihat
§7.6 — frame `backlog` nyata jadi `applied:board.snapshot`, event di dalamnya (`task_added`,
`status_changed`) jadi `applied:task.created` / `applied:task.status_changed`, 0 reconnect;
(4) peer diam → tetap `online` tanpa close paksa, peer yang menjawab `pong` lalu diam →
`heartbeat timeout` lalu socket ditutup dan reconnect dijadwalkan.

Sebelum merge, jalankan `npm ci && npm run lint && npm run build` di mesin yang punya RAM cukup:

```bash
npm run build                                             # tanpa env → mode lokal
VITE_KANBAN_WS_URL=ws://127.0.0.1:8000/ws npm run build    # mode remote, URL ikut ter-bundle
```

Indikator koneksi muncul di header (`board online|connecting|offline`) hanya saat mode remote.

## 7. Adapter `kanban-ws-bridge` → amplop §6.2

Bridge di repo `criminals-sandbox` (service `kanban-ws-bridge`) memakai format frame sendiri:

| Aspek | Bridge | Kontrak §3 |
|---|---|---|
| Nama event | `task_added`, `status_changed`, `task_updated`, `task_removed`, `backlog`, `poll_error`, `poll_recovered`, `keepalive` | `task.created`, `task.status_changed`, … |
| Amplop | datar (`task_id`, `task`, `changes`, `to_status`) | `{v,id,type,seq,ts,projectId,agentIndex?,taskId?,payload}` |
| Id task | id kartu Hermes (`t_29bcaba1`) | bebas, dipakai apa adanya oleh `addTask`/`applySnapshot` |
| Pemilik task | `assignee` = nama profil (`dev`) | `assignedAgentId` = index integer tim aktif |
| Status | enum Hermes kanban (todo/ready/running/blocked/review/done) | `scheduled/on_hold/in_progress/done` |
| Alive | `{type:'keepalive'}` tiap 30s idle | `pong` |
| `seq`/`ts` | **ada** per event (`poller._emit()`), hanya pembungkus `backlog` yang tidak punya | `seq`/`ts` opsional |

`src/integration/transport/BridgeAdapter.ts` menjembatani keduanya; ia murni (tanpa socket/store)
dan dipanggil `KanbanTransport.handleFrame()` sebelum dedupe/mapper.

### 7.1 `assignee` → `agentIndex`: tabel eksplisit (bukan urutan tim)
`VITE_KANBAN_AGENT_MAP=dev:2,qa:3` (default kode sama; index `0`=user, `1`=lead, `2..4`=subagent).
Urutan `getAllAgents(getActiveAgentSet())` ditolak sebagai sumber pemetaan karena berbeda antar
team set (1 agen di `strategy-coach`, index sampai 5 di `music-studio`), jadi "orang ke-N" bukan
identitas yang stabil — salah petakan berarti karakter 3D berjalan ke meja/boardroom yang salah.

Dua gerbang: nama harus ada di tabel (`unknown_assignee`), dan index hasilnya harus ada di tim
aktif (`agent_not_in_team`). Gagal salah satu → event **dibuang** dan `event.nack` dikirim
(`{type:'event.nack', reason, bridgeType, taskId, assignee}`); NACK di-dedupe per
reason/task dan dibatasi 200 entri per sesi. Bridge mengabaikan frame masuk, jadi NACK adalah
observabilitas (counter `nackedEvents` di `transportStore`), bukan flow control.

### 7.2 Terjemahan status (dua arah, arah balik lossy)
| Hermes kanban | §6.2 `TaskStatus` |
|---|---|
| `todo`, `ready`, `triage` | `scheduled` |
| `running` | `in_progress` |
| `blocked`, `review` | `on_hold` |
| `done` | `done` |
| lain (`archived`, …) | **tidak ditebak**: event dibuang + NACK `unknown_status` |

Balik (untuk egress nanti): `scheduled → ready`, `in_progress → running`, `on_hold → review`,
`done → done`. Lossy dan disengaja: `todo`/`ready` (dan `blocked`/`review`) bertemu di satu nilai.
`blocked`/`review` → `on_hold` dipilih karena §7.8 dokumen riset: `on_hold` = menunggu manusia
**dan** = di boardroom, dan kedua status Hermes itu memang menunggu manusia.

### 7.3 Amplop & `seq`/`id`
Bridge memang mengirim `seq` (naik monoton per proses bridge) dan `ts` (Unix detik) di setiap
event — terverifikasi pada bridge nyata (`GET /events`). Jadi:
`id` disintesis `bridge:<seq>` (fallback `bridge:<type>:<taskId>:<ts>`), `seq` diteruskan apa
adanya, `ts` dikonversi detik → milidetik. Dedupe **tetap aktif** (replay `backlog` setelah
reconnect terdeteksi duplikat) dan gap-detection `seq` **tetap aktif** (event bridge yang hilang
memang mungkin). Konsekuensinya `requestSnapshot('seq_gap')` tetap dikirim, tetapi bridge belum
menjawabnya (§7.5).

### 7.4 Batch backlog → `board.snapshot`
Frame `backlog` berisi 50 event terakhir (bukan state task). Adapter merangkumnya jadi **satu**
`board.snapshot`: state terakhir per `task_id` (last-write-wins), task yang terakhir muncul sebagai
`task_removed` dibuang, `phase` diturunkan (`semua done → done`, ada `in_progress`/`on_hold` →
`working`, sisanya `idle`), dan `seq` diisi `seq` tertinggi yang di-replay supaya event live
pertama terhitung contiguous (bukan baseline baru). Bisa dimatikan dengan
`VITE_KANBAN_BACKLOG_MODE=ignore` (stream murni delta).

### 7.5 Gap yang diketahui (bukan bug)
- `task_updated` / `task_removed` **tidak** dipetakan: kontrak §6.2 tidak punya `task.updated` /
  `task.removed`, dan `removeTask` lokal menendang `phase → done` sebagai efek samping
  (risiko #3 dokumen riset). Keduanya dibuang + NACK (`non_status_change_not_supported` /
  `removal_not_supported`) supaya divergensi terlihat, bukan senyap. Efek nyata: perubahan
  `title`/`priority`/`assignee` pada kartu yang sudah ada tidak mengubah board 3D.
- `poll_error` / `poll_recovered` dicatat sebagai `ignored` (`bridge_poll_error` /
  `bridge_poll_recovered`), tidak fatal — bridge memang bisa gagal polling sesaat.
- Bridge belum membalas `ping` dengan `pong` dan belum punya endpoint snapshot: resync
  `board.snapshot.request` tidak dijawab. Mitigasi sementara: bootstrap dari `backlog` (§7.4).
  Perbaikan sisi bridge sudah jadi kartu lanjutan `t_e5fc6584`.

### 7.6 Verifikasi adapter (hasil nyata)
- `scripts/kanban-transport/bridge-smoke.ts` → `ALL CHECKS PASSED` (36 assertion): tabel
  `assignee`, tabel status dua arah, `task_added`→`task.created`, `status_changed`→
  `task.status_changed`, `blocked`→`on_hold`, NACK untuk `unknown_assignee` /
  `agent_not_in_team` / `unknown_status` / malformed, `task_updated`/`task_removed` ditolak
  eksplisit, `poll_error`/`keepalive`, rangkuman `backlog` (termasuk `phase` dan baseline `seq`),
  dedupe + gap, dan jalur ujung-ke-ujung adapter → mapper (store calls nyata).
- `scripts/kanban-transport/live.ts` terhadap bridge nyata: 0 reconnect, frame `backlog` →
  `applied:board.snapshot`; event di dalam backlog (payload nyata dari bridge) di-replay lewat
  adapter yang sama → `applied:task.created` + `applied:task.status_changed` (dengan store task
  in-memory, bukan lagi `ignored:unknown_type`).
