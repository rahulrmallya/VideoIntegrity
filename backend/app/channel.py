"""Packet forwarding and demo attack simulation."""

from collections.abc import Callable

from app.producer import Packet


class Channel:
    """Forward packets through an optional in-process transform."""

    def __init__(self, transform: Callable[[Packet], list[Packet]] | None = None) -> None:
        """Create a pass-through channel unless a transform is supplied."""
        self._transform = transform

    def process(self, packet: Packet) -> list[Packet]:
        """Forward the packet unchanged by default."""
        if self._transform is not None:
            return self._transform(packet)
        return [packet]
