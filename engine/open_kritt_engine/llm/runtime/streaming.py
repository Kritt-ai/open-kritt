from dataclasses import dataclass
from threading import Event
from typing import Literal

StreamEventKind = Literal["token", "stdout", "stderr", "metadata", "completed", "cancelled", "error"]


@dataclass(frozen=True)
class StreamEvent:
    kind: StreamEventKind
    text: str = ""
    data: dict | None = None


class CancellationToken:
    def __init__(self):
        self._event = Event()

    def cancel(self) -> None:
        self._event.set()

    def cancelled(self) -> bool:
        return self._event.is_set()

