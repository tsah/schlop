#!/usr/bin/env python3
"""Packaged Schlop PTY smoke tests. Requires Linux/macOS and a built dist/schlop."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BIN = ROOT / "dist" / "schlop"
WORK = Path(tempfile.mkdtemp(prefix="schlop-e2e-"))
DATA = WORK / "data"
ENV = {**os.environ, "SCHLOP_DATA_DIR": str(DATA)}


def resize(fd: int, width: int, height: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))


def run(
    args: list[str],
    *,
    stdin: bytes | None = None,
    actions: list[tuple[float, bytes | tuple[int, int]]] | None = None,
    cwd: Path = ROOT,
    size: tuple[int, int] = (120, 32),
) -> tuple[int, bytes]:
    read_fd = write_fd = None
    if stdin is not None:
        read_fd, write_fd = os.pipe()
    pid, terminal_fd = pty.fork()
    if pid == 0:
        if stdin is not None:
            assert read_fd is not None and write_fd is not None
            os.dup2(read_fd, 0)
            os.close(read_fd)
            os.close(write_fd)
        os.chdir(cwd)
        os.execve(str(BIN), [str(BIN), *args], ENV)
    resize(terminal_fd, *size)
    if stdin is not None:
        assert read_fd is not None and write_fd is not None
        os.close(read_fd)
        os.write(write_fd, stdin)
        os.close(write_fd)
    output = bytearray()

    def drain(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([terminal_fd], [], [], 0.04)
            if ready:
                try:
                    output.extend(os.read(terminal_fd, 65536))
                except OSError:
                    return

    drain(0.8)
    for delay, action in actions or []:
        if isinstance(action, tuple):
            resize(terminal_fd, *action)
        else:
            os.write(terminal_fd, action)
        drain(delay)
    status = None
    deadline = time.time() + 6
    while time.time() < deadline:
        child, child_status = os.waitpid(pid, os.WNOHANG)
        if child:
            status = child_status
            break
        drain(0.08)
    if status is None:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
        raise AssertionError(f"Schlop did not exit: {' '.join(args)}")
    drain(0.1)
    return os.waitstatus_to_exitcode(status), bytes(output)


def assert_restored(output: bytes) -> None:
    assert b"\x1b[?1049l" in output, "alternate screen was not restored"


def main() -> None:
    assert BIN.exists(), "run bun run build first"
    source = b"# Plan\n\nFirst target\nSecond target\nThird target\n"
    markdown_result = WORK / "markdown-result.json"
    code, output = run(
        ["annotate", "--stdin", "--type", "markdown", "--result-file", str(markdown_result)],
        stdin=source,
        actions=[
            (0.08, b"jj"),
            (0.25, b"v"),
            (0.12, b"jj"),
            (0.4, b"c"),
            (0.08, b"First line"),
            (0.08, b"\r"),
            (0.08, b"Second line"),
            (0.5, b"\x13"),  # Ctrl-s saves the multiline annotation.
            (0.2, b"r"),
            (0.5, b"s"),
        ],
    )
    result = json.loads(markdown_result.read_text())
    assert code == 0 and result["outcome"] == "submitted"
    assert result["annotations"][0]["body"] == "First line\nSecond line"
    assert result["annotations"][0]["target"]["startLine"] == 3
    assert result["annotations"][0]["target"]["endLine"] == 5
    assert_restored(output)

    text_file = WORK / "plain.txt"
    text_file.write_text("one\ntwo\n", encoding="utf-8")
    cancel_result = WORK / "cancel-result.json"
    code, output = run(
        ["file", str(text_file), "--result-file", str(cancel_result)],
        actions=[(0.25, b"q"), (0.25, b"y")],
    )
    assert code == 20 and json.loads(cancel_result.read_text())["outcome"] == "cancelled"
    assert_restored(output)

    session_id = json.loads(cancel_result.read_text())["sessionId"]
    text_file.write_text("changed\n", encoding="utf-8")
    stale_result = WORK / "stale-result.json"
    code, output = run(
        ["resume", session_id, "--result-file", str(stale_result)],
        actions=[(0.25, b"q"), (0.25, b"y")],
    )
    assert code == 20 and b"STALE" in output
    assert_restored(output)

    resize_result = WORK / "resize-result.json"
    code, output = run(
        ["file", str(text_file), "--result-file", str(resize_result)],
        actions=[
            (0.4, (64, 24)),
            (0.4, (50, 12)),
            (0.15, b"q"),
            (0.2, b"y"),
        ],
    )
    assert code == 20 and b"[Files]" in output and b"Terminal too small" in output
    assert_restored(output)

    repo = WORK / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "qa@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "QA"], cwd=repo, check=True)
    tracked = repo / "tracked.txt"
    tracked.write_text("alpha\nbeta\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=repo, check=True)
    tracked.write_text("alpha\nbeta changed\n", encoding="utf-8")
    before = hashlib.sha256(tracked.read_bytes()).digest()
    code, output = run(["diff"], cwd=repo, actions=[(0.2, b"q"), (0.2, b"y")])
    assert code == 20 and b"@@ -1,2 +1,2 @@" in output
    assert b"NORMAL" in output and b"Annotations (0)" not in output
    assert b"\x1b[48;2;16;53;30m" in output  # full-row addition background
    assert b"\x1b[48;2;58;25;27m" in output  # full-row deletion background
    assert hashlib.sha256(tracked.read_bytes()).digest() == before
    assert_restored(output)

    print("PTY smoke: multiline annotation, finish, cancel, stale, resize, diff, safety, cleanup OK")


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(WORK, ignore_errors=True)
