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

Alur: `wsClient` → `EventDedupe` (id + gap `seq`) → `KanbanEventMapper` → aksi store.
Gap `seq`, reconnect, dan pergantian tim memicu `board.snapshot.request` (resync).

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
selalu memicu `board.snapshot.request` baru. Perilaku ini terukur sebelum perbaikan:
6 reconnect dalam 8 detik terhadap bridge di `ws://127.0.0.1:8000/ws`.

## 6. Verifikasi (tanpa `npm run build`/`tsc` di lingkungan ini)

Host ini hanya punya 4 GB RAM (`tsc --noEmit` dan `vite build` pernah OOM di sini), jadi
verifikasi dilakukan dengan membaca ulang kode + harness Node yang dibundel `esbuild`
(dependensi transitif vite, tanpa `npm install` tambahan):

```bash
# 1) mapper/dedupe/config murni, store palsu (29 assertion)
./node_modules/.bin/esbuild scripts/kanban-transport/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-smoke.mjs && node /tmp/kb-smoke.mjs

# 2) klien nyata terhadap bridge nyata (butuh bridge jalan di :8000)
./node_modules/.bin/esbuild scripts/kanban-transport/live.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-live.mjs && node /tmp/kb-live.mjs ws://127.0.0.1:8000/ws

# 3) heartbeat dengan WebSocket palsu (peer diam vs peer yang menjawab pong)
./node_modules/.bin/esbuild scripts/kanban-transport/heartbeat.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-hb.mjs && node /tmp/kb-hb.mjs
```

Ketiga harness di `scripts/kanban-transport/` memakai `@ts-nocheck` supaya tidak ikut menambah
diagnostik ke `npm run lint`, dan tidak menarik dependensi baru (`esbuild` ikut bersama vite).

Hasil terakhir (host 4 GB, bridge hidup di `ws://127.0.0.1:8000/ws`): harness (1)
`ALL CHECKS PASSED`; (2) `states: [connecting, online]`, 0 reconnect, 1 event `backlog` masuk;
(3) peer diam → tetap `online` tanpa close paksa, peer yang menjawab `pong` lalu diam →
`heartbeat timeout` lalu socket ditutup dan reconnect dijadwalkan.

Sebelum merge, jalankan `npm ci && npm run lint && npm run build` di mesin yang punya RAM cukup:

```bash
npm run build                                             # tanpa env → mode lokal
VITE_KANBAN_WS_URL=ws://127.0.0.1:8000/ws npm run build    # mode remote, URL ikut ter-bundle
```

Indikator koneksi muncul di header (`board online|connecting|offline`) hanya saat mode remote.

## 7. Catatan kompatibilitas dengan `kanban-ws-bridge`

Bridge yang ada (repo `criminals-sandbox`, service `kanban-ws-bridge`) belum bisa langsung
menggerakkan board ini — kontraknya berbeda dari tabel §3:

| Aspek | Bridge | Kontrak §3 |
|---|---|---|
| Nama event | `task_added`, `status_changed`, `task_updated`, `task_removed`, `backlog`, `poll_error` | `task.created`, `task.status_changed`, … |
| Amplop | datar (`task_id`, `task`, `changes`, `to_status`) | `{v,id,type,seq,ts,projectId,agentIndex?,taskId?,payload}` |
| Id task | id kartu Hermes (`t_29bcaba1`) | bebas, dipakai apa adanya oleh `addTask`/`applySnapshot` |
| Pemilik task | `assignee` = nama profil (`dev`) | `assignedAgentId` = index integer tim aktif |
| Status | enum Hermes kanban (todo/ready/running/… ) | `scheduled/on_hold/in_progress/done` |
| Alive | `{type:'keepalive'}` tiap 30s idle | `pong` |

Karena itu setiap event bridge saat ini terhitung `ignored (unknown_type)` — terverifikasi pada
harness (2): event `backlog` diterima, tidak ada aksi store. Adapter (nama event + terjemahan
status + pemetaan `assignee` ke index agen) sengaja **tidak** dibuat di sini karena pemetaan
`assignee → agentIndex` adalah keputusan desain, bukan mekanis; lihat task lanjutan di board.
