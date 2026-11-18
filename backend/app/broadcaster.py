"""WebSocket message fan-out."""

import asyncio

from fastapi import WebSocket

Message = dict[str, object]
ClientQueue = asyncio.Queue[Message]
QUEUE_SIZE = 60


class Broadcaster:
    """Fan out messages on the event loop without waiting for clients."""

    def __init__(self) -> None:
        """Start with no connected clients."""
        self._clients: set[ClientQueue] = set()

    def register(self) -> ClientQueue:
        """Allocate a bounded queue for a client on the event loop."""
        queue: ClientQueue = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._clients.add(queue)
        return queue

    def unregister(self, queue: ClientQueue) -> None:
        """Remove a disconnected client's queue."""
        self._clients.discard(queue)

    def publish(self, message: Message) -> None:
        """Enqueue a message, preferring to discard the oldest frame on overflow."""
        for queue in self._clients:
            if queue.full():
                self._enqueue_when_full(queue, message)
            else:
                queue.put_nowait(message)

    @staticmethod
    def _enqueue_when_full(queue: ClientQueue, message: Message) -> None:
        """Make room without delaying or reordering remaining queued messages."""
        waiting = []
        while not queue.empty():
            waiting.append(queue.get_nowait())
            queue.task_done()
        oldest_frame = next(
            (index for index, item in enumerate(waiting) if item["type"] == "frame"), None
        )
        if oldest_frame is not None:
            del waiting[oldest_frame]
            waiting.append(message)
        elif message["type"] != "frame":
            waiting.pop(0)
            waiting.append(message)
        for item in waiting:
            queue.put_nowait(item)

    @staticmethod
    async def send(websocket: WebSocket, queue: ClientQueue) -> None:
        """Send messages using this client's single sender task."""
        while True:
            message = await queue.get()
            try:
                await websocket.send_json(message)
            finally:
                queue.task_done()
