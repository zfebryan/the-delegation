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
| `VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS` / `_ATTEMPTS` | Batas tunggu balasan `board.snapshot.request` sebelum dikirim ulang, dan jumlah percobaan per resync (default 5000 / 3). Lihat §7.8. |

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
Gap `seq`, reconnect, dan pergantian tim memicu `board.snapshot.request` (resync); bridge
menjawabnya dengan frame `snapshot` (state poller) yang dipetakan adapter jadi `board.snapshot`,
dan resync baru dianggap selesai setelah balasan itu — bukan setelah socket terbuka (§7.8).
Adapter hanya menyentuh frame yang dikenal sebagai milik bridge; amplop §6.2 apa adanya
dilewatkan tanpa perubahan (`passthrough`), jadi server §6.2 sungguhan tetap bisa dipakai
(`VITE_KANBAN_BRIDGE_ADAPTER=off` untuk memaksa jalur itu).

| Event | Aksi store |
|---|---|
| `project.brief_received {brief}` | `startProject(brief)` |
| `project.phase_changed {phase}` | `setPhase` |
| `project.final_output {output}` | `setFinalOutput` + `setPhase('done')` |
| `project.asset_ready {type,content}` | `setFinalAsset` (`music` → `audio`) + `setPhase('done')` |
| `board.snapshot {tasks,phase,brief,agentStatuses}` | `applySnapshot` (aksi baru; id task eksternal dipakai apa adanya). `tasks` **wajib**: payload tanpanya ditolak (`missing_tasks`) supaya snapshot parsial tidak menghapus board; hanya `tasks: []` eksplisit yang boleh mengosongkan |
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
memicu error. Event untuk `agentIndex` di luar tim aktif ditolak (bukan ditulis ke store),
termasuk `action_log.appended` yang menyebut agent di luar tim (`unknown_agent`).
`action_log.appended` **tanpa** `agentIndex` tetap ditulis sebagai entri sistem dengan index
`-1` — itu index "System" yang sudah dipakai `debugLog`, dan panel Activity menampilkannya
sebagai `System` (bukan nama agent).

## 4. Egress (persiapan)

`kanbanTransport.sendCommand(type, payload)` sudah dipakai untuk `board.snapshot.request` dan
siap dipakai fase berikutnya (`chat.send`, `board.approve_task`, `board.reject_task`).
Pengiriman perintah dari UI (AuditModal/KanbanPanel/chat) **belum** dialihkan — itu fase 3 di
dokumen riset.

## 5. Heartbeat & liveness (penting untuk bridge)

`wsClient` mengirim `{type:'ping'}` tiap `VITE_KANBAN_WS_HEARTBEAT_MS`. Aturan liveness:

- `heartbeatTimeoutMs` **hanya** menutup socket bila peer pernah menjawab `ping` dengan `pong`
  (bukti peer memang bicara protokol ini). Peer yang hanya diam atau mengirim `keepalive`
  sendiri tidak pernah dianggap mati karena pong yang hilang — deteksi mati diserahkan ke
  `onclose`/`onerror`, supaya tidak terjadi loop reconnect.
- Ambangnya diukur dari **saat ping yang belum dijawab itu dikirim**, bukan dari `pong` terakhir.
  Ping yang belum dijawab tidak dikirim ulang; `pong` membatalkannya, dan satu ping yang melewati
  ambang adalah bukti peer mati → socket ditutup supaya backoff reconnect jalan. Mengukur dari
  `pong` terakhir salah begitu `interval > timeout` (default 15000 > 10000): `pong` terakhir selalu
  berumur satu interval penuh saat tick berikutnya, jadi socket **sehat** ditutup di tick kedua.
  Bug itu hanya bisa muncul setelah bridge benar-benar membalas `ping` (§7.8).
- Peer yang tidak pernah menjawab tidak diberi label apa pun pada ping pertama (ping pertama selalu
  berangkat sebelum `pong` pertama bisa tiba) — peringatan "peer never answered ping" baru muncul
  setelah dua ping tak dijawab, supaya koneksi sehat tidak mengotori `lastError` tiap connect.

Alasannya konkret: bridge `kanban-ws-bridge` **sebelum** PR #12 tidak membalas `ping` (loop-nya
hanya `receive_text()`), sehingga `peerAnswersPing` tak pernah `true` dan jalur timeout praktis
mati; socket sehat akan ditutup paksa tiap siklus kalau jalur itu diaktifkan dengan aturan lama.

Terukur pada bridge nyata **sebelum** PR #12 di `ws://127.0.0.1:8000/ws` (Node 26, ping 1s,
timeout 800ms, reconnect 300ms, 8 detik): aturan lama → **6 close paksa / 6 reconnect**; aturan
sekarang → **0 close paksa** (socket tetap `online`). Reproduksi tanpa menyentuh kode app:

```bash
node scripts/kanban-transport/old-rule-probe.mjs ws://127.0.0.1:8000/ws
```

## 6. Verifikasi (tanpa `npm run build`/`tsc` di lingkungan ini)

Host ini hanya punya 4 GB RAM (`tsc --noEmit` dan `vite build` pernah OOM di sini), jadi
verifikasi dilakukan dengan membaca ulang kode + harness Node yang dibundel `esbuild`
(dependensi transitif vite, tanpa `npm install` tambahan):

```bash
# 1) config + dedupe + mapper murni, store palsu (36 assertion)
./node_modules/.bin/esbuild scripts/kanban-transport/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-smoke.mjs && node /tmp/kb-smoke.mjs

# 2) adapter bridge → §6.2: pemetaan assignee/status, snapshot/backlog, NACK, dedupe (47 assertion)
./node_modules/.bin/esbuild scripts/kanban-transport/bridge-smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-bridge.mjs && node /tmp/kb-bridge.mjs

# 3) klien nyata terhadap bridge nyata melalui adapter (butuh bridge jalan di :8000)
./node_modules/.bin/esbuild scripts/kanban-transport/live.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-live.mjs && node /tmp/kb-live.mjs ws://127.0.0.1:8000/ws

# 4) heartbeat dengan WebSocket palsu: peer diam vs peer yang menjawab pong (17 assertion)
./node_modules/.bin/esbuild scripts/kanban-transport/heartbeat.ts --bundle --platform=node --format=esm --outfile=/tmp/kb-hb.mjs && node /tmp/kb-hb.mjs

# 5) `KanbanTransport` nyata dengan WebSocket palsu: jumlah board.snapshot.request per
#    connect/reconnect + balasan `snapshot` diterapkan/selesai/`initialized:false` (27 assertion;
#    env di-inline karena
#    `config.ts` membaca import.meta.env milik Vite)
./node_modules/.bin/esbuild scripts/kanban-transport/snapshot-request-probe.ts --bundle --platform=node --format=esm --define:'import.meta.env={"VITE_KANBAN_WS_URL":"ws://fake/ws","VITE_KANBAN_TRANSPORT_MODE":"remote","VITE_KANBAN_WS_RECONNECT_MIN_MS":"10","VITE_KANBAN_WS_RECONNECT_MAX_MS":"10","VITE_KANBAN_WS_HEARTBEAT_MS":"60000"}' --outfile=/tmp/kb-snap.mjs && node /tmp/kb-snap.mjs
```

Kelima harness TypeScript di `scripts/kanban-transport/` memakai `@ts-nocheck` supaya tidak ikut
menambah diagnostik ke `npm run lint`, dan tidak menarik dependensi baru (`esbuild` ikut bersama
vite). `old-rule-probe.mjs` (JS murni, `node` langsung) hanya untuk mereproduksi aturan liveness
lama; lihat §5.

Hasil terakhir (host 4 GB, bridge hidup di `ws://127.0.0.1:8000/ws`): harness (1)
`ALL CHECKS PASSED` (36 assertion); (2) `ALL CHECKS PASSED` (47 assertion, adapter); (3) 20
assertion terhadap bridge nyata (`ALL CHECKS PASSED`) — **satu** `board.snapshot.request` per
connect (`connected`), dijawab frame `snapshot` lalu diterapkan sebagai board (task demi task sama
dengan frame-nya), frame `backlog` yang pensiun tidak menyentuh board, satu perubahan board **live**
jadi `applied:task.status_changed`, satu resync eksplisit = satu request + satu balasan tanpa
request `seq_gap` tambahan, 0 close paksa / 0 reconnect, `ping` → `pong` (lihat §7.8); (4) peer diam
→ tetap `online` tanpa close paksa, peer yang menjawab `pong` lalu diam → `heartbeat timeout` lalu
socket ditutup dan reconnect dijadwalkan, peer yang menjawab tiap ping dengan `interval > timeout` →
tetap `online` (17 assertion); (5) `ALL CHECKS PASSED` (27 assertion: 1 `board.snapshot.request` per
connect dan per reconnect, balasan `snapshot` diterapkan + resync selesai, `snapshot` dengan
`initialized:false` **tidak** menyentuh board lalu diulang terbatas dan dilaporkan
`snapshotUnanswered`, `missing_tasks` tidak menyentuh store, `tasks: []` tetap mengosongkan).

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
| Nama event | `task_added`, `status_changed`, `task_updated`, `task_removed`, `backlog`, `snapshot`, `poll_error`, `poll_recovered`, `keepalive` | `task.created`, `task.status_changed`, … |
| Amplop | datar (`task_id`, `task`, `changes`, `to_status`) | `{v,id,type,seq,ts,projectId,agentIndex?,taskId?,payload}` |
| Id task | id kartu Hermes (`t_29bcaba1`) | bebas, dipakai apa adanya oleh `addTask`/`applySnapshot` |
| Pemilik task | `assignee` = nama profil (`dev`) | `assignedAgentId` = index integer tim aktif |
| Status | enum Hermes kanban (todo/ready/running/blocked/review/done) | `scheduled/on_hold/in_progress/done` |
| Alive | `{type:'keepalive'}` tiap 30s idle; `{type:'pong'}` sebagai balasan `ping` (sejak PR #12) | `pong` |
| `seq`/`ts` | **ada** per event dan di frame `snapshot` (`poller._emit()`); hanya pembungkus `backlog` yang tidak punya | `seq`/`ts` opsional |

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
`id` disintesis `bridge:<seq>` untuk event (fallback `bridge:<type>:<taskId>:<ts>`), `seq`
diteruskan apa adanya, `ts` dikonversi detik → milidetik. Frame `snapshot` memakai
`bridge:snapshot:<seq>:<ts>`: bridge tidak memakai `seq` baru untuk snapshot-nya, jadi satu request
dan retry-nya bisa dibalas dengan `seq` yang sama — id yang menyertakan `ts` membuat balasan kedua
tetap diterapkan, bukan dibuang sebagai duplikat. Dedupe **tetap aktif** dan gap-detection `seq`
**tetap aktif** (event bridge yang hilang memang mungkin), dengan satu koreksi: balasan `snapshot`
menetapkan baseline gap lewat `EventDedupe.adoptBaseline(seq)` sebelum dedupe dijalankan, sehingga
snapshot yang melompat `seq` tidak dibaca sebagai gap (itu dulu memicu request tambahan per
connect — §7.8). `requestSnapshot('seq_gap')` sekarang dijawab.

### 7.4 Rute `backlog` **dipensiunkan**
Frame `backlog` berisi 50 event terakhir, bukan state task: task yang event-nya sudah keluar dari
ring buffer tidak muncul lagi, jadi merangkumnya jadi `board.snapshot` bisa menghapus task lokal
yang sebenarnya masih ada — kelas kegagalan yang sama dengan `board.snapshot` tanpa `tasks`
(§7.7 no. 1). Sejak bridge membalas `board.snapshot.request` dengan `snapshot` (§7.8), frame
`backlog` **diabaikan** dengan alasan `backlog_superseded`: frame dikenal, tanpa amplop, tanpa NACK
(tidak ada divergensi — datanya memang digantikan jalur resync). `VITE_KANBAN_BACKLOG_MODE` dihapus
dari `config.ts`/`vite.config.ts`/`.env.example`; bootstrap board sekarang selalu lewat balasan
`snapshot`.

### 7.5 Gap yang diketahui (bukan bug)
- `task_updated` / `task_removed` **tidak** dipetakan: kontrak §6.2 tidak punya `task.updated` /
  `task.removed`, dan `removeTask` lokal menendang `phase → done` sebagai efek samping
  (risiko #3 dokumen riset). Keduanya dibuang + NACK (`non_status_change_not_supported` /
  `removal_not_supported`) supaya divergensi terlihat, bukan senyap. Efek nyata: perubahan
  `title`/`priority`/`assignee` pada kartu yang sudah ada tidak mengubah board 3D.
- `poll_error` / `poll_recovered` dicatat sebagai `ignored` (`bridge_poll_error` /
  `bridge_poll_recovered`), tidak fatal — bridge memang bisa gagal polling sesaat.
- Bridge **lama** (sebelum PR #12) tidak membalas `ping` maupun `board.snapshot.request`, dan jalur
  `backlog` sudah dipensiunkan (§7.4). Terhadap peer seperti itu board 3D tidak terisi dan resync
  berakhir sebagai `snapshotUnanswered` + `lastError` setelah `VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS`
  percobaan. Disengaja: "tidak tahu" lebih baik daripada board parsial yang menghapus task.
  Perbaikan sisi bridge ada di `t_e5fc6584` (PR #12), pemakaiannya di klien di `t_32e1770f` (§7.8).
- Baseline gap dari `snapshot` adalah `seq` counter poller, yang juga dipakai event. Karena baseline
  dinaikkan (bukan direset), event yang hilang **tepat di antara** snapshot dan event berikutnya
  baru terlihat sebagai gap saat ada event dengan `seq` minimal dua tingkat di atas baseline.
  Terbatas dan tidak bisa jadi loop (satu snapshot per gap, balasan berikutnya menaikkan baseline).

### 7.6 Verifikasi adapter (hasil nyata)
- `scripts/kanban-transport/bridge-smoke.ts` → `ALL CHECKS PASSED` (47 assertion): tabel
  `assignee`, tabel status dua arah, `task_added`→`task.created`, `status_changed`→
  `task.status_changed`, `blocked`→`on_hold`, NACK untuk `unknown_assignee` /
  `agent_not_in_team` / `unknown_status` / malformed, `task_updated`/`task_removed` ditolak
  eksplisit, `poll_error`/`keepalive`, frame `snapshot` → `board.snapshot` (termasuk
  `initialized:false` dan `tasks` yang hilang **tidak** diterapkan, `phase`, id `bridge:snapshot:*`,
  `adoptBaseline` yang tidak pernah memundurkan), frame `backlog` yang pensiun
  (`backlog_superseded`, tanpa NACK), tuning resync di `resolveTransportConfig`,
  `VITE_KANBAN_BACKLOG_MODE` yang hilang dari config, dedupe + gap, dan jalur ujung-ke-ujung
  adapter → mapper (store calls nyata).
- `scripts/kanban-transport/live.ts` terhadap bridge nyata (`kanban-ws-bridge` PR #12, poller 0,5 s,
  `EVENT_BUFFER_SIZE=1`, board 18 task): **20 assertion, `ALL CHECKS PASSED`** — satu
  `board.snapshot.request` per connect (alasan `connected`), balasan `snapshot` diterapkan dan sama
  task-demi-task dengan frame-nya, frame `backlog` pensiun tidak mengubah board (`appliedEvents`
  tetap 1), satu mutasi board **live** jadi `applied:task.status_changed`, `requestSnapshot()`
  = 1 request + 1 balasan **tanpa** request `seq_gap` tambahan (sebelumnya 2× per connect — §7.8),
  0 `snapshotUnanswered`, 0 close paksa / 0 reconnect / 0 error heartbeat (jejak `ping`→`pong`
  RTT 1–13 ms).

### 7.7 Perbaikan pasca-review QA

Tiga temuan review QA (kartu `t_5a298d2d` → `t_4002d267`) sudah diperbaiki:

1. **`board.snapshot` tanpa `tasks` tidak lagi menghapus board.** Sebelumnya payload parsial
   (server lain versi, event terpotong) dianggap "board kosong" dan `applySnapshot([])` menghapus
   semua task lokal — padahal event ini justru jalur resync. Sekarang ditolak
   (`missing_tasks`), sementara `tasks: []` eksplisit tetap mengosongkan board.
2. **Satu `board.snapshot.request` per reconnect.** `onStateChange('online')` dan `onReconnected`
   sama-sama meminta snapshot, jadi tiap reconnect mengirim dua frame (counter naik 2×).
   Sekarang `onStateChange` hanya meminta pada connect **pertama** (`connected`), reconnect lewat
   `onReconnected` (`reconnected`).
3. **`action_log.appended` untuk agent di luar tim ditolak** (`unknown_agent`) supaya sesuai §3:
   sebelumnya entri itu ditulis dengan `agentIndex: -1` dan tampil sebagai "System" di panel
   Activity, seolah bukan dari agent. Entri tanpa `agentIndex` tetap `-1`/System.

Harness `smoke.ts` bertambah 4 assertion (33 total: snapshot tanpa `tasks`, snapshot `tasks: []`,
log System, log agent luar tim) dan ada harness baru `snapshot-request-probe.ts` yang menjalankan
`KanbanTransport` sungguhan di atas WebSocket palsu. Probe itu gagal pada kode lama
(3 request setelah 1 reconnect: `connected` + `reconnected`) dan lulus setelah perbaikan
(1 request per connect/reconnect).

### 7.8 Frame `snapshot` → `board.snapshot`: resync berjawab, `backlog` pensiun
Sisi bridge (PR #12 di repo `criminals-sandbox`, kartu `t_e5fc6584`) sekarang membalas
`board.snapshot.request` dengan
`{"type":"snapshot","count":N,"tasks":[…summarize()],"seq":…,"ts":…,"initialized":bool,"poll_interval_s":…}`
dan `{"type":"ping"}` dengan `{"type":"pong","ts":…}`. `BridgeAdapter.adaptBridgeFrame` memetakannya:

| Frame bridge | Amplop §6.2 | Catatan |
|---|---|---|
| `snapshot` dengan `initialized:true` + `tasks` | `board.snapshot` (`tasks`, `phase` diturunkan) | sumbernya state poller (`_state`), bukan ring buffer event → board **penuh**, bukan jendela 50 event |
| `snapshot` dengan `initialized:false` | tidak ada (`ignored: snapshot_not_initialized`) | poller belum punya baseline: "belum dipoll" ≠ "board kosong"; board lokal tidak disentuh |
| `snapshot` tanpa `tasks` | tidak ada (`ignored: snapshot_missing_tasks`) | kembaran penjaga `missing_tasks` di mapper (§7.7 no. 1) |
| `backlog` | tidak ada (`ignored: backlog_superseded`) | §7.4 |
| `ping` | `{type:'pong'}` dari `wsClient` (bukan adapter) | §5 |

Task di dalam `snapshot` dinilai dengan aturan yang sama seperti event per-task (§7.1, §7.2):
`assignee` di luar tabel/tim → `unknown_assignee` / `agent_not_in_team`, status tak dikenal →
`unknown_status`; keduanya **dibuang + NACK**, tidak ditebak.

**Resync berjawab.** Setiap `board.snapshot.request` (`connected`, `reconnected`, `seq_gap`,
`team_changed`, `retry`) memasang deadline balasan. Balasan yang benar-benar dipakai
(`board.snapshot` dengan `tasks` → `applied`) menyelesaikannya; balasan yang tidak datang diulang
sampai `VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS`, lalu dilaporkan `snapshotUnanswered` + `lastError`. Jadi
"socket terbuka saat request dikirim" tidak lagi disamakan dengan "board menjawab".

**`adoptBaseline`.** Frame `snapshot` (dan `board.snapshot` §6.2 apa pun) menetapkan baseline
gap-detection lewat `EventDedupe.adoptBaseline(seq)` — hanya menaikkan, tidak pernah memundurkan,
sehingga snapshot basi tetap `outOfOrder` dan id yang sudah terlihat tetap duplikat. Yang ditutup:
pada checkout `0d73b94`, balasan `snapshot` (mis. `seq=9`) dibaca sebagai gap setelah baseline
`backlog` (`seq=5`), sehingga klien mengirim **2** `board.snapshot.request` per connect
(`t_e5fc6584/review-a/trace-out.txt`). Sekarang 1, terukur di harness live.

**Liveness diaktifkan kembali.** Karena bridge benar-benar membalas `ping`, jalur
`heartbeatTimeoutMs` (`peerAnswersPing`) hidup lagi — dengan pengukuran dari ping yang dikirim, bukan
dari pong terakhir (§5). Tanpa koreksi itu, default `interval 15000 > timeout 10000` akan menutup
socket sehat di tick kedua.

Verifikasi: `bridge-smoke.ts` 38 → **47** assertion, `smoke.ts` 33 → **36** (baseline diukur ulang di
worktree `0d73b94`), `heartbeat.ts` **17**, `snapshot-request-probe.ts` **27**, `live.ts` **20**
terhadap bridge nyata (PR #12) — semuanya `ALL CHECKS PASSED`.
