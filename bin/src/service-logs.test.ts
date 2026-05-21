import { describe, expect, it } from "bun:test";
import { buildLogsCommand, parseLogsCliArgs, type LogsOptions } from "./service.ts";

const defaults: LogsOptions = { follow: true, lines: null, since: null };

describe("parseLogsCliArgs", () => {
  it("defaults to follow + no limit + no since", () => {
    const { options, errors } = parseLogsCliArgs([]);
    expect(errors).toEqual([]);
    expect(options).toEqual(defaults);
  });

  it("disables follow with --no-follow", () => {
    const { options } = parseLogsCliArgs(["--no-follow"]);
    expect(options.follow).toBe(false);
  });

  it("re-enables follow with --follow / -f after --no-follow", () => {
    expect(parseLogsCliArgs(["--no-follow", "-f"]).options.follow).toBe(true);
    expect(parseLogsCliArgs(["--no-follow", "--follow"]).options.follow).toBe(true);
  });

  it("parses -n N and --lines N", () => {
    expect(parseLogsCliArgs(["-n", "100"]).options.lines).toBe(100);
    expect(parseLogsCliArgs(["--lines", "5"]).options.lines).toBe(5);
  });

  it("flags non-numeric and negative -n values", () => {
    expect(parseLogsCliArgs(["-n", "abc"]).errors.length).toBe(1);
    expect(parseLogsCliArgs(["-n", "-1"]).errors.length).toBe(1);
  });

  it("captures --since with quoted relative timestamps", () => {
    const { options } = parseLogsCliArgs(["--since", "1 hour ago"]);
    expect(options.since).toBe("1 hour ago");
  });

  it("reports trailing flag with no value", () => {
    expect(parseLogsCliArgs(["-n"]).errors[0]).toContain("requires a numeric value");
    expect(parseLogsCliArgs(["--since"]).errors[0]).toContain("requires a value");
  });

  it("ignores unknown tokens (the dispatcher handles unknown subcommands)", () => {
    const { options, errors } = parseLogsCliArgs(["--bogus", "--no-follow"]);
    expect(errors).toEqual([]);
    expect(options.follow).toBe(false);
  });
});

describe("buildLogsCommand (linux/journalctl)", () => {
  it("builds the default follow command", () => {
    const cmd = buildLogsCommand("linux", "webmux-x", defaults, "");
    expect(cmd).toEqual({
      bin: "journalctl",
      args: ["--user", "-u", "webmux-x", "--no-pager", "-f"],
    });
  });

  it("drops -f when follow is false", () => {
    const cmd = buildLogsCommand("linux", "webmux-x", { ...defaults, follow: false }, "");
    expect(cmd.args).not.toContain("-f");
  });

  it("forwards -n N", () => {
    const cmd = buildLogsCommand("linux", "webmux-x", { ...defaults, lines: 500 }, "");
    expect(cmd.args).toContain("-n");
    expect(cmd.args).toContain("500");
  });

  it("forwards --since to journalctl as-is", () => {
    const cmd = buildLogsCommand("linux", "webmux-x", { ...defaults, since: "1 hour ago" }, "");
    const idx = cmd.args.indexOf("--since");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd.args[idx + 1]).toBe("1 hour ago");
  });
});

describe("buildLogsCommand (darwin/launchd)", () => {
  const logPath = "/Users/x/Library/Logs/webmux-x.log";

  it("uses cat for no-follow + no-limit (cheaper than tail -n +1)", () => {
    const cmd = buildLogsCommand("darwin", "webmux-x", { ...defaults, follow: false }, logPath);
    expect(cmd).toEqual({ bin: "cat", args: [logPath] });
  });

  it("uses tail -f for follow mode", () => {
    const cmd = buildLogsCommand("darwin", "webmux-x", defaults, logPath);
    expect(cmd.bin).toBe("tail");
    expect(cmd.args).toContain("-f");
    expect(cmd.args[cmd.args.length - 1]).toBe(logPath);
  });

  it("uses tail -n N for line-limit + follow", () => {
    const cmd = buildLogsCommand("darwin", "webmux-x", { ...defaults, lines: 200 }, logPath);
    expect(cmd.bin).toBe("tail");
    expect(cmd.args.slice(0, 3)).toEqual(["-n", "200", "-f"]);
  });

  it("uses tail -n N without -f when --no-follow", () => {
    const cmd = buildLogsCommand(
      "darwin",
      "webmux-x",
      { ...defaults, follow: false, lines: 200 },
      logPath,
    );
    expect(cmd.bin).toBe("tail");
    expect(cmd.args).not.toContain("-f");
    expect(cmd.args.slice(0, 2)).toEqual(["-n", "200"]);
  });

  it("warns when --since is set (tail has no time filter)", () => {
    const cmd = buildLogsCommand(
      "darwin",
      "webmux-x",
      { ...defaults, since: "1 hour ago" },
      logPath,
    );
    expect(cmd.warning).toBeDefined();
    expect(cmd.warning).toContain("macOS");
    // The filter is dropped silently from the argv — only the warning conveys it.
    expect(cmd.args).not.toContain("--since");
  });
});
