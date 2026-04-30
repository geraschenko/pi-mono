import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.js";

export function rpcSuccess<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

export function rpcError(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

export interface ExecuteRpcCommandOptions {
	runtimeHost: AgentSessionRuntime;
	command: RpcCommand;
	output: (response: RpcResponse) => void;
}

export async function executeRpcCommand(options: ExecuteRpcCommandOptions): Promise<RpcResponse | undefined> {
	const { runtimeHost, command, output } = options;
	const session = runtimeHost.session;
	const id = command.id;

	switch (command.type) {
		case "prompt": {
			let preflightSucceeded = false;
			void session
				.prompt(command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					source: "rpc",
					preflightResult: (didSucceed) => {
						if (didSucceed) {
							preflightSucceeded = true;
							output(rpcSuccess(id, "prompt"));
						}
					},
				})
				.catch((error: unknown) => {
					if (!preflightSucceeded) {
						output(rpcError(id, "prompt", error instanceof Error ? error.message : String(error)));
					}
				});
			return undefined;
		}

		case "steer": {
			await session.steer(command.message, command.images);
			return rpcSuccess(id, "steer");
		}

		case "follow_up": {
			await session.followUp(command.message, command.images);
			return rpcSuccess(id, "follow_up");
		}

		case "abort": {
			await session.abort();
			return rpcSuccess(id, "abort");
		}

		case "new_session": {
			const newSessionOptions = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const result = await runtimeHost.newSession(newSessionOptions);
			return rpcSuccess(id, "new_session", result);
		}

		case "get_state": {
			const state: RpcSessionState = {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				isStreaming: session.isStreaming,
				isCompacting: session.isCompacting,
				steeringMode: session.steeringMode,
				followUpMode: session.followUpMode,
				sessionFile: session.sessionFile,
				sessionId: session.sessionId,
				sessionName: session.sessionName,
				autoCompactionEnabled: session.autoCompactionEnabled,
				messageCount: session.messages.length,
				pendingMessageCount: session.pendingMessageCount,
			};
			return rpcSuccess(id, "get_state", state);
		}

		case "set_model": {
			const models = await session.modelRegistry.getAvailable();
			const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
			if (!model) {
				return rpcError(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
			}
			await session.setModel(model);
			return rpcSuccess(id, "set_model", model);
		}

		case "cycle_model": {
			const result = await session.cycleModel();
			if (!result) {
				return rpcSuccess(id, "cycle_model", null);
			}
			return rpcSuccess(id, "cycle_model", result);
		}

		case "get_available_models": {
			const models = await session.modelRegistry.getAvailable();
			return rpcSuccess(id, "get_available_models", { models });
		}

		case "set_thinking_level": {
			session.setThinkingLevel(command.level);
			return rpcSuccess(id, "set_thinking_level");
		}

		case "cycle_thinking_level": {
			const level = session.cycleThinkingLevel();
			if (!level) {
				return rpcSuccess(id, "cycle_thinking_level", null);
			}
			return rpcSuccess(id, "cycle_thinking_level", { level });
		}

		case "set_steering_mode": {
			session.setSteeringMode(command.mode);
			return rpcSuccess(id, "set_steering_mode");
		}

		case "set_follow_up_mode": {
			session.setFollowUpMode(command.mode);
			return rpcSuccess(id, "set_follow_up_mode");
		}

		case "compact": {
			const result = await session.compact(command.customInstructions);
			return rpcSuccess(id, "compact", result);
		}

		case "set_auto_compaction": {
			session.setAutoCompactionEnabled(command.enabled);
			return rpcSuccess(id, "set_auto_compaction");
		}

		case "set_auto_retry": {
			session.setAutoRetryEnabled(command.enabled);
			return rpcSuccess(id, "set_auto_retry");
		}

		case "abort_retry": {
			session.abortRetry();
			return rpcSuccess(id, "abort_retry");
		}

		case "bash": {
			const result = await session.executeBash(command.command);
			return rpcSuccess(id, "bash", result);
		}

		case "abort_bash": {
			session.abortBash();
			return rpcSuccess(id, "abort_bash");
		}

		case "get_session_stats": {
			const stats = session.getSessionStats();
			return rpcSuccess(id, "get_session_stats", stats);
		}

		case "export_html": {
			const path = await session.exportToHtml(command.outputPath);
			return rpcSuccess(id, "export_html", { path });
		}

		case "switch_session": {
			const result = await runtimeHost.switchSession(command.sessionPath);
			return rpcSuccess(id, "switch_session", result);
		}

		case "fork": {
			const result = await runtimeHost.fork(command.entryId);
			return rpcSuccess(id, "fork", { text: result.selectedText ?? "", cancelled: result.cancelled });
		}

		case "clone": {
			const leafId = session.sessionManager.getLeafId();
			if (!leafId) {
				return rpcError(id, "clone", "Cannot clone session: no current entry selected");
			}
			const result = await runtimeHost.fork(leafId, { position: "at" });
			return rpcSuccess(id, "clone", { cancelled: result.cancelled });
		}

		case "get_fork_messages": {
			const messages = session.getUserMessagesForForking();
			return rpcSuccess(id, "get_fork_messages", { messages });
		}

		case "get_last_assistant_text": {
			const text = session.getLastAssistantText();
			return rpcSuccess(id, "get_last_assistant_text", { text });
		}

		case "set_session_name": {
			const name = command.name.trim();
			if (!name) {
				return rpcError(id, "set_session_name", "Session name cannot be empty");
			}
			session.setSessionName(name);
			return rpcSuccess(id, "set_session_name");
		}

		case "get_messages": {
			return rpcSuccess(id, "get_messages", { messages: session.messages });
		}

		case "get_commands": {
			const commands: RpcSlashCommand[] = [];

			for (const registeredCommand of session.extensionRunner.getRegisteredCommands()) {
				commands.push({
					name: registeredCommand.invocationName,
					description: registeredCommand.description,
					source: "extension",
					sourceInfo: registeredCommand.sourceInfo,
				});
			}

			for (const template of session.promptTemplates) {
				commands.push({
					name: template.name,
					description: template.description,
					source: "prompt",
					sourceInfo: template.sourceInfo,
				});
			}

			for (const skill of session.resourceLoader.getSkills().skills) {
				commands.push({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				});
			}

			return rpcSuccess(id, "get_commands", { commands });
		}

		default: {
			const unknownCommand = command as { type: string };
			return rpcError(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
		}
	}
}
