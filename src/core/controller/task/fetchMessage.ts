import { FetchMessageRequest, FetchMessageResponse } from "@shared/proto/cline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Controller } from "../index"

/**
 * Fetch messages by absolute index and count.
 * Task message (say === "task") is excluded — it's sent separately via taskTitleMessage.
 */
export async function fetchMessage(controller: Controller, request: FetchMessageRequest): Promise<FetchMessageResponse> {
	const messages = controller.task?.messageStateHandler.getClineMessages() || []
	const bodyMessages = messages.filter((m) => m.say !== "task")
	const total = bodyMessages.length

	const referenceIndex = Number(request.referenceIndex)
	const count = Number(request.count)

	let result: typeof bodyMessages
	let startIndex = -1
	if (referenceIndex === -1) {
		// -1 means fetch the last `count` messages
		startIndex = Math.max(0, total - count)
		result = bodyMessages.slice(startIndex)
	} else {
		startIndex = Math.max(0, Math.min(referenceIndex, total))
		const endIndex = Math.min(startIndex + count, total)
		result = bodyMessages.slice(startIndex, endIndex)
	}

	return { messages: result.map(convertClineMessageToProto), totalCount: total, startIndex }
}
