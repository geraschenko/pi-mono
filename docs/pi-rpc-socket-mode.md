# SPEC

## Problem Statement

`pi --mode rpc` exposes a structured JSONL command/event interface, but it does so by replacing the normal interactive TUI. That makes it a poor fit for systems that need both:

- a real human using stock interactive pi, including TUI-native extension UI such as `ctx.ui.custom()`, custom editors, headers/footers, and built-in interactive commands like `/tree`, and
- an external orchestrator that needs structured visibility and control without scraping terminal output or injecting keystrokes into a PTY/tmux session.

The project should add a new interactive mode flag:

```bash
pi --rpc-socket /tmp/pi.sock [OTHER_ARGS]
```

This flag runs normal interactive pi while also exposing an RPC-like JSONL protocol over a Unix domain socket. The terminal remains owned by interactive pi. The socket is an out-of-band control/event channel for programmatic clients.

## Goals

### Primary goal

When `--rpc-socket <path>` is supplied, pi behaves like normal interactive mode for the human user while also exposing an RPC-compatible side channel whose observable behavior is as close as possible to `pi --mode rpc`.

### Human-facing goals

- The human user gets the normal interactive TUI.
- Existing interactive features continue to work, including:
  - built-in interactive commands such as `/tree`, `/settings`, `/model`
  - TUI-native extension UI such as `ctx.ui.custom()`, `setFooter()`, `setHeader()`, `setEditorComponent()`, overlays, and custom renderers
  - normal editor behavior, including preserving partially typed text while external clients submit prompts
- `--rpc-socket` must not require the human to share terminal ownership with a machine client.
- `--rpc-socket` requires interactive TTY operation. If interactive mode would not be available because stdin is not a TTY, pi must exit with an error instead of silently falling back to print mode.

### Orchestrator-facing goals

- External clients connect to a Unix domain socket and speak JSONL.
- Command and event payloads should match `--mode rpc` wherever possible.
- Multiple clients may connect simultaneously.
  - Events are broadcast to all connected clients.
  - Any connected client may issue commands. Responses go only to the client that issued the command.
- The human user is conceptually another sender into the same session. Message ordering uses a single serialization point shared by:
  - human submissions from the editor
  - commands received over the RPC socket
- If an external client submits a message while the human is typing, the external message is processed and the editor contents remain unchanged.

### Extension/UI goals

- Interactive mode remains the sole owner of extension UI.
- Socket clients do not answer extension UI requests and do not replace the interactive TUI UI context.
- If work initiated by any sender causes the session to block on human-facing extension UI, socket clients receive explicit `--rpc-socket`-specific events indicating that the session is waiting on human input.

## CLI Contract

### New flag

Add a new CLI option:

```text
--rpc-socket <path>
```

`<path>` is the filesystem path for a Unix domain socket.

### Mode restrictions

`--rpc-socket` is only valid for interactive operation and is incompatible with:

- `--mode rpc`
- `--mode json`
- `-p` / `--print`

If `--rpc-socket` is combined with any of the above, pi must exit with an error before starting the session.

### Socket path behavior

- The socket path is required.
- Relative paths are resolved against the current working directory before binding.
- The parent directory must already exist. Missing parent directories are an error.
- If a filesystem entry already exists at that path, pi exits with an error instead of removing or replacing it.
- If the resolved path is too long for the platform's Unix socket path limit, pi exits with an error before starting interactive mode.
- The created socket must be restricted to the current user, with effective permissions equivalent to `0600`.
- The implementation should remove the socket file it created during clean shutdown.
- After an unclean shutdown, a stale socket file may remain and will block restart by design until the operator removes it manually.

## Protocol Contract

### Baseline compatibility target

The socket protocol should reuse the existing RPC protocol documented in:

- `packages/coding-agent/docs/rpc.md`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`

The compatibility target is:

- same command names
- same response shapes
- same event shapes for existing agent/session/tool events
- same JSONL framing rules

Intentional deviations from `--mode rpc` are allowed only where interactive TUI ownership makes them necessary. Every such deviation must be documented in this spec.

### Transport

- Transport is Unix domain socket.
- Records are LF-delimited JSON objects using the same framing rules as current RPC mode.
- Events are broadcast to all connected clients.
- Responses are routed only to the requesting client connection.
- A newly connected client receives future events only. Catch-up is performed explicitly via commands such as `get_state`, `get_messages`, and `get_session_stats`.
- The server must emit a connection-scoped hello record immediately after connect so a client can verify it is speaking to an `--rpc-socket` endpoint. Initial shape:

```json
{"type":"hello","protocol":"pi-rpc-socket","version":1}
```

- The hello record is the first record sent on every connection. Event broadcast to that client begins only after the hello record has been queued for that client.
- A slow or stuck client must not stall interactive mode or other clients. The server must use bounded per-client output buffering and disconnect a client whose backlog exceeds the configured bound.
- On normal process shutdown, the server must emit a final socket-only shutdown event before closing client connections. Initial shape:

```json
{"type":"shutdown"}
```

### Command semantics

The canonical command set for `--rpc-socket` is the command set defined in `packages/coding-agent/src/modes/rpc/rpc-types.ts` for `RpcCommand`, except where a documented deviation below says otherwise.

Behavioral requirements:

- Socket-originated `prompt` behaves like RPC `prompt` as closely as possible.
- Socket-originated extension commands are allowed. If such a command triggers extension UI, the human-facing TUI handles it.
- Message acceptance and queueing semantics continue to respect the session's existing `prompt`/`steer`/`followUp` behavior.
- Socket-originated prompts use `source: "rpc"` for `InputSource` purposes so that extensions and session logic observe the same source category they already see in stdio RPC mode.
- Human and socket-originated sends share one effective serialization point because both ultimately invoke the same session APIs on the same Node.js event loop. Human sends still perform interactive-editor preprocessing first; socket sends do not. Deterministic ordering is therefore defined by the order in which those final session API calls are made within the process.
- Responses are routed by client connection identity, not by command `id`. The `id` field remains optional and is used only for client-side correlation, exactly as in current RPC mode.

### Event semantics

All normal session events emitted today by `session.subscribe(...)` remain visible to socket clients as compatibility targets, including:

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `queue_update`
- `compaction_start`
- `compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `extension_error`

### Documented deviations from `--mode rpc`

The following deviations are intentional and required for interactive TUI ownership:

- `extension_ui_request` events are not emitted on the socket.
- `extension_ui_response` commands are not accepted on the socket. If received, they must be rejected through the same unknown-command error path used for unsupported RPC commands.
- Socket clients receive `ui_wait_start` / `ui_wait_end` summary events instead of the interactive request/response sub-protocol.
- Socket mode may emit socket-only connection/shutdown records such as the connection hello event and final shutdown event.

### New `--rpc-socket`-specific UI wait events

Add new events specific to `--rpc-socket` mode for visibility into human-mediated extension UI waits.

Required event family:

```json
{
  "type": "ui_wait_start",
  "requestId": "6a9f7c54-3c68-4e31-a550-602889b7b8af",
  "request": {
    "method": "confirm",
    "title": "Run project-local agents?",
    "message": "Project agents are repo-controlled. Only continue for trusted repositories."
  }
}
```

```json
{
  "type": "ui_wait_end",
  "requestId": "6a9f7c54-3c68-4e31-a550-602889b7b8af",
  "request": {
    "method": "confirm",
    "title": "Run project-local agents?"
  },
  "resolution": "confirmed"
}
```

Payload contract:

- `requestId: string` is required on both start and end events so clients can pair them.
- `request.method` must distinguish at least:
  - `select`
  - `confirm`
  - `input`
  - `editor`
  - `custom`
- `title` is included on `ui_wait_start` when the interactive UI API provides one.
- `title` may be repeated on `ui_wait_end` for client convenience. When present there, it is informational only and must match the title from the corresponding start event.
- `message` is included only for `confirm` requests. It is omitted for `input`, `editor`, and `custom` waits to avoid mirroring arbitrary user-entered or extension-generated text over the socket.
- `optionCount` is included for `select` when known.
- `resolution` must be one of:
  - `selected`
  - `confirmed`
  - `submitted`
  - `cancelled`
  - `timed_out`
  - `aborted`
  - `closed`

Behavioral requirements:

- `ui_wait_start` is emitted when the interactive UI begins waiting for human input on behalf of an extension UI request.
- `ui_wait_end` is emitted when that wait finishes.
- Every `ctx.ui.custom()` call is in scope and must emit `ui_wait_start` / `ui_wait_end` with `method: "custom"`.

## Ownership Model

### Terminal and UI ownership

Interactive mode owns:

- terminal stdout/stderr rendering
- keyboard input
- the active extension UI context
- all TUI-native extension interactions

Socket clients own:

- command submission over the socket
- receiving responses over the socket
- receiving event broadcasts over the socket

Socket clients do not own:

- terminal rendering
- editor state
- extension UI dialog resolution
- custom TUI component rendering

### Editor preservation

If a socket client submits a message while the human is typing in the editor but has not yet sent it:

- the socket-originated message is processed normally
- the human's unsent editor contents remain unchanged
- the human may continue editing and later send that text through the same session
- editor-local actions such as history updates, slash-command dispatch, and visual editor clearing remain human-only behavior and are not replayed for socket-originated commands

## Runtime Replacement and Session Rebinding

The socket server must survive interactive runtime/session replacement and continue serving connected clients across operations that replace `runtime.session`, including at minimum:

- `/new`
- `/resume`
- `/fork`
- `/clone`
- reload paths that replace the current runtime/session

Required architectural prerequisite:

- `AgentSessionRuntime` currently exposes single-owner callbacks via `setRebindSession(...)` and `setBeforeSessionInvalidate(...)`. `--rpc-socket` requires this to be generalized so both interactive mode and the socket server can observe runtime replacement safely.
- The implementation must introduce a multi-listener mechanism for these lifecycle hooks, or an equivalent explicit fan-out owner that both interactive mode and the socket server register with. This prerequisite is mandatory; the socket server may not rely on winning a last-writer-wins callback race.

Requirements:

- existing socket connections remain valid if the process stays alive
- event subscriptions are rebound to the new active session/runtime
- subsequent commands target the new active session/runtime
- any instrumentation wrapper around interactive extension UI must also be re-established after session replacement

## Error Handling

### Startup errors

pi must fail fast with a clear error if:

- `--rpc-socket` is used with an incompatible mode flag
- `--rpc-socket` is used without interactive TTY availability
- the socket path already exists
- the socket path is invalid for Unix socket binding
- the socket cannot be created or bound

### Client-level errors

Socket command errors should follow existing RPC response semantics as closely as possible:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "..."
}
```

### Disconnect behavior

If a socket client disconnects:

- interactive pi continues running normally
- other socket clients remain unaffected
- no session state is rolled back merely because a socket client disconnected

## Measurable Success Criteria

The feature is successful if all of the following are true:

1. Running `pi --rpc-socket /tmp/pi.sock` presents the normal interactive pi interface in the terminal.
2. A client connecting to `/tmp/pi.sock` can send JSONL commands and receive JSONL responses/events.
3. Existing session events observed over the socket match `--mode rpc` behavior closely enough that an RPC client can be adapted with minimal or no protocol changes.
4. Human use of built-in interactive features and TUI-native extensions continues to work.
5. External prompts can be submitted while the human is typing without clobbering the editor.
6. If an extension blocks on human-facing UI, socket clients receive explicit wait visibility via the new `ui_wait_*` events.
7. After session replacement operations, connected socket clients continue to observe and control the new active session without reconnecting.
8. No terminal scraping or simulated keystrokes are required for orchestration.
9. A slow or stuck socket client cannot stall interactive mode or other connected clients.
10. Connected socket clients continue working across session replacement without requiring a new socket connection.

## Concrete Examples

### Example: debug watcher sidecar for the tee use case

This feature should be exercised early with a concrete end-to-end example consisting of two processes:

1. `pi --rpc-socket /tmp/pi.sock`
2. a separate example client binary that connects to the socket, prints every received record, and watches for user messages containing the word `chilidog`

When the sidecar sees a user-authored message containing `chilidog`, it should send a steering command:

```json
{"type":"steer","message":"I love those dogs!"}
```

Expected result:

- the sidecar prints the initial socket `hello` record and all subsequent events/responses for debugging
- the sidecar does not own the terminal or extension UI
- when the human sends a message containing `chilidog`, the sidecar sends the steer command over the socket
- the requesting sidecar connection receives the normal `steer` response
- all connected clients continue receiving broadcast session events
- this example remains intentionally simple so it can serve as an early manual integration test and a long-lived maintenance smoke test for the fork

### Example: external prompt while human is typing

State:

- Human has typed `Refactor the auth middleware to...` into the editor but has not pressed Enter.
- Socket client sends:

```json
{"id":"1","type":"prompt","message":"Summarize the current session state."}
```

Expected result:

- Socket client receives the normal response/event stream for accepted prompt execution.
- The human's partially typed editor text remains present and editable.

### Example: socket-triggered extension UI

State:

- Socket client sends a prompt that triggers an extension command or tool path that calls `ctx.ui.confirm(...)`.

Expected result:

- The confirmation is rendered in the interactive TUI.
- Socket clients receive `ui_wait_start`.
- When the human resolves the dialog, socket clients receive `ui_wait_end`.
- The command continues according to the human's answer.

### Example: socket `steer` while streaming

State:

- The agent is already streaming a response.
- A socket client sends:

```json
{"id":"2","type":"steer","message":"Focus on auth edge cases."}
```

Expected result:

- The requesting client receives:

```json
{"id":"2","type":"response","command":"steer","success":true}
```

- All connected clients receive the resulting `queue_update` and later normal session events.
- If the human is typing in the editor during this time, their unsent text remains unchanged.

### Example: multi-client response routing

State:

- Two clients are connected to the socket.
- Client A sends:

```json
{"id":"req-7","type":"get_state"}
```

Expected result:

- Client A receives:

```json
{"id":"req-7","type":"response","command":"get_state","success":true,"data":{}}
```

- Client B does not receive that response.
- Both clients continue receiving broadcast events.

## Edge Cases

- A socket client submits a command while the session is already streaming.
- A human submits a message while socket-originated messages are queued.
- Multiple socket clients submit commands close together.
- An extension command initiated over the socket opens a long-lived editor dialog or custom TUI component in the interactive UI and no human is present to resolve it. In v1 this may deadlock until `abort` or process shutdown, which is acceptable.
- The active session is replaced while clients are connected.
- The socket client disconnects during an active run.
- A UI wait ends by cancellation, timeout, abort, or custom component closure rather than successful input.
- A late-joining client connects mid-session and must catch up via explicit state queries.
- A client stops reading and exceeds the per-connection output backlog bound.

## Non-Goals

- Replacing the interactive TUI with a remote-rendered UI
- Allowing socket clients to answer extension UI requests in v1
- Making stdout carry both ANSI TUI output and JSON protocol output simultaneously
- PTY/tmux scraping or keystroke injection

# IMPLEMENTATION IDEAS

## Relevant code references

Primary source files to reference during implementation:

- `packages/coding-agent/src/main.ts`
  - current CLI mode selection between print, RPC, and interactive flows
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - current RPC command handling, event emission, JSONL framing integration, runtime rebinding pattern, RPC UI-context binding
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
  - protocol types and compatibility target
- `packages/coding-agent/src/modes/rpc/jsonl.ts`
  - JSONL framing helpers
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
  - useful as a compatibility consumer and for understanding assumptions made by an RPC client
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - interactive binding of extension UI context, event handling, editor behavior, runtime replacement behavior
- `packages/coding-agent/src/core/agent-session.ts`
  - `bindExtensions(...)` and session-level extension binding model
- `packages/coding-agent/src/core/extensions/runner.ts`
  - extension context creation, shutdown behavior, command context actions
- `packages/coding-agent/docs/rpc.md`
  - current protocol semantics and documented behavior

## Architectural sketch

### Core idea

Do not run current `runRpcMode()` and `InteractiveMode` side-by-side as-is.

Why not:

- both want to subscribe to the session
- that part is fine
- but both also want to call `session.bindExtensions(...)`
- current extension binding model is singular, not multi-owner
- RPC mode binds an RPC UI context that degrades TUI-only extension features
- interactive mode binds the real TUI UI context

Therefore the likely architecture is:

1. Start normal interactive mode.
2. Keep interactive mode as the sole extension UI owner.
3. Start a separate socket server that:
   - subscribes to the same session/runtime
   - exposes RPC-like command handling
   - never replaces the interactive `uiContext`
4. Rebind socket-side session subscriptions whenever the runtime/session changes.

This is conceptually a new hybrid mode, not `interactive + runRpcMode()` pasted together.

## Implementation approach options

### Option A: new socket server alongside interactive mode

Add a new helper, tentatively something like:

- `runRpcSocketServer(runtimeHost, options)`

Behavior:

- owns socket lifecycle and client connection handling
- borrows most command handling logic from `rpc-mode.ts`
- subscribes to session events and broadcasts them to all clients
- leaves extension UI binding entirely to interactive mode

Possible call flow from `main.ts`:

1. parse `--rpc-socket`
2. validate incompatibilities with `--mode` and `-p`
3. create `InteractiveMode(runtime, ...)`
4. create/start socket server
5. run interactive mode
6. ensure socket cleanup on shutdown

Advantages:

- smallest conceptual delta from current code organization
- preserves interactive mode as the UI owner
- easiest story for future maintainers

Trade-off:

- command handling logic in `rpc-mode.ts` may need refactoring to avoid duplicating large switch statements

### Option B: factor shared RPC command engine out of `rpc-mode.ts`

Extract reusable pieces from `rpc-mode.ts`, for example:

- command dispatcher
- response constructors
- event serialization helpers
- session rebind helper

Then:

- `runRpcMode()` becomes one frontend using stdio and RPC UI context
- `runRpcSocketServer()` becomes another frontend using socket IO and no UI rebinding

Advantages:

- protocol behavior can stay closely aligned between `--mode rpc` and `--rpc-socket`
- fewer chances for long-term drift

Trade-off:

- larger refactor up front
- may be best done incrementally if implementation risk is high

### Option C: a generalized transport layer plus mode-specific UI ownership

A more ambitious version of Option B would define a transport-neutral RPC host layer with:

- command ingress abstraction
- event egress abstraction
- optional extension UI adapter

Then:

- stdio RPC mode plugs in stdio + RPC UI adapter
- `--rpc-socket` plugs in socket transport + no UI adapter

Advantages:

- cleanest long-term architecture

Trade-off:

- likely overkill for v1
- more refactoring than necessary if the immediate goal is shipping `--rpc-socket`

## Extension binding strategy

### Constraint

`AgentSession.bindExtensions(...)` currently installs one extension UI context and related command/shutdown bindings. This strongly suggests that `--rpc-socket` should not try to bind a second UI context.

### Recommended strategy

- Interactive mode continues to call its existing extension binding path.
- Socket server does not call `bindExtensions(...)` for UI purposes.
- Socket server only:
  - observes session events
  - executes commands against the active session/runtime
  - hooks runtime/session rebinding when the active session changes

### Mode-specific binding rule

If socket command handlers need mode-specific bindings beyond what interactive mode already installs, those bindings must remain orthogonal to UI ownership. Socket mode may add observers, transport plumbing, and lifecycle hooks, but it must not install a second extension UI context.

## Single serialization point

The spec requires one effective serialization point shared by human and socket clients.

The intended implementation model is:

- human submits go through interactive editor preprocessing in `interactive-mode.ts` and then call the same session APIs used elsewhere (`session.prompt()`, `session.steer()`, `session.followUp()`)
- socket-originated commands call those same session APIs directly, without replaying editor-local behavior such as history updates, slash-command parsing, or editor clearing
- ordering is therefore determined by the order in which those final session API calls are scheduled on the single Node.js event loop for the process

This is sufficient for the v1 contract. The implementation should not introduce an additional shared queue unless the existing session APIs prove unable to preserve deterministic in-process ordering.

## Multi-client socket server

### Recommended v1 behavior

- accept multiple simultaneous client connections
- broadcast all events to all currently connected clients
- route responses only to the issuing client
- allow any client to send commands

Implementation sketch:

- maintain `Set<ClientConnection>`
- each client has:
  - input buffer / JSONL reader state
  - write method
  - disconnect cleanup
- event broadcaster iterates all clients and writes serialized JSONL records
- command handler closes over the requesting client when writing the response

### Concurrency notes

- Commands from different clients should enter the same shared serialization path.
- The implementation should document whether there is any per-client fairness or whether ordering is purely process arrival order.
- v1 does not need distributed consensus; deterministic single-process ordering is enough.

## UI wait event instrumentation

### Goal

Expose to socket clients when progress is blocked on interactive human UI.

### Likely hook points

There are at least two plausible places to instrument this:

#### Approach 1: wrap or extend the interactive `ExtensionUIContext`

Interactive mode already creates the real UI context. Wrap the blocking methods:

- `select`
- `confirm`
- `input`
- `editor`
- `custom`

Pseudo-shape:

- before awaiting the real dialog/component completion, broadcast `ui_wait_start`
- after resolution/cancel/timeout/abort/close, broadcast `ui_wait_end`

Advantages:

- directly reflects actual human-facing waits
- does not require changes to extension authors

Trade-off:

- requires care so that interactive behavior is unchanged
- requires the wrapper to be reinstalled after session replacement

#### Approach 2: instrument at extension runner boundaries

If the extension runner has a stable choke point for UI calls, emit wait events there.

Advantages:

- possibly reusable for other modes later

Trade-off:

- may be more invasive and less clearly tied to the actual interactive UI implementation

Current preference: Approach 1.

### Payload sketch aligned with SPEC

```ts
type RpcSocketUiWaitMethod = "select" | "confirm" | "input" | "editor" | "custom";

type RpcSocketUiWaitStartEvent = {
  type: "ui_wait_start";
  requestId: string;
  request: {
    method: RpcSocketUiWaitMethod;
    title?: string;
    message?: string; // confirm only
    optionCount?: number; // select only
  };
};

type RpcSocketUiWaitEndEvent = {
  type: "ui_wait_end";
  requestId: string;
  request: {
    method: RpcSocketUiWaitMethod;
    title?: string; // informational only; mirrors start when present
  };
  resolution:
    | "selected"
    | "confirmed"
    | "submitted"
    | "cancelled"
    | "timed_out"
    | "aborted"
    | "closed";
};
```

Deliberate privacy rule for v1:

- do not mirror arbitrary text from `input`, `editor`, or `custom` flows over the socket
- only `confirm` messages may be mirrored in `request.message`

## Runtime replacement and rebinding

`rpc-mode.ts` already contains a useful pattern:

- keep a mutable `session`
- unsubscribe/resubscribe on rebind
- use `runtimeHost.setRebindSession(...)`

However, that exact pattern is insufficient for `--rpc-socket` because `AgentSessionRuntime` currently stores only one rebind callback and one before-invalidate callback.

Recommended prerequisite refactor:

- replace `setRebindSession(...)` / `setBeforeSessionInvalidate(...)` with additive listener registration, for example:
  - `addRebindSessionListener(listener): () => void`
  - `addBeforeSessionInvalidateListener(listener): () => void`
- update interactive mode, print mode, RPC mode, and the new socket server to use listener registration instead of last-writer-wins assignment

After that prerequisite, the socket server can reuse the existing mutable-session/unsubscribe-resubscribe pattern safely.

## Socket lifecycle and shutdown

### Startup

- resolve the socket path to an absolute path
- validate parent directory existence and path-length constraints before interactive startup
- validate that no entry exists at the socket path
- bind the socket before entering the long-running interactive loop, or fail fast
- restrict the created socket to current-user access equivalent to `0600`

### Shutdown

Responsibilities:

- stop accepting new connections
- emit the final socket-only shutdown event to connected clients when shutdown is orderly
- close active connections
- unlink the socket file if this process created it

Potential edge cases:

- abrupt termination where unlink does not happen
- stale socket file from previous crash causing startup error by design

The spec requires startup to error if the path already exists. A future enhancement could add an explicit stale-socket recovery flag, but that is out of scope here.

## Documentation updates to consider

At minimum:

- `packages/coding-agent/docs/rpc.md`
  - clarify relationship between stdio RPC mode and socket-backed interactive RPC
- CLI help text in `packages/coding-agent/src/main.ts`
- potentially a new doc page for interactive RPC socket mode if the surface becomes large enough

## Suggested implementation slices

A future implementation could be staged roughly as:

1. CLI flag parsing and incompatibility validation
2. minimal Unix socket server with connection management and JSONL framing
3. event broadcast from `session.subscribe(...)`
4. command handling reuse for non-UI commands
5. session/runtime rebind handling
6. UI wait event instrumentation around interactive extension dialogs
7. protocol/docs alignment review against `rpc.md`

## Implementation-time decisions

This section records decisions made during implementation so the fork stays understandable and maintenance-friendly.

### Decision log

- No implementation-time decisions recorded yet.

### Maintenance bias for this fork

The implementation should prefer the smallest change surface that preserves compatibility with upstream pi behavior:

- prefer adding a new socket-specific helper over large transport abstractions
- prefer reusing existing RPC helpers and types over inventing a parallel protocol stack
- prefer localized changes in `main.ts`, runtime lifecycle wiring, and a new socket server module over broad refactors of interactive mode
- avoid changing interactive editor behavior unless required by the spec
- avoid modifying extension APIs or extension author contracts for v1
- keep the example sidecar simple and self-contained so it can act as a regression probe for future rebases

# WORK LOG

### Initial Repo State

- Branch: `anton/pi-tee`
- `git status --short` at discussion-to-writing transition showed one untracked file unrelated to this spec draft:
  - `?? tg_events.jsonl`
- `docs/` existed but contained no tracked files at the time of writing.

### Checklist

- [x] Read discussion guidance and confirmed discussion-only phase before writing
- [x] Read spec writing/review guidance before drafting
- [x] Captured agreed CLI surface for `--rpc-socket`
- [x] Captured agreed incompatibilities with `--mode` and `-p`
- [x] Captured shared serialization requirement across human and socket clients
- [x] Captured interactive-TUI ownership of extension UI
- [x] Captured requirement for `ui_wait_*` events
- [x] Captured multi-client broadcast/response routing goals
- [x] Added concrete code references for future implementation work
- [x] Wrote initial standalone spec draft in `docs/pi-rpc-socket-mode.md`
- [x] Incorporated first review pass findings about single-owner rebind hooks, protocol deviations, and pinned `ui_wait_*` payloads
- [x] Added one-line decisions for late join, socket permissions, TTY requirement, backpressure, path validation, `InputSource`, shutdown, and command-set completeness
- [x] Incorporated second review pass tightening around `custom()` scope, hello/shutdown ordering, `ui_wait_*` payload details, deadlock semantics, and measurable success criteria

### Concrete implementation plan

The implementation plan is intentionally biased toward minimal maintenance burden for a long-lived fork.

1. Write the example sidecar first
   - Add a tiny example client binary that connects to the Unix socket, prints all JSONL records, and sends `steer` with `I love those dogs!` when it observes a user message containing `chilidog`.
   - Keep it intentionally dumb and transport-focused so it becomes an immediate progress probe.
   - Goal: derisk framing, event shapes, and basic command routing before touching interactive internals too much.

2. Inventory existing RPC-mode reuse points
   - Read `rpc-mode.ts`, `rpc-types.ts`, `jsonl.ts`, and interactive mode lifecycle wiring.
   - Identify the smallest extractable command-dispatch and response-writing helpers needed by both stdio RPC and socket RPC.
   - Record any implementation-time decisions in the new decision log before making larger refactors.

3. Add additive runtime lifecycle listeners with minimal API churn
   - Generalize `AgentSessionRuntime` rebind/invalidate lifecycle from single-owner callbacks to additive listeners.
   - Update current call sites with the smallest possible compatibility-preserving edits.
   - Derisking: this is the main architectural prerequisite, so land it before building socket mode on top.

4. Add CLI parsing and startup validation for `--rpc-socket`
   - Reject incompatible combinations with `--mode rpc`, `--mode json`, and `--print`.
   - Require interactive TTY availability.
   - Resolve and validate the socket path before starting the long-running session.
   - Keep failure behavior simple and fail-fast.

5. Add a standalone socket server module
   - Implement Unix domain socket bind/listen/cleanup, JSONL framing, hello record, bounded per-client buffering, and per-client response routing.
   - Subscribe to session events and broadcast compatible event payloads.
   - Keep extension UI ownership entirely out of this module.

6. Reuse RPC command handling with the smallest viable extraction
   - Prefer a small shared command-dispatch helper over a broad transport abstraction.
   - Keep stdio RPC behavior unchanged except where code is mechanically shared.
   - Reject `extension_ui_response` on the socket via the existing unsupported-command path.

7. Wire socket server into interactive mode startup
   - Start normal interactive mode.
   - Start the socket server alongside it.
   - Ensure socket connections survive runtime/session replacement via rebinding.
   - Re-establish event subscriptions after `/new`, `/resume`, `/fork`, `/clone`, and similar replacement paths.

8. Add UI wait instrumentation with minimal blast radius
   - Prefer wrapping the interactive `ExtensionUIContext` blocking methods instead of modifying extension APIs.
   - Emit `ui_wait_start` / `ui_wait_end` only for socket visibility.
   - Reinstall the wrapper after session replacement.

9. Manual verification pause: sidecar smoke test
   - Run `pi --rpc-socket ...` plus the example sidecar.
   - Verify hello, event printing, steer injection on `chilidog`, and editor preservation while typing.
   - If the implementation shape has drifted from the spec in a meaningful way, pause and update the decision log before continuing.

10. Documentation alignment and cleanup
   - Update `packages/coding-agent/docs/rpc.md` and any CLI help text only after the implementation shape is stable.
   - Keep docs narrowly scoped to avoid unnecessary maintenance overhead.

### Explicit derisking strategy

- Do the example sidecar early.
- Do lifecycle-listener refactoring before socket transport integration.
- Avoid broad transport abstractions unless command-sharing duplication becomes clearly worse than a small refactor.
- Prefer manual smoke checks early, then `npm run check` after code changes stabilize.

### Planned pauses for user verification

- Pause after the example sidecar and minimal socket handshake are working if the user wants an early review of the wire shape.
- Pause after lifecycle rebinding and multi-client event broadcast are working if implementation complexity starts to exceed the minimal-change goal.
- Otherwise proceed through the full implementation and present the manual test path plus the example sidecar behavior at the end.

### Notes

- Discussion established that the desired feature is not “interactive mode plus stdout RPC”, but rather “interactive mode plus out-of-band RPC socket”.
- The most important architectural constraint recorded here is that interactive mode must remain the sole extension UI owner; otherwise the feature would degrade the extension ecosystem in the same way as current RPC mode.
- First review pass identified a hard architectural blocker in `AgentSessionRuntime` callback ownership. The spec now treats additive lifecycle listeners as a prerequisite rather than an implementation detail.
- The spec now documents the main protocol deviation from stdio RPC mode: no `extension_ui_request` / `extension_ui_response` flow on the socket, replaced by `ui_wait_*` visibility events.
- Second review pass focused on tightening semantics rather than changing architecture. The remaining decisions were about making the wire contract and lifecycle behavior explicit enough for a new implementer and client author.
