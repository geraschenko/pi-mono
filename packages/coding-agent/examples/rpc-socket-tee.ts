/**
 * RPC Socket tee sidecar example.
 *
 * Connects to `pi --rpc-socket <path>`, prints every JSONL record, and sends a
 * steering prompt when it observes a user message containing `chilidog`.
 *
 * Usage:
 *   npx tsx packages/coding-agent/examples/rpc-socket-tee.ts /tmp/pi.sock
 */

import { createConnection } from "node:net";

interface TextPart {
	type: string;
	text?: string;
}

interface UserMessageRecord {
	role?: string;
	content?: string | TextPart[];
}

interface MessageEndRecord {
	type?: string;
	message?: UserMessageRecord;
}

function extractMessageText(message: UserMessageRecord | undefined): string {
	if (!message) {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((part): part is TextPart => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

async function main(): Promise<void> {
	const socketPath = process.argv[2];
	if (!socketPath) {
		console.error("Usage: npx tsx packages/coding-agent/examples/rpc-socket-tee.ts <socket-path>");
		process.exit(1);
	}

	const socket = createConnection(socketPath);
	let buffer = "";
	let steerCounter = 0;

	const send = (record: Record<string, unknown>): void => {
		socket.write(`${JSON.stringify(record)}\n`);
	};

	socket.setEncoding("utf8");
	socket.on("connect", () => {
		console.error(`Connected to ${socketPath}`);
	});

	socket.on("data", (chunk: string) => {
		buffer += chunk;

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}

			console.log(line);

			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}

			const event = record as MessageEndRecord;
			if (event.type !== "message_end" || event.message?.role !== "user") {
				continue;
			}

			const text = extractMessageText(event.message);
			if (!text.toLowerCase().includes("chilidog")) {
				continue;
			}

			steerCounter += 1;
			send({
				id: `chilidog-${steerCounter}`,
				type: "steer",
				message: "I love those dogs!",
			});
		}
	});

	socket.on("error", (error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});

	socket.on("close", () => {
		process.exit(0);
	});
}

void main();
