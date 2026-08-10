---
name: coding-standards
description: Correct-by-construction Python standards. Use for Python engineering or when another skill needs the user's coding standards.
---

These standards apply to all new and refactored Python code in this repository — the services, their tools, and shared scripts. Existing code stays unchanged until you refactor it; then the refactored behavior follows these standards.

## Core principles

- Prefer **errors as values** over raising for expected failures.
- **Parse, don't validate**: turn raw input (CSV rows, JSON, CLI args, env) into typed values at the boundary.
- Make **illegal states unrepresentable**: frozen dataclasses, `Enum`, `Literal`, tagged unions.
- Prefer **composition over inheritance**.
- Prefer **imperative shell / functional core**: pure computation in functions without I/O; file, network, GPU, and subprocess access in a thin shell around them.
- Type-hint every function signature. `ruff check` must pass.

## Errors and failures

Expected failures (missing file, malformed row, model not found, API error) appear in the return type:

```python
@dataclass(frozen=True)
class TaskNotFound:
    task_id: str

@dataclass(frozen=True)
class FramesMissing:
    task_id: str
    expected_dir: Path

def load_task_frames(task_id: str) -> list[Frame] | TaskNotFound | FramesMissing: ...
```

Callers branch with `match` or `isinstance` and handle each case. Raise only for defects: violated invariants, impossible branches, broken preconditions — use `raise AssertionError(...)` or a project error type, and let it crash loudly.

Never use bare `except:` or `except Exception: pass`. Catch the narrow exception at the boundary that can translate it into a value or a useful message.

## Parse, don't validate

Boundary code parses raw data into domain types before inner code sees it:

```python
@dataclass(frozen=True)
class LabeledFrame:
    frame_index: FrameIndex
    ball: BallPosition | None

def parse_labeled_frame(row: dict[str, str]) -> LabeledFrame | ParseError: ...
```

Inner code receives `LabeledFrame`, never `dict[str, str]`. Name parsers `parse_x`; name constructors from typed pieces `make_x`. A function named `validate_x` that returns a refined value is a parser — name it so.

## Domain types

- `NewType` for identifiers and units that must not be mixed: `TaskId`, `FrameIndex`, `Milliseconds`.
- `Enum` or `Literal` for closed sets of states; no stringly-typed state.
- Frozen dataclasses for values; mutation only inside localized shell code.
- No boolean parameters that switch behavior — use a `Literal` or an enum argument.
- Push `None` outward: branch or parse before calling, so inner functions take required values.

## Files and structure

- `pathlib.Path` everywhere; no string path concatenation.
- No module-level side effects: importing a module must not read env, load a model, open a file, or start a server. Put entrypoint work under `if __name__ == "__main__":` or a `main()` function.
- Configuration is parsed once at startup into a typed config object; no `os.environ[...]` scattered through the code.
- Precise module names (`stroke_detector.py`, `pose_normalizer.py`), no `utils.py` dumping grounds.

## Testing

Use `pytest`. Test through real seams: call the public function with real (small) data — a tiny CSV, a short frame sequence — and assert on returned values or written files. Avoid `unittest.mock.patch` of internal modules; inject dependencies (paths, clients, clocks) as parameters instead.
