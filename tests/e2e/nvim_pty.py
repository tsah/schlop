#!/usr/bin/env python3
"""CLI-launched Neovim PTY lifecycle smoke tests (Linux/macOS)."""
import hashlib
import json
import os
import pty
import select
import signal
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / "dist" / "schlop"


def run(args, key=b"q", piped=None, interrupt=False):
    read_fd = write_fd = None
    if piped is not None:
        read_fd, write_fd = os.pipe()
    pid, terminal = pty.fork()
    if pid == 0:
        if read_fd is not None:
            os.close(write_fd)
            os.dup2(read_fd, 0)
            os.close(read_fd)
        os.execv(str(BINARY), [str(BINARY), *args])
    if read_fd is not None:
        os.close(read_fd)
        os.write(write_fd, piped)
        os.close(write_fd)
    output = b""
    sent = False
    deadline = time.time() + 15
    status = None
    while time.time() < deadline:
        ready, _, _ = select.select([terminal], [], [], 0.1)
        if ready:
            try:
                output += os.read(terminal, 65536)
            except OSError:
                pass
        if not sent and (b"SCHLOP" in output or b"Schlop" in output):
            if interrupt:
                os.write(terminal, b"\x03")
            else:
                os.write(terminal, key)
            sent = True
        done, candidate = os.waitpid(pid, os.WNOHANG)
        if done:
            status = candidate
            break
    if status is None:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
        raise AssertionError("launched Neovim timed out\n" + output[-4000:].decode(errors="replace"))
    os.close(terminal)
    return os.waitstatus_to_exitcode(status), output


def main():
    if sys.platform not in ("linux", "darwin"):
        print("nvim PTY smoke skipped: unsupported platform")
        return
    with tempfile.TemporaryDirectory(prefix="schlop nvim ") as directory:
        root = Path(directory)
        config_home = root / "config"
        config_dir = config_home / "nvim"
        config_dir.mkdir(parents=True)
        config_marker = root / "user-config-loaded"
        (config_dir / "init.lua").write_text(
            "vim.fn.writefile({ 'loaded' }, " + json.dumps(str(config_marker)) + ")\n"
        )
        os.environ["XDG_CONFIG_HOME"] = str(config_home)
        source = root / "document with spaces.md"
        source.write_text("# Frozen\n\nDo not modify me.\n")
        before = source.read_bytes()
        cancelled = root / "cancelled.json"
        code, _ = run(["--ui", "nvim", "file", str(source), "--result-file", str(cancelled)])
        assert code == 20, code
        assert json.loads(cancelled.read_text())["outcome"] == "cancelled"
        assert config_marker.read_text().strip() == "loaded"
        assert source.read_bytes() == before

        submitted = root / "submitted.json"
        code, _ = run(["--ui", "nvim", "file", str(source), "--result-file", str(submitted)], key=b"s")
        assert code == 0, code
        assert json.loads(submitted.read_text())["outcome"] == "submitted"

        approved = root / "approved.json"
        code, _ = run(
            ["--ui", "nvim", "annotate", "--stdin", "--type", "markdown", "--result-file", str(approved)],
            key=b"S",
            piped=b"# Piped\n\nInteractive Neovim still owns the TTY.\n",
        )
        assert code == 0, code
        result = json.loads(approved.read_text())
        assert result["outcome"] == "approved"
        assert "formattedFeedback" not in result

        request_result = root / "request-result.json"
        request = root / "request.json"
        request.write_text(json.dumps({
            "schemaVersion": 1,
            "requestId": "pty-request",
            "surface": {
                "kind": "markdown",
                "title": "Request",
                "contentPath": str(source),
                "snapshotId": "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest(),
            },
            "source": {"label": "test-host"},
            "resultPath": str(request_result),
            "options": {"readOnly": True},
        }))
        code, _ = run(["--request", str(request)], key=b"S")
        assert code == 0, code
        request_value = json.loads(request_result.read_text())
        assert request_value["requestId"] == "pty-request"
        assert request_value["outcome"] == "approved"

        stale = root / "stale.json"
        stale.write_text(json.dumps({
            "schemaVersion": 1,
            "outcome": "submitted",
            "sessionId": "old",
            "surfaceSnapshotId": "sha256:" + "0" * 64,
            "annotations": [],
            "formattedFeedback": "stale",
        }))
        code, _ = run(["--ui", "nvim", "file", str(source), "--result-file", str(stale)], key=b":qa!\r")
        assert code == 1, code
        assert json.loads(stale.read_text())["outcome"] == "error"

        code, _ = run(["--ui", "nvim", "file", str(source)], interrupt=True)
        assert code == 130, code
        assert source.read_bytes() == before
    print("CLI-launched Neovim PTY smoke passed")


if __name__ == "__main__":
    main()
