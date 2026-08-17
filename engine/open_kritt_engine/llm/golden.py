import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class GoldenOutput:
    id: str
    provider: str
    output: str
    should_recover: bool


def load_golden_outputs(path: str | Path) -> tuple[GoldenOutput, ...]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return tuple(
        GoldenOutput(
            id=str(item["id"]),
            provider=str(item["provider"]),
            output=str(item["output"]),
            should_recover=bool(item["should_recover"]),
        )
        for item in raw
    )

