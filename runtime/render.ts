/**
 * Terminal rendering of the AI panel.
 *
 * Output is human-readable text on stdout — it carries no machine semantics
 * (the suggested command travels through --command-out instead), so the zsh
 * side never parses this.
 *
 * Every content line is prefixed with a dim bar so the panel cannot be mistaken
 * for command output; the terminal handles wrapping, so no layout maths here.
 */

const ESC = "\x1b[";
const BAR = "│ ";

export interface Renderer {
  /** One transient line (overwritten) used while waiting for first output. */
  status(text: string): void;
  /** Streamed natural-language output; opens the panel on first call. */
  text(delta: string): void;
  /** Dim one-line note (errors, "no suggestion"). */
  notice(text: string): void;
  /** `footer` is appended as the last dim line (model · latency). */
  suggestion(command: string, explanation: string): void;
  /** One barred instruction line (e.g. how to accept the suggestion). */
  hint(text: string): void;
  /** Barred dim line: model · latency. */
  footer(text: string): void;
  /** Closes the panel with the single bare blank line that separates it from the
   *  prompt.  Called once per invocation, after every notice/suggestion. */
  end(): void;
}

export function createRenderer(out: NodeJS.WriteStream = process.stdout): Renderer {
  const color =
    out.isTTY === true &&
    process.env.UNSTUCK_NO_COLOR !== "1" &&
    process.env.NO_COLOR !== "1" &&
    process.env.TERM !== "dumb";

  const dim = (s: string) => (color ? `${ESC}2m${s}${ESC}0m` : s);
  const bold = (s: string) => (color ? `${ESC}1m${s}${ESC}0m` : s);
  const cyan = (s: string) => (color ? `${ESC}1;36m${s}${ESC}0m` : s);

  let statusOpen = false;
  let lastStatus = "";
  let panelOpen = false;
  let lineOpen = false;
  let streamedText = false;
  let atLineStart = true;

  const write = (s: string) => void out.write(s);

  /**
   * Writes with the panel's left bar at every line start.
   *
   * Blank lines *inside* the panel get the bar too, otherwise the column breaks
   * wherever the model emits a paragraph break (user-reported).  The single gap
   * that ends the panel is written with a raw write() and stays bare.
   */
  const writeBarred = (text: string) => {
    if (text === "") return;
    let buffer = "";
    for (const char of text) {
      if (atLineStart) {
        atLineStart = false;
        buffer += char === "\n" ? dim("│") : dim(BAR);
      }
      buffer += char;
      if (char === "\n") atLineStart = true;
    }
    write(buffer);
  };

  const closeStatus = () => {
    if (!statusOpen) return;
    statusOpen = false;
    if (color) write(`\r${ESC}K`);
    else write("\n");
    atLineStart = true;
  };

  const openPanel = () => {
    if (panelOpen) return;
    panelOpen = true;
    lastStatus = "";
    // Always separate the panel from whatever is above it (shell output, the
    // failed command's error, or the intercepted line).
    write("\n");
    write(`${cyan("✦ Unstuck")}\n`);
    atLineStart = true;
  };

  return {
    status(text) {
      if (panelOpen || text === lastStatus) return;
      lastStatus = text;
      statusOpen = true;
      atLineStart = true;
      if (color) write(`\r${ESC}K${dim(BAR + text)}`);
      else write(`${text}\n`);
    },
    text(delta) {
      if (delta === "") return;
      closeStatus();
      openPanel();
      if (!streamedText) {
        // Models often open with blank lines; they carry no information and just
        // push the prose away from the header (user-reported).
        delta = delta.replace(/^[\r\n]+/, "");
        if (delta === "") return;
      }
      streamedText = true;
      lineOpen = !delta.endsWith("\n");
      writeBarred(delta);
    },
    notice(text) {
      closeStatus();
      if (lineOpen) {
        writeBarred("\n");
        lineOpen = false;
      }
      openPanel();
      writeBarred(`${text}\n`);
    },
    suggestion(command, explanation) {
      closeStatus();
      openPanel();
      if (lineOpen) {
        writeBarred("\n");
        lineOpen = false;
      }
      const lines = command.split("\n");
      writeBarred(`${cyan("→")} ${bold(lines[0] ?? "")}\n`);
      for (const line of lines.slice(1)) writeBarred(`  ${bold(line)}\n`);
      // The model usually explains itself in prose right above; repeating the
      // tool's one-liner there is noise. Keep it only as a fallback for
      // tool-call-only answers.
      if (explanation !== "" && !streamedText) writeBarred(`${dim(explanation)}\n`);
    },
    hint(text) {
      closeStatus();
      openPanel();
      if (lineOpen) {
        writeBarred("\n");
        lineOpen = false;
      }
      writeBarred(`${dim(text)}\n`);
    },
    footer(text) {
      closeStatus();
      openPanel();
      if (lineOpen) {
        writeBarred("\n");
        lineOpen = false;
      }
      writeBarred(`${dim(text)}\n`);
    },
    end() {
      if (!panelOpen) return;
      closeStatus();
      panelOpen = false;
      lineOpen = false;
      // The panel's only bare line: separates it from the prompt below.
      write("\n");
    },
  };
}
