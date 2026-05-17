import type { ClineMessage } from "@shared/ExtensionMessage"
import { FetchMessageRequest } from "@shared/proto/cline/task"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import type React from "react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { Virtuoso } from "react-virtuoso"
import { StickyUserMessage } from "@/components/chat/task-header/StickyUserMessage"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { isToolGroup } from "../../utils/messageUtils"
import { createMessageRenderer } from "../messages/MessageRenderer"

const LOAD_THRESHOLD = 100
const LOAD_COUNT = 200
const ROW_LOAD_THRESHOLD = 8

const MAX_SIDE_BUFFER = 300
const TRIM_SIDE_TARGET = 180

interface MessagesAreaProps {
	task: ClineMessage
	groupedMessages: (ClineMessage | ClineMessage[])[]
	modifiedMessages: ClineMessage[]
	scrollBehavior: ScrollBehavior
	chatState: ChatState
	messageHandlers: MessageHandlers
}

type RenderRow = {
	row: ClineMessage | ClineMessage[]
	startMessageIndex: number
	endMessageIndex: number
	startMessageTs?: number
	endMessageTs?: number
}

type ScrollDirection = "up" | "down" | "none"

type PendingAnchor = {
	ts: number
	align: "start" | "center" | "end"
}

export const MessagesArea: React.FC<MessagesAreaProps> = ({
	task,
	groupedMessages,
	modifiedMessages,
	scrollBehavior,
	chatState,
	messageHandlers,
}) => {
	const { clineMessages, setClineMessages, totalMessageCount, firstItemIndex, setFirstItemIndex } = useExtensionState()

	const firstItemIndexRef = useRef(firstItemIndex)
	const clineMessagesLengthRef = useRef(clineMessages.length)
	const lastViewportCenterRef = useRef<number | null>(null)
	const inflightRef = useRef<Set<string>>(new Set())
	const pendingAnchorRef = useRef<PendingAnchor | null>(null)
	const prevRangeRef = useRef<{ start: number; end: number } | null>(null)
	const lastRangeProcessedRef = useRef(0)
	const isUserScrollingRef = useRef(false)
	const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		firstItemIndexRef.current = firstItemIndex
	}, [firstItemIndex])

	useEffect(() => {
		clineMessagesLengthRef.current = clineMessages.length
	}, [clineMessages.length])

	const lastRawMessage = useMemo(() => clineMessages.at(-1), [clineMessages])

	const {
		virtuosoRef,
		scrollContainerRef,
		toggleRowExpansion,
		handleRowHeightChange,
		setIsAtBottom,
		setShowScrollToBottom,
		disableAutoScrollRef,
		scrolledPastUserMessage,
	} = scrollBehavior

	const messageIndexByTs = useMemo(() => {
		const map = new Map<number, number>()

		clineMessages.forEach((msg, offset) => {
			map.set(msg.ts, firstItemIndex + offset)
		})

		return map
	}, [clineMessages, firstItemIndex])

	const renderRows = useMemo<RenderRow[]>(() => {
		let fallbackIndex = firstItemIndex

		return groupedMessages.map((row) => {
			const rowMessages = Array.isArray(row) ? row : [row]

			const mappedIndexes = rowMessages
				.map((msg) => messageIndexByTs.get(msg.ts))
				.filter((index): index is number => typeof index === "number")

			const startMessageIndex = mappedIndexes.length > 0 ? Math.min(...mappedIndexes) : fallbackIndex
			const endMessageIndex =
				mappedIndexes.length > 0 ? Math.max(...mappedIndexes) : startMessageIndex + rowMessages.length - 1

			fallbackIndex = Math.max(fallbackIndex, endMessageIndex + 1)

			return {
				row,
				startMessageIndex,
				endMessageIndex,
				startMessageTs: rowMessages.at(0)?.ts,
				endMessageTs: rowMessages.at(-1)?.ts,
			}
		})
	}, [groupedMessages, messageIndexByTs, firstItemIndex])

	const visibleGroupedMessages = useMemo<(ClineMessage | ClineMessage[])[]>(
		() => renderRows.map((renderRow) => renderRow.row),
		[renderRows],
	)

	const findRowOffsetByMessageTs = useCallback(
		(ts: number) => {
			return renderRows.findIndex((renderRow) => {
				if (Array.isArray(renderRow.row)) {
					return renderRow.row.some((msg) => msg.ts === ts)
				}

				return renderRow.row.ts === ts
			})
		},
		[renderRows],
	)

	const scrollToRowOffset = useCallback(
		(index: number, align: "start" | "center" | "end" = "start", behavior: "auto" | "smooth" = "smooth") => {
			virtuosoRef.current?.scrollToIndex({
				index,
				align,
				behavior,
			})
		},
		[virtuosoRef],
	)

	useLayoutEffect(() => {
		const pendingAnchor = pendingAnchorRef.current
		if (!pendingAnchor) return
		if (renderRows.length === 0) return

		const rowOffset = findRowOffsetByMessageTs(pendingAnchor.ts)
		if (rowOffset < 0) return

		pendingAnchorRef.current = null
		scrollToRowOffset(rowOffset, pendingAnchor.align, "auto")
	}, [renderRows.length, findRowOffsetByMessageTs, scrollToRowOffset])

	const scrolledPastUserMessageRowOffset = useMemo(() => {
		if (!scrolledPastUserMessage) return -1
		return findRowOffsetByMessageTs(scrolledPastUserMessage.ts)
	}, [findRowOffsetByMessageTs, scrolledPastUserMessage])

	const handleScrollToUserMessage = useCallback(() => {
		if (scrolledPastUserMessageRowOffset >= 0) {
			scrollToRowOffset(scrolledPastUserMessageRowOffset, "center")
		}
	}, [scrolledPastUserMessageRowOffset, scrollToRowOffset])

	const { expandedRows, inputValue, setActiveQuote } = chatState

	const lastVisibleRow = useMemo(() => visibleGroupedMessages.at(-1), [visibleGroupedMessages])

	const lastVisibleMessage = useMemo(() => {
		const lastRow = lastVisibleRow
		if (!lastRow) return undefined
		return Array.isArray(lastRow) ? lastRow.at(-1) : lastRow
	}, [lastVisibleRow])

	const isWaitingForResponse = useMemo(() => {
		const lastMsg = modifiedMessages[modifiedMessages.length - 1]

		if (lastRawMessage?.type === "ask") return false
		if (lastRawMessage?.type === "say" && lastRawMessage.say === "completion_result") return false

		if (lastRawMessage?.type === "say" && lastRawMessage.say === "api_req_started") {
			try {
				const info = JSON.parse(lastRawMessage.text || "{}")
				if (info.cancelReason === "user_cancelled") return false
			} catch {
				// Ignore malformed api_req_started payloads.
			}
		}

		if (visibleGroupedMessages.length === 0) return true
		if (!lastVisibleMessage) return true
		if (lastVisibleRow && isToolGroup(lastVisibleRow)) return true
		if (lastVisibleMessage.partial !== true) return true
		if (!lastMsg) return true
		if (lastMsg.say === "user_feedback" || lastMsg.say === "user_feedback_diff") return true

		if (lastMsg.say === "api_req_started") {
			try {
				const info = JSON.parse(lastMsg.text || "{}")
				return info.cost == null
			} catch {
				return true
			}
		}

		return false
	}, [lastRawMessage, visibleGroupedMessages.length, lastVisibleMessage, lastVisibleRow, modifiedMessages])

	const showThinkingLoaderRow = useMemo(() => {
		const handoffToReasoningPending =
			lastRawMessage?.type === "say" &&
			lastRawMessage.say === "reasoning" &&
			lastRawMessage.partial === true &&
			lastVisibleMessage?.say !== "reasoning"

		return isWaitingForResponse || handoffToReasoningPending
	}, [isWaitingForResponse, lastRawMessage, lastVisibleMessage?.say])

	const itemContent = useMemo(
		() =>
			createMessageRenderer(
				visibleGroupedMessages,
				modifiedMessages,
				expandedRows,
				toggleRowExpansion,
				handleRowHeightChange,
				setActiveQuote,
				inputValue,
				messageHandlers,
				false,
			),
		[
			visibleGroupedMessages,
			modifiedMessages,
			expandedRows,
			toggleRowExpansion,
			handleRowHeightChange,
			setActiveQuote,
			inputValue,
			messageHandlers,
		],
	)

	const virtuosoComponents = useMemo(
		() => ({
			Footer: () => (
				<>
					{showThinkingLoaderRow && <div className="min-h-1" />}
					<div className="min-h-1" />
				</>
			),
		}),
		[showThinkingLoaderRow],
	)

	const fetchAndMerge = useCallback(
		async (start: number, count: number, anchor?: PendingAnchor) => {
			const key = `${start}:${count}`
			if (inflightRef.current.has(key)) return false

			inflightRef.current.add(key)

			if (anchor) {
				pendingAnchorRef.current = anchor
			}

			try {
				const resp = await TaskServiceClient.fetchMessage(FetchMessageRequest.create({ referenceIndex: start, count }))
				const msgs = (resp.messages as any[]).map((m) => convertProtoToClineMessage(m)) as ClineMessage[]
				const si = resp.startIndex

				if (msgs.length === 0) {
					if (anchor) pendingAnchorRef.current = null
					return false
				}

				let merged = false

				setClineMessages((prev) => {
					const fi = firstItemIndexRef.current

					if (si === fi + prev.length) {
						merged = true

						const next = [...prev, ...msgs]
						clineMessagesLengthRef.current = next.length

						return next
					}

					if (si + msgs.length === fi) {
						merged = true
						firstItemIndexRef.current = si
						setFirstItemIndex(si)

						const next = [...msgs, ...prev]
						clineMessagesLengthRef.current = next.length

						return next
					}

					return prev
				})

				if (!merged && anchor) {
					pendingAnchorRef.current = null
				}

				return merged
			} catch (e) {
				if (anchor) pendingAnchorRef.current = null
				console.error("fetchMessage:", e)
				return false
			} finally {
				inflightRef.current.delete(key)
			}
		},
		[setClineMessages, setFirstItemIndex],
	)

	const handleRangeChanged = useCallback(
		(range: { startIndex: number; endIndex: number }) => {
			const dataLen = clineMessagesLengthRef.current
			const fi = firstItemIndexRef.current
			const total = totalMessageCount ?? dataLen

			if (dataLen === 0) return
			if (renderRows.length === 0) return

			const now = Date.now()
			if (now - lastRangeProcessedRef.current < 200) return
			lastRangeProcessedRef.current = now

			// Filter out rangeChanged calls not caused by actual scroll (e.g. subscribeToState push).
			if (
				prevRangeRef.current &&
				prevRangeRef.current.start === range.startIndex &&
				prevRangeRef.current.end === range.endIndex
			)
				return
			prevRangeRef.current = { start: range.startIndex, end: range.endIndex }

			const localStart = range.startIndex - fi
			const localEnd = range.endIndex - fi
			const firstVisibleRow = renderRows[localStart]
			const lastVisibleRow = renderRows[localEnd]

			if (!firstVisibleRow || !lastVisibleRow) return

			const firstVisibleMessageIndex = firstVisibleRow.startMessageIndex
			const lastVisibleMessageIndex = lastVisibleRow.endMessageIndex
			const firstVisibleMessageTs = firstVisibleRow.startMessageTs

			const topRowDistance = Math.max(0, localStart)
			const bottomRowDistance = Math.max(0, renderRows.length - 1 - localEnd)

			const isAllLoaded = fi <= 0 && fi + dataLen >= total
			if (isAllLoaded) return

			const aheadCount = Math.max(0, firstVisibleMessageIndex - fi)
			const behindCount = Math.max(0, fi + dataLen - 1 - lastVisibleMessageIndex)

			const viewportCenter = (firstVisibleMessageIndex + lastVisibleMessageIndex) / 2
			const prevViewportCenter = lastViewportCenterRef.current
			lastViewportCenterRef.current = viewportCenter

			let scrollDirection: ScrollDirection = "none"

			if (prevViewportCenter != null) {
				if (viewportCenter > prevViewportCenter + 2) {
					scrollDirection = "down"
				} else if (viewportCenter < prevViewportCenter - 2) {
					scrollDirection = "up"
				}
			}

			setShowScrollToBottom(disableAutoScrollRef.current || !isAllLoaded || lastVisibleMessageIndex < total - 1)

			console.debug(
				`[MessagesArea] rangeChanged: visibleRows=[${range.startIndex},${range.endIndex}] ` +
					`localRows=[${localStart},${localEnd}] ` +
					`visibleMessages=[${firstVisibleMessageIndex},${lastVisibleMessageIndex}] ` +
					`fi=${fi} dataLen=${dataLen} total=${total} | ` +
					`ahead=${aheadCount} behind=${behindCount} ` +
					`topRows=${topRowDistance} bottomRows=${bottomRowDistance} ` +
					`direction=${scrollDirection}`,
			)

			if ((topRowDistance <= ROW_LOAD_THRESHOLD || aheadCount < LOAD_THRESHOLD) && fi > 0) {
				const start = Math.max(fi - LOAD_COUNT, 0)
				const take = fi - start

				if (take > 0 && firstVisibleMessageTs != null) {
					void fetchAndMerge(start, take, {
						ts: firstVisibleMessageTs,
						align: "start",
					})
				}
			}

			if ((bottomRowDistance <= ROW_LOAD_THRESHOLD || behindCount < LOAD_THRESHOLD) && fi + dataLen < total) {
				const take = Math.min(LOAD_COUNT, total - (fi + dataLen))

				if (take > 0) {
					void fetchAndMerge(fi + dataLen, take)
				}
			}
		},
		[
			totalMessageCount,
			renderRows,
			disableAutoScrollRef,
			setShowScrollToBottom,
			setClineMessages,
			setFirstItemIndex,
			fetchAndMerge,
		],
	)

	// Mark user scrolling via native scroll events on the container.
	useEffect(() => {
		const el = scrollContainerRef.current
		if (!el) return
		const onScroll = () => {
			isUserScrollingRef.current = true
			if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
			scrollTimerRef.current = setTimeout(() => {
				isUserScrollingRef.current = false
			}, 300)
		}
		el.addEventListener("scroll", onScroll, { passive: true })
		return () => {
			el.removeEventListener("scroll", onScroll)
			if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
		}
	}, [scrollContainerRef])

	// Idle trim: only when user is NOT actively scrolling.
	useEffect(() => {
		if (isUserScrollingRef.current) return
		const fi = firstItemIndexRef.current
		const dataLen = clineMessagesLengthRef.current
		if (dataLen === 0) return

		const total = totalMessageCount ?? dataLen
		if (fi <= 0 && fi + dataLen >= total) return // all loaded, no trim needed

		if (renderRows.length === 0) return

		const firstRow = renderRows[0]
		const lastRow = renderRows[renderRows.length - 1]
		if (!firstRow || !lastRow) return

		const aheadCount = Math.max(0, firstRow.startMessageIndex - fi)
		const behindCount = Math.max(0, fi + dataLen - 1 - lastRow.endMessageIndex)

		if (aheadCount > MAX_SIDE_BUFFER) {
			const remove = Math.max(0, Math.min(aheadCount - TRIM_SIDE_TARGET, dataLen))
			if (remove > 0) {
				setClineMessages((prev) => {
					const next = prev.slice(remove)
					clineMessagesLengthRef.current = next.length
					return next
				})
				setFirstItemIndex((prev) => {
					const next = prev + remove
					firstItemIndexRef.current = next
					return next
				})
			}
			return
		}

		if (behindCount > MAX_SIDE_BUFFER) {
			const keep = Math.max(0, Math.min(dataLen, dataLen - (behindCount - TRIM_SIDE_TARGET)))
			if (keep < dataLen) {
				setClineMessages((prev) => {
					const next = prev.slice(0, keep)
					clineMessagesLengthRef.current = next.length
					return next
				})
			}
		}
	}, [clineMessages.length, firstItemIndex, totalMessageCount, renderRows, setClineMessages, setFirstItemIndex])

	return (
		<div className="overflow-hidden flex flex-col h-full relative">
			<div
				className={cn(
					"absolute top-0 left-0 right-0 z-10 pl-[15px] pr-[14px] bg-background",
					scrolledPastUserMessage && "pb-2",
				)}>
				<StickyUserMessage
					isVisible={!!scrolledPastUserMessage}
					lastUserMessage={scrolledPastUserMessage}
					onScrollToMessage={handleScrollToUserMessage}
				/>
			</div>

			<div className="grow flex" ref={scrollContainerRef}>
				<Virtuoso
					atBottomStateChange={(isAtBottom) => {
						setIsAtBottom(isAtBottom)

						if (isAtBottom) {
							disableAutoScrollRef.current = false
						}

						setShowScrollToBottom(disableAutoScrollRef.current && !isAtBottom)
					}}
					atBottomThreshold={10}
					className="scrollable grow overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
					components={virtuosoComponents}
					data={visibleGroupedMessages}
					firstItemIndex={firstItemIndex}
					increaseViewportBy={{ top: 100, bottom: 100 }}
					initialTopMostItemIndex={firstItemIndex + Math.max(visibleGroupedMessages.length - 1, 0)}
					itemContent={itemContent}
					key={task.ts}
					rangeChanged={handleRangeChanged}
					ref={virtuosoRef}
					style={{ overflowAnchor: "none" }}
					totalCount={totalMessageCount ?? clineMessages.length}
				/>
			</div>
		</div>
	)
}
