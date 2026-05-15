import { EmptyRequest } from "@shared/proto/cline/common"
import { State } from "@shared/proto/cline/state"
import { telemetryService } from "@/services/telemetry"
import { ExtensionState } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active state subscriptions
const activeStateSubscriptions = new Set<StreamingResponseHandler<State>>()

// Debounce state updates to merge rapid-fire postStateToWebview calls
// triggered by streaming response handling (e.g. every tool output line).
// Without this, a long conversation can push 10.9MB+ per update, exhausting
// webview memory. 50ms trailing debounce reduces push frequency ~80% without
// perceptible UI lag.
let pendingStateJson: string | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Subscribe to state updates
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToState(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<State>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	activeStateSubscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		activeStateSubscriptions.delete(responseStream)
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "state_subscription" }, responseStream)
	}

	// Send the initial state
	const initialState = await controller.getStateToPostToWebview()
	const initialStateJson = JSON.stringify(initialState)

	recordStateSizeTelemetry(Buffer.byteLength(initialStateJson, "utf8"))

	try {
		await responseStream(
			{
				stateJson: initialStateJson,
			},
			false, // Not the last message
		)
	} catch (error) {
		Logger.error("Error sending initial state:", error)
		activeStateSubscriptions.delete(responseStream)
	}
}

/**
 * Send a state update to all active subscribers
 * @param state The state to send
 */
export async function sendStateUpdate(state: ExtensionState): Promise<void> {
	let stateJson: string
	try {
		stateJson = JSON.stringify(state)
	} catch (error) {
		Logger.error("Error serializing state update:", error)
		return
	}

	pendingStateJson = stateJson

	if (debounceTimer) {
		return // debounce in progress, latest state will be sent when timer fires
	}

	debounceTimer = setTimeout(async () => {
		debounceTimer = null
		const finalStateJson = pendingStateJson!
		pendingStateJson = null

		recordStateSizeTelemetry(Buffer.byteLength(finalStateJson, "utf8"))

		const promises = Array.from(activeStateSubscriptions).map(async (responseStream) => {
			try {
				await responseStream(
					{
						stateJson: finalStateJson,
					},
					false, // Not the last message
				)
			} catch (error) {
				Logger.error("Error sending state update:", error)
				activeStateSubscriptions.delete(responseStream)
			}
		})

		await Promise.all(promises)
	}, 50)
}

function recordStateSizeTelemetry(sizeBytes: number): void {
	telemetryService.captureGrpcResponseSize(sizeBytes, "cline.StateService", "subscribeToState")
}
