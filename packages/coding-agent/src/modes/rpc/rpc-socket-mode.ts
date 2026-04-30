import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { executeRpcCommand, rpcError } from "./rpc-command-handler.js";
import type {
	RpcCommand,
	RpcResponse,
	RpcSocketBroadcastEvent,
	RpcSocketHelloRecord,
	RpcSocketRecord,
} from "./rpc-types.js";

const DEFAULT_MAX_CLIENT_BACKLOG_BYTES = 1024 * 1024;
const RPC_SOCKET_PROTOCOL_VERSION = 1 as const;

function getMaxUnixSocketPathBytes(): number {
	switch (process.platform) {
		case "darwin":
		case "freebsd":
		case "netbsd":
		case "openbsd":
		case "sunos":
			return 103;
		default:
			return 107;
	}
}

async function assertSocketPathDoesNotExist(socketPath: string): Promise<void> {
	try {
		await lstat(socketPath);
		throw new Error(`RPC socket path already exists: ${socketPath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
}

export async function resolveAndValidateRpcSocketPath(socketPath: string): Promise<string> {
	const resolvedPath = resolve(process.cwd(), socketPath);
	const parentDir = dirname(resolvedPath);
	const maxPathBytes = getMaxUnixSocketPathBytes();
	const pathBytes = Buffer.byteLength(resolvedPath);

	if (pathBytes > maxPathBytes) {
		throw new Error(
			`RPC socket path is too long for this platform (${pathBytes} bytes, max ${maxPathBytes}): ${resolvedPath}`,
		);
	}

	try {
		await access(parentDir, fsConstants.F_OK);
	} catch {
		throw new Error(`RPC socket parent directory does not exist: ${parentDir}`);
	}

	await assertSocketPathDoesNotExist(resolvedPath);
	return resolvedPath;
}

class RpcSocketClient {
	private readonly queue: string[] = [];
	private queuedBytes = 0;
	private flushing = false;
	private closed = false;
	private endRequested = false;
	private endPromise: Promise<void> | undefined;
	private resolveEndPromise: (() => void) | undefined;

	constructor(
		private readonly socket: Socket,
		private readonly maxBacklogBytes: number,
		private readonly onClose: () => void,
	) {
		this.socket.on("close", () => {
			this.closed = true;
			this.onClose();
			this.resolveEndPromise?.();
		});
		this.socket.on("error", () => {
			this.socket.destroy();
		});
	}

	enqueue(record: RpcSocketRecord | RpcResponse): void {
		if (this.closed) {
			return;
		}

		const payload = serializeJsonLine(record);
		this.queuedBytes += Buffer.byteLength(payload);
		if (this.queuedBytes > this.maxBacklogBytes) {
			this.socket.destroy(new Error("RPC socket client exceeded output backlog limit"));
			return;
		}

		this.queue.push(payload);
		this.flush();
	}

	async endGracefully(): Promise<void> {
		if (this.closed) {
			return;
		}
		if (!this.endPromise) {
			this.endPromise = new Promise<void>((resolve) => {
				this.resolveEndPromise = resolve;
			});
		}
		this.endRequested = true;
		this.flush();
		return this.endPromise;
	}

	private flush(): void {
		if (this.flushing || this.closed) {
			return;
		}
		this.flushing = true;

		while (this.queue.length > 0) {
			const chunk = this.queue[0];
			if (!chunk) {
				break;
			}
			const wrote = this.socket.write(chunk);
			this.queue.shift();
			this.queuedBytes -= Buffer.byteLength(chunk);
			if (!wrote) {
				this.socket.once("drain", () => {
					this.flushing = false;
					this.flush();
				});
				return;
			}
		}

		this.flushing = false;
		if (this.endRequested && !this.closed) {
			this.socket.end();
		}
	}
}

export interface RpcSocketServerOptions {
	socketPath: string;
	maxClientBacklogBytes?: number;
}

export interface RpcSocketServerHandle {
	socketPath: string;
	broadcastEvent: (event: RpcSocketBroadcastEvent) => void;
	closeGracefully: () => Promise<void>;
}

export async function runRpcSocketServer(
	runtimeHost: AgentSessionRuntime,
	options: RpcSocketServerOptions,
): Promise<RpcSocketServerHandle> {
	const socketPath = await resolveAndValidateRpcSocketPath(options.socketPath);
	const maxClientBacklogBytes = options.maxClientBacklogBytes ?? DEFAULT_MAX_CLIENT_BACKLOG_BYTES;
	const clients = new Set<RpcSocketClient>();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let closed = false;

	const helloRecord: RpcSocketHelloRecord = {
		type: "hello",
		protocol: "pi-rpc-socket",
		version: RPC_SOCKET_PROTOCOL_VERSION,
	};

	const server = createServer((socket) => {
		const client = new RpcSocketClient(socket, maxClientBacklogBytes, () => {
			clients.delete(client);
		});
		client.enqueue(helloRecord);
		clients.add(client);

		const detachJsonl = attachJsonlLineReader(socket, (line) => {
			void handleInputLine(client, line);
		});
		socket.on("close", detachJsonl);
	});

	const closeServer = async (serverToClose: Server): Promise<void> => {
		await new Promise<void>((resolve, reject) => {
			serverToClose.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	};

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			broadcastEvent(event);
		});
	};

	runtimeHost.addRebindSessionListener(async () => {
		await rebindSession();
	});

	const broadcastEvent = (event: RpcSocketBroadcastEvent): void => {
		for (const client of clients) {
			client.enqueue(event);
		}
	};

	const handleInputLine = async (client: RpcSocketClient, line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError) {
			client.enqueue(
				rpcError(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await executeRpcCommand({
				runtimeHost,
				command,
				output: (record) => {
					client.enqueue(record);
				},
			});
			if (response) {
				client.enqueue(response);
			}
		} catch (commandError) {
			client.enqueue(
				rpcError(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
		}
	};

	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(socketPath, () => {
			server.off("error", rejectPromise);
			resolvePromise();
		});
	});
	await chmod(socketPath, 0o600);
	await rebindSession();

	const closeGracefully = async (): Promise<void> => {
		if (closed) {
			return;
		}
		closed = true;
		unsubscribe?.();
		for (const client of clients) {
			client.enqueue({ type: "shutdown" });
		}
		await Promise.all(Array.from(clients, (client) => client.endGracefully()));
		await closeServer(server);
		await unlink(socketPath).catch(() => undefined);
	};

	return {
		socketPath,
		broadcastEvent,
		closeGracefully,
	};
}
