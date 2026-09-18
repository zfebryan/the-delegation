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

## 5. Verifikasi

```bash
npm ci
npm run lint                       # tsc --noEmit
npm run build                      # build tanpa env → mode lokal
VITE_KANBAN_WS_URL=ws://127.0.0.1:8000/ws npm run build   # mode remote, URL ikut ter-bundle
```

Indikator koneksi muncul di header (`board online|connecting|offline`) hanya saat mode remote.
