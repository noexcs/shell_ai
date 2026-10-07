#!/usr/bin/env python3
"""End-to-end acceptance for unstuck, driven through real ptys.

Scenarios (see docs/specs/2026-10-03-unstuck-mvp-design.md §7):

  A1  normal commands behave like stock zsh and never call the LLM
  A2  command-not-found → panel + suggestion in the buffer, no duplicate S3 run
  A3  natural language → intercepted (never executed), suggestion, Enter runs it
  A4  non-zero exit → panel before the next prompt
  A5  the suggestion is not executed without Enter
  A6  secrets in the environment are redacted before anything is sent

They are independent (own pty, own zsh, own runtime process, own log file), so
they run in parallel by default; each LLM call is the only slow part.

  python3 test/e2e.py                 # all scenarios, 3 at a time
  python3 test/e2e.py --jobs 1        # strictly sequential (easier to debug)
  python3 test/e2e.py --only A2       # one scenario
  python3 test/e2e.py --skip A1 A5    # everything but these
  python3 test/e2e.py --verbose       # dump each cleaned transcript
"""

from __future__ import annotations

import argparse
import concurrent.futures
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SANDBOX = os.path.join(ROOT, "sandbox")
LOG_DIR = os.path.join(ROOT, ".unstuck-e2e")
PROMPT = "UNSTUCK> "
AI_TIMEOUT = 30.0
# A remote 27B endpoint occasionally needs ~60s; only the scenarios that
# spend several calls on one conversation need the longer ceiling.
SLOW_AI_TIMEOUT = 120.0


def bash_binary() -> str | None:
    """A bash >= 4 (macOS ships 3.2, which has no READLINE_LINE)."""
    candidates = [shutil.which("bash5"), "/opt/homebrew/bin/bash", "/usr/local/bin/bash", shutil.which("bash")]
    for candidate in candidates:
        if not candidate or not os.path.exists(candidate):
            continue
        probe = subprocess.run(
            [candidate, "-c", "echo ${BASH_VERSINFO[0]}"], capture_output=True, text=True
        )
        if probe.returncode == 0 and probe.stdout.strip().isdigit() and int(probe.stdout.strip()) >= 4:
            return candidate
    return None

ANSI_OSC = re.compile(r"\x1b\][^\x07]*\x07")


CSI_AT = re.compile(r"\x1b\[([0-9;?]*)([a-zA-Z])")


def render_stream(chunk: bytes) -> str:
    """Approximate what a terminal would display for a pty byte stream.

    Replaying the control characters is the whole point — zsh writes several
    things a naive strip gets wrong:
      * `\r\r\n` as its line ending (not a redraw),
      * bare `\r` redraws of the current line (cursor to column 0),
      * `\x08` when ZLE echoes a character it is about to rewrite,
      * cursor moves (`ESC[17D`, `ESC[16C`) when only part of the line changed.
        That is how a typed `? why …` becomes the `# why …` line that is
        actually submitted, and dropping the escapes leaves text the user never
        saw (`? why …#`).
    Columns are counted one per character, which is wrong for wide glyphs but
    harmless here: ZLE rewrites those lines from column 0.
    """
    lines = []
    for raw in ANSI_OSC.sub("", chunk.decode("utf-8", "replace")).split("\n"):
        columns: list[str] = []
        column = 0
        index = 0
        while index < len(raw):
            char = raw[index]
            if char == "\x1b":
                match = CSI_AT.match(raw, index)
                if match is None:
                    index += 1
                    continue
                count, final = match.group(1), match.group(2)
                step = int(count) if count.isdigit() else 1
                if final == "D":
                    column = max(0, column - step)
                elif final == "C":
                    column += step
                index = match.end()
                continue
            if char == "\r":
                column = 0
                index += 1
                continue
            if char == "\x08":
                column = max(0, column - 1)
                index += 1
                continue
            while len(columns) < column:
                columns.append(" ")
            if column < len(columns):
                columns[column] = char
            else:
                columns.append(char)
            column += 1
            index += 1
        lines.append("".join(columns))
    return "\n".join(lines)


class TimeoutError_(Exception):
    pass


class ShellSession:
    """A zsh in its own pty, synchronized on the sandbox prompt token."""

    def __init__(self, log_path: str, shell: str = "zsh") -> None:
        self.shell = shell
        self.log_path = log_path
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "w"):
            pass
        self.raw = bytearray()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child
            os.environ.update(
                TERM="xterm-256color",
                LANG="en_US.UTF-8",
                LC_ALL="en_US.UTF-8",
                UNSTUCK_LOG="1",
                UNSTUCK_LOG_FILE=log_path,
                # Exercises the distributed layout: the plugin uses this binary
                # instead of `node runtime/main.ts`.
                UNSTUCK_BIN=os.environ.get("UNSTUCK_BIN", ""),
            )
            if shell == "bash":
                os.environ.pop("ZDOTDIR", None)
                binary = bash_binary() or "bash"
                os.execvp(binary, [binary, "--rcfile", os.path.join(SANDBOX, ".bashrc"), "-i"])
            else:
                os.environ["ZDOTDIR"] = SANDBOX
                os.execvp("zsh", ["zsh", "-i"])
        self.wait_for(re.escape(PROMPT), 20.0)

    def prompt_count(self) -> int:
        return len(re.findall(re.escape(PROMPT), self.text()))

    def wait_next_prompt(self, timeout: float = AI_TIMEOUT) -> None:
        """Block until the shell draws a *new* prompt — i.e. it is idle again.

        Reading the buffer without this races the AI call: text from the failed
        command can land on the same rendered line as the prompt.
        """
        before = self.prompt_count()
        deadline = time.monotonic() + timeout
        while self.prompt_count() <= before and time.monotonic() < deadline:
            self._pump(0.2)

    def accept(self) -> None:
        """Deliver a pending suggestion.

        zsh pre-fills the next buffer by itself; bash cannot, so the adapter arms
        a one-shot Enter handler and the Enter that would have been a no-op on an
        empty line accepts the suggestion instead.

        The keystroke must arrive *after* the shell is back at a prompt: one sent
        while the AI call is still running is consumed by the tty before readline
        arms the handler (measured).
        """
        self.wait_next_prompt()
        if self.shell != "bash":
            return
        self.send("\r")
        self._pump(2.5)

    def _pump(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.raw.extend(chunk)

    def text(self) -> str:
        return render_stream(bytes(self.raw))

    def mark(self) -> int:
        return len(self.raw)

    def since(self, mark: int) -> str:
        return render_stream(bytes(self.raw[mark:]))

    def send(self, data: str) -> None:
        os.write(self.fd, data.encode())

    def wait_for(self, pattern: str, timeout: float, mark: int = 0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if re.search(pattern, self.since(mark)):
                return True
            self._pump(0.15)
        return False

    def wait_prompt(self, timeout: float = AI_TIMEOUT, mark: int = 0) -> None:
        if not self.wait_for(re.escape(PROMPT), timeout, mark):
            raise TimeoutError_(f"prompt not seen within {timeout}s")

    def settle(self, mark: int) -> None:
        """Wait for the *next* prompt, then a beat."""
        self.wait_prompt(AI_TIMEOUT, mark)
        self._pump(0.4)

    def wait_buffer(self, predicate, timeout: float = AI_TIMEOUT) -> str:
        """Poll until the ZLE buffer satisfies `predicate`; return it either way.

        Waiting for *a* prompt is not enough: `zle -I` makes ZLE redraw the prompt
        with the old buffer, so that signal can fire before the suggestion lands.
        Predicates must therefore exclude the previously typed command — "buffer
        is non-empty" is satisfied by that stale redraw.
        """
        deadline = time.monotonic() + timeout
        while True:
            current = self.buffer()
            if predicate(current):
                return current
            if time.monotonic() > deadline:
                return current
            self._pump(0.15)

    def buffer(self) -> str:
        """Text currently sitting in ZLE's buffer (what follows the prompt token)."""
        matches = re.findall(re.escape(PROMPT) + r"([^\n]*)", self.text())
        if not matches:
            return ""
        return matches[-1].rsplit(PROMPT, 1)[-1].strip()

    def log(self) -> str:
        try:
            with open(self.log_path) as handle:
                return handle.read()
        except FileNotFoundError:
            return ""

    def close(self) -> None:
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


class Scenario:
    """Collects the checks of one scenario so a failure never hides the rest."""

    def __init__(self, name: str, description: str) -> None:
        self.name = name
        self.description = description
        self.checks: list[tuple[str, bool]] = []
        self.transcript = ""
        self.log_text = ""

    def check(self, label: str, ok: object) -> None:
        self.checks.append((label, bool(ok)))

    @property
    def passed(self) -> bool:
        return bool(self.checks) and all(ok for _, ok in self.checks)


def run_scenario(name: str, description: str, body, log_path: str, shell: str) -> Scenario:
    scenario = Scenario(name, description)
    session = ShellSession(log_path, shell)
    mark = session.mark()
    try:
        body(scenario, session, mark)
    except Exception as error:  # a broken scenario must not stop the suite
        scenario.check(f"scenario completed ({type(error).__name__}: {error})", False)
    finally:
        scenario.transcript = session.since(mark)
        scenario.log_text = session.log()
        session.close()
    return scenario


# --------------------------------------------------------------------------- A1

def scenario_a1(scenario: Scenario, session: ShellSession, mark: int) -> None:
    for command in ["echo hi", "ls | head -1", "alias", "cd /tmp"]:
        session.send(command + "\r")
        session._pump(0.7)
    text = session.since(mark)
    scenario.check("echo produced output", "hi" in text)
    scenario.check("no AI panel", "✦ Unstuck" not in text)
    scenario.check("log stayed empty", session.log().strip() == "")


# --------------------------------------------------------------------------- A2

def scenario_a2(scenario: Scenario, session: ShellSession, mark: int) -> None:
    session.send("dockre ps\r")
    scenario.check("panel appeared", session.wait_for("✦ Unstuck", AI_TIMEOUT, mark))
    session.wait_next_prompt()
    session.accept()
    buffer = session.wait_buffer(lambda value: value.startswith("docker"))
    text = session.since(mark)
    scenario.check("shell error kept", "command not found" in text and "dockre" in text)
    scenario.check("buffer got the suggestion", buffer.startswith("docker"))
    log = session.log()
    scenario.check("one command_not_found call", log.count("trigger=command_not_found") == 1)
    scenario.check("S3 did not run again", "trigger=non_zero_exit" not in log)
    if session.shell == "bash":
        scenario.check("accept hint is a panel line", "│ 按 Enter 填入建议" in text)
    else:
        scenario.check("no accept hint when the shell prefills", "按 Enter 填入建议" not in text)


# --------------------------------------------------------------------------- A3

def scenario_a3(scenario: Scenario, session: ShellSession, mark: int) -> None:
    phrase = "帮我找出当前目录最大的10个文件"
    session.send(phrase + "\r")
    scenario.check("panel appeared", session.wait_for("✦ Unstuck", AI_TIMEOUT, mark))
    session.wait_next_prompt()
    session.accept()
    suggestion = session.wait_buffer(
        lambda value: value != "" and shutil.which(value.split()[0]) is not None
    )
    text = session.since(mark)
    if session.shell == "zsh":
        scenario.check("phrase was not executed as a command", f"command not found: {phrase[:2]}" not in text)
    else:
        # bash has no pre-execution hook: the line runs, but the command-not-found
        # handler recognises a question and answers it as one — the shell's own
        # "command not found" line is suppressed so the UX matches zsh.
        scenario.check("bash answered it as a question", "command not found" not in text)
        scenario.check("logged as a natural-language question", "trigger=nl" in session.log())
    scenario.check(
        "suggestion's first word is a real command",
        suggestion != "" and shutil.which(suggestion.split()[0]) is not None,
    )

    # The other half of the promise: without Enter nothing runs, with Enter it does.
    # NB: if the suggested command itself exits non-zero, S3 legitimately fires a
    # second AI call — so assert "no repeat interception", not "log unchanged".
    pending_log = session.log()
    enter_mark = session.mark()
    session.send("\r")
    session.settle(enter_mark)
    after = session.since(enter_mark)
    scenario.check("Enter produced observable output", after.strip() != "")
    scenario.check(
        "no repeat natural-language interception",
        session.log().count("trigger=nl") == pending_log.count("trigger=nl"),
    )
    scenario.check("injected command left the buffer", session.buffer() != suggestion)


# --------------------------------------------------------------------------- A4

def scenario_a4(scenario: Scenario, session: ShellSession, mark: int) -> None:
    session.send("ls -Z\r")
    scenario.check("panel appeared", session.wait_for("✦ Unstuck", AI_TIMEOUT, mark))
    session.wait_next_prompt()
    session.accept()
    buffer = session.wait_buffer(lambda value: value not in ("", "ls -Z"))
    text = session.since(mark)
    scenario.check("ls error kept", "illegal option" in text or "invalid option" in text)
    scenario.check("buffer non-empty", buffer != "")
    scenario.check("one non_zero_exit call", session.log().count("trigger=non_zero_exit") == 1)


# --------------------------------------------------------------------------- A5

def scenario_a5(scenario: Scenario, session: ShellSession, mark: int) -> None:
    session.send("dockre ps\r")
    scenario.check("panel appeared", session.wait_for("✦ Unstuck", AI_TIMEOUT, mark))
    session.wait_next_prompt()
    session.accept()
    session.wait_buffer(lambda value: value.startswith("docker"))
    session.send("\x03")  # Ctrl+C instead of Enter
    cleared = session.wait_buffer(lambda value: value == "")
    text = session.since(mark)
    call_log = session.log()
    scenario.check("nothing was executed", "command not found: docker" not in text)
    scenario.check("buffer discarded", cleared == "")
    scenario.check("only the CNF call happened", call_log.count("trigger=") == 1)


# --------------------------------------------------------------------------- A6

def scenario_a6(scenario: Scenario, session: ShellSession, mark: int) -> None:
    """The context builder must not ship credential-shaped values to the provider."""
    real_secret = os.environ.get("DEEPSEEK_API_KEY", "")
    session.send("_unstuck_context nl x x 0 | ${UNSTUCK_CMD[@]} debug --print-context\r")
    session._pump(4.0)
    text = session.since(mark)
    dump = [line.strip() for line in text.splitlines()]
    masked_lines = [line for line in dump if line.endswith("=[redacted]")]
    scenario.check("at least one env var was masked", len(masked_lines) > 0)
    scenario.check("redaction is reported to the user", "已脱敏" in text)
    scenario.check(
        "non-secret env survives",
        any("=" in line and not line.endswith("=[redacted]") for line in dump),
    )
    if real_secret != "":
        scenario.check("the provider key value never appears", real_secret not in text)


# --------------------------------------------------------------------------- A7

def scenario_a7(scenario: Scenario, session: ShellSession, mark: int) -> None:
    """Questions stay in the prompt line and never run as commands.

    zsh cannot keep a buffer on screen *and* hand it to the prompt hook, so an
    intercepted question is re-submitted as `# <question>`: zsh echoes the line,
    it lands in history, and it executes as a no-op.  `#` and `?` are also the
    explicit triggers — which is what makes an English question possible at all,
    since the heuristic only recognises non-ASCII input.
    """
    if session.shell != "zsh":
        scenario.check("bash has no pre-execution hook (see A3)", True)
        return

    def ask(text: str) -> tuple[str, str]:
        """Send one question and wait for the answer.

        Waiting for a prompt is not enough: the question line redraws the prompt
        token itself.  The latency footer is what marks the panel as finished.
        The prompt that follows pre-fills the suggestion, so it is dropped again
        before the next send — otherwise the next line is typed into it.
        """
        before = session.mark()
        session.send(text + "\r")
        panel = session.wait_for("✦ Unstuck", SLOW_AI_TIMEOUT, before)
        answered = session.wait_for(r"·\s*\d+\.\d+s", SLOW_AI_TIMEOUT, before)
        session._pump(0.6)
        out = session.since(before)
        scenario.check(f"`{text[:12]}` was answered", answered)
        session.send("\x03")
        session._pump(0.6)
        return panel, out

    phrase = "帮我找出当前目录最大的10个文件"
    panel, text = ask(phrase)
    scenario.check("heuristic question got a panel", panel)
    scenario.check("heuristic question was not executed", "command not found" not in text)
    scenario.check("heuristic question kept as a comment line", f"# {phrase}" in text)

    explicit = "why did the last command fail"
    for prefix in ["#", "?"]:
        panel, text = ask(f"{prefix} {explicit}")
        scenario.check(f"`{prefix}` question got a panel", panel)
        scenario.check(f"`{prefix}` question was not executed", "command not found" not in text)
        scenario.check(f"`{prefix}` question kept as a comment line", f"# {explicit}" in text)

    scenario.check("all three questions logged as nl", session.log().count("trigger=nl") == 3)

    recall = session.mark()
    session.send("fc -ln -8\r")
    session._pump(1.5)
    recalled = session.since(recall)
    scenario.check("questions are recallable from history", f"# {phrase}" in recalled
                   and f"# {explicit}" in recalled)

    dump = session.mark()
    session.send("_unstuck_context nl x x 0 | ${UNSTUCK_CMD[@]} debug --print-context\r")
    session._pump(6.0)
    context = session.since(dump)
    history_section = context.split("最近命令历史", 1)[-1].split("\n##", 1)[0]
    scenario.check(
        "questions stay out of the model's history",
        f"# {phrase}" not in history_section and f"# {explicit}" not in history_section,
    )


SCENARIOS = {
    "A1": ("normal commands stay stock and never call the LLM", scenario_a1),
    "A2": ("command not found → panel + suggestion", scenario_a2),
    "A3": ("natural language → intercepted, suggestion runs only on Enter", scenario_a3),
    "A4": ("non-zero exit → panel before the next prompt", scenario_a4),
    "A5": ("no execution without Enter", scenario_a5),
    "A6": ("BYOK hygiene: secrets in the environment never leave the machine", scenario_a6),
    "A7": ("questions stay visible, become history, never run", scenario_a7),
}


def report(scenario: Scenario, verbose: bool) -> None:
    status = "PASS" if scenario.passed else "FAIL"
    print(f"{status} {scenario.name} — {scenario.description}")
    for label, ok in scenario.checks:
        if not ok:
            print(f"       ✗ {label}")
    if verbose:
        print(f"----- {scenario.name} transcript -----")
        print(scenario.transcript[-4000:])
    elif not scenario.passed:
        print("       --- transcript tail ---")
        for line in scenario.transcript[-1200:].splitlines()[-20:]:
            print(f"       | {line}")
        log = scenario.log_text.strip()
        print(f"       --- log: {log if log != '' else '(空)'}")


def main() -> int:
    parser = argparse.ArgumentParser(description="unstuck pty acceptance suite")
    parser.add_argument("--only", nargs="+", choices=sorted(SCENARIOS), default=None)
    parser.add_argument("--skip", nargs="+", choices=sorted(SCENARIOS), default=[])
    parser.add_argument("--jobs", type=int, default=3, help="scenarios to run at once (default 3)")
    parser.add_argument("--shell", choices=["zsh", "bash"], default="zsh", help="which shell to test")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.only and args.skip:
        print("FAIL: use either --only or --skip, not both")
        return 1
    if args.shell == "bash" and bash_binary() is None:
        print("FAIL: 需要 bash >= 4（macOS 自带 3.2）：brew install bash")
        return 1

    selected = args.only or sorted(SCENARIOS)
    selected = [name for name in selected if name not in args.skip]
    os.makedirs(LOG_DIR, exist_ok=True)

    results: list[Scenario | None] = [None] * len(selected)
    jobs = max(1, min(args.jobs, len(selected)))
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {
            pool.submit(
                run_scenario,
                name,
                SCENARIOS[name][0],
                SCENARIOS[name][1],
                os.path.join(LOG_DIR, f"log-{args.shell}-{name}"),
                args.shell,
            ): index
            for index, name in enumerate(selected)
        }
        for future in concurrent.futures.as_completed(futures):
            results[futures[future]] = future.result()

    for scenario in results:
        if scenario is not None:
            report(scenario, args.verbose)

    failed = [scenario.name for scenario in results if scenario is not None and not scenario.passed]
    print(
        f"\n[{args.shell}] {len(selected) - len(failed)}/{len(selected)} scenarios passed"
        f" in {time.monotonic() - started:.1f}s ({jobs} at a time)"
        + (f" (failed: {', '.join(failed)})" if failed else "")
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
