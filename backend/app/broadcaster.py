"""WebSocket message fan-out."""

import asyncio
from collections import deque
from threading import Lock

from fastapi import WebSocket

Message = dict[str, object]
ClientQueue = asyncio.Queue[Message]
QUEUE_SIZE = 60
HANDOFF_SIZE = 120
MAX_CLIENTS = 32


class ClientLimitReached(RuntimeError):
    """All live WebSocket slots are in use."""


def _discard_for(waiting: deque[Message], message: Message) -> bool:
    """Make room for a new message while favoring control messages."""
    for index, queued in enumerate(waiting):
        if queued["type"] == "frame":
            del waiting[index]
            return True
    if message["type"] != "frame":
        waiting.popleft()
        return True
    return False


class Broadcaster:
    """Fan out messages on the event loop without waiting for clients."""

    def __init__(self) -> None:
        """Start with no connected clients."""
        self._clients: set[ClientQueue] = set()
        self._handoff: deque[Message] = deque(maxlen=HANDOFF_SIZE)
        self._handoff_lock = Lock()
        self._drain_scheduled = False

    def register(self) -> ClientQueue:
        """Allocate a bounded queue for a client on the event loop."""
        if len(self._clients) >= MAX_CLIENTS:
            raise ClientLimitReached
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

    def submit(self, loop: asyncio.AbstractEventLoop, message: Message) -> None:
        """Bridge producer threads with a bounded queue and a single pending callback."""
        with self._handoff_lock:
            if len(self._handoff) == HANDOFF_SIZE and not _discard_for(self._handoff, message):
                return
            self._handoff.append(message)
            if not self._drain_scheduled:
                self._drain_scheduled = True
                loop.call_soon_threadsafe(self._drain)

    def _drain(self) -> None:
        """Swap out the current batch and fan it out on the event loop."""
        with self._handoff_lock:
            batch = self._handoff
            self._handoff = deque(maxlen=HANDOFF_SIZE)
            self._drain_scheduled = False
        for message in batch:
            self.publish(message)

    def queue_sizes(self) -> tuple[int, list[int]]:
        """Report handoff and per-client queue lengths from the event loop."""
        with self._handoff_lock:
            pending = len(self._handoff)
        return pending, sorted(queue.qsize() for queue in self._clients)

    @staticmethod
    def _enqueue_when_full(queue: ClientQueue, message: Message) -> None:
        """Make room without delaying or reordering remaining queued messages."""
        waiting: deque[Message] = deque(maxlen=QUEUE_SIZE)
        while not queue.empty():
            waiting.append(queue.get_nowait())
            queue.task_done()
        if _discard_for(waiting, message):
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
