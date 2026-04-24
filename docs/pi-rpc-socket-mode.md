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
- If a filesystem entry already exists at that path, pi exits with an error instead of removing or replacing it.
- The implementation may remove the socket file it created during clean shutdown, but that cleanup behavior is not required as a compatibility guarantee for this spec.

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

Intentional deviations from `--mode rpc` are allowed only where interactive TUI ownership makes them necessary. Every such deviation must be documented.

### Transport

- Transport is Unix domain socket.
- Records are LF-delimited JSON objects using the same framing rules as current RPC mode.
- Events are broadcast to all connected clients.
- Responses are routed only to the requesting client.

### Command semantics

All currently supported RPC commands remain in scope as compatibility targets, including at minimum:

- `prompt`
- `steer`
- `follow_up`
- `abort`
- `get_state`
- `get_messages`
- `set_model`
- `cycle_model`
- `set_thinking_level`
- `cycle_thinking_level`
- `new_session`
- `switch_session`
- `fork`
- `clone`
- `compact`
- `get_session_stats`
- `get_commands`
- `get_last_assistant_text`
- `set_session_name`

Behavioral requirements:

- Socket-originated `prompt` behaves like RPC `prompt` as closely as possible.
- Socket-originated extension commands are allowed. If such a command triggers extension UI, the human-facing TUI handles it.
- Message acceptance and queueing semantics continue to respect the session's existing `prompt`/`steer`/`followUp` behavior.
- Human and socket-originated sends must flow through one shared serialization point so that ordering is deterministic within a single pi process.

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

### New `--rpc-socket`-specific UI wait events

Add new events specific to `--rpc-socket` mode for visibility into human-mediated extension UI waits.

Initial event family:

```json
{
  "type": "ui_wait_start",
  "request": {
    "method": "confirm",
    "title": "Run project-local agents?",
    "message": "...optional..."
  }
}
```

```json
{
  "type": "ui_wait_end",
  "request": {
    "method": "confirm",
    "title": "Run project-local agents?"
  },
  "resolution": "confirmed"
}
```

Minimum requirements:

- `ui_wait_start` is emitted when the interactive UI begins waiting for human input on behalf of an extension UI request.
- `ui_wait_end` is emitted when that wait finishes, whether by confirmation, selection, input submission, cancellation, timeout, or abort.
- `request.method` should distinguish at least:
  - `select`
  - `confirm`
  - `input`
  - `editor`
- Human-readable metadata such as `title`, `message`, and possibly option count may be included when available.
- The exact payload shape may be refined during implementation, but the capability is required.

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

## Runtime Replacement and Session Rebinding

The socket server must survive interactive runtime/session replacement and continue serving connected clients across operations that replace `runtime.session`, including at minimum:

- `/new`
- `/resume`
- `/fork`
- `/clone`
- reload paths that replace the current runtime/session

Requirements:

- existing socket connections remain valid if the process stays alive
- event subscriptions are rebound to the new active session/runtime
- subsequent commands target the new active session/runtime

## Error Handling

### Startup errors

pi must fail fast with a clear error if:

- `--rpc-socket` is used with an incompatible mode flag
- the socket path already exists
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
7. After session replacement operations, connected socket clients continue to observe and control the new active session.
8. No terminal scraping or simulated keystrokes are required for orchestration.

## Concrete Examples

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

### Example: inactive orchestrator client

State:

- Two clients are connected to the socket.
- One client issues commands.
- The other is event-only.

Expected result:

- Both receive broadcast events.
- Only the requesting client receives the command response object with matching `id`.

## Edge Cases

- A socket client submits a command while the session is already streaming.
- A human submits a message while socket-originated messages are queued.
- Multiple socket clients submit commands close together.
- An extension command initiated over the socket opens a long-lived editor dialog in the TUI.
- The active session is replaced while clients are connected.
- The socket client disconnects during an active run.
- A UI wait ends by cancellation, timeout, or abort rather than successful input.

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

### Open question to verify during implementation

Whether socket command handlers need any additional mode-specific bindings beyond what interactive mode already installs. If so, keep those bindings orthogonal to UI ownership.

## Single serialization point

The spec requires one serialization point shared by human and socket clients.

The implementation should avoid creating a second independent submission path that bypasses interactive mode ordering assumptions.

Possible strategies:

### Strategy A: submit directly to `session.prompt()` / `session.steer()` / `session.followUp()` from both sides

If both human sends and socket sends already funnel into session APIs with deterministic ordering on the JS event loop, this may be sufficient.

What to verify:

- whether interactive mode has any extra pre-submit behavior that must also apply to socket submissions
- whether editor history, pending bash flushes, or command preprocessing occur before `session.prompt()` and whether those are human-only concerns or session-wide concerns

### Strategy B: introduce an explicit send queue above the session APIs

Define a shared sender queue for:

- human editor submit
- socket `prompt`
- socket `steer`
- socket `follow_up`

Advantages:

- ordering semantics become explicit and testable

Trade-off:

- more invasive than using existing session behavior

Given current knowledge, Strategy A is preferable if existing session APIs already provide deterministic ordering and human-only UI state is preserved.

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

Interactive mode already creates the real UI context. Wrap the dialog methods:

- `select`
- `confirm`
- `input`
- `editor`

Pseudo-shape:

- before awaiting the real dialog, broadcast `ui_wait_start`
- after resolution/cancel/timeout/abort, broadcast `ui_wait_end`

Advantages:

- directly reflects actual human-facing waits
- does not require changes to extension authors

Trade-off:

- requires care so that interactive behavior is unchanged

#### Approach 2: instrument at extension runner boundaries

If the extension runner has a stable choke point for UI calls, emit wait events there.

Advantages:

- possibly reusable for other modes later

Trade-off:

- may be more invasive and less clearly tied to the actual interactive UI implementation

Current preference: Approach 1.

### Payload ideas

Initial payload candidates:

```ts
type RpcSocketUiWaitStartEvent = {
  type: "ui_wait_start";
  requestId: string;
  request: {
    method: "select" | "confirm" | "input" | "editor";
    title?: string;
    message?: string;
    optionCount?: number;
  };
};

type RpcSocketUiWaitEndEvent = {
  type: "ui_wait_end";
  requestId: string;
  request: {
    method: "select" | "confirm" | "input" | "editor";
    title?: string;
  };
  resolution:
    | "selected"
    | "confirmed"
    | "submitted"
    | "cancelled"
    | "timed_out"
    | "aborted";
};
```

Open refinement questions for review:

- whether to include redacted vs full prompt text for `input`/`editor`
- whether `message` should be included by default or omitted for privacy/minimality
- whether this event family should later be generalized to stdio RPC mode too

## Runtime replacement and rebinding

`rpc-mode.ts` already contains a useful pattern:

- keep a mutable `session`
- unsubscribe/resubscribe on rebind
- use `runtimeHost.setRebindSession(...)`

That pattern should be adapted for the socket server.

Things to verify in the source:

- exactly how interactive mode handles runtime replacement today
- whether there is one authoritative place to hook socket-server rebinds, or whether both interactive mode and socket server must independently respond to runtime changes

## Socket lifecycle and shutdown

### Startup

- validate that no entry exists at the socket path
- bind the socket before entering the long-running interactive loop, or fail fast

### Shutdown

Likely responsibilities:

- stop accepting new connections
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

### Notes

- Discussion established that the desired feature is not “interactive mode plus stdout RPC”, but rather “interactive mode plus out-of-band RPC socket”.
- The most important architectural constraint recorded here is that interactive mode must remain the sole extension UI owner; otherwise the feature would degrade the extension ecosystem in the same way as current RPC mode.
- Some payload details for `ui_wait_*` events are intentionally left flexible in `IMPLEMENTATION IDEAS` for later review/refinement.
