#!/usr/bin/env node
// The tsrefactor command. Ports gorefactor's cmd/gorefactor/cmd_context_changed.go:
// `context --changed <ref>` writes the context envelope for a whole change.
//
// Redline runs this with cwd set to the tree under review and shows stderr
// verbatim on failure, so the first line of stderr is always the diagnosis.

import { readFileSync } from "node:fs";

import { build } from "./build.ts";
import { encodeEnvelope } from "./envelope.ts";
import { summary } from "./summary.ts";

const exitOK = 0;
const exitUsage = 1;
const exitFailure = 1;

const usage =
  "usage: tsrefactor context --changed <ref> [--in <path>] [--json] [--history-revisions <n>] [--history-spans <n>]";

class UsageError extends Error {}

interface ContextArgs {
  changed: string | undefined;
  root: string | undefined;
  budget: string | undefined;
  historyRevisions: string | undefined;
  historySpans: string | undefined;
  json: boolean;
  positional: string[];
}

const valueFlags = new Set(["--changed", "--in", "--budget", "--history-revisions", "--history-spans"]);
const boolFlags = new Set(["--json"]);

function parseContextArgs(args: string[]): ContextArgs {
  const out: ContextArgs = {
    changed: undefined,
    root: undefined,
    budget: undefined,
    historyRevisions: undefined,
    historySpans: undefined,
    json: false,
    positional: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      out.positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (boolFlags.has(name)) {
      if (eq !== -1) {
        throw new UsageError(`${name} takes no value`);
      }
      out.json = true;
      continue;
    }
    if (!valueFlags.has(name)) {
      throw new UsageError(`unknown flag ${name}`);
    }
    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (i + 1 < args.length) {
      value = args[++i]!;
    } else {
      throw new UsageError(`${name} needs a value`);
    }
    switch (name) {
      case "--changed":
        out.changed = value;
        break;
      case "--in":
        out.root = value;
        break;
      case "--history-revisions":
        out.historyRevisions = value;
        break;
      case "--history-spans":
        out.historySpans = value;
        break;
      default:
        out.budget = value;
    }
  }
  return out;
}

// contextCommand serves `context --changed <ref>`. There is no per-symbol mode:
// this provider only describes whole changes.
function contextCommand(args: string[]): string {
  const a = parseContextArgs(args);
  if (a.changed === undefined || a.changed === "") {
    throw new UsageError("context needs --changed <ref>");
  }
  if (a.positional.length > 0) {
    throw new UsageError(`context --changed takes no symbol argument (got "${a.positional[0]}")`);
  }
  if (a.budget !== undefined) {
    throw new UsageError("--budget does not apply to --changed; expansions are emitted whole for the consumer to rank");
  }
  const env = build({
    root: a.root,
    baseRef: a.changed,
    version: version(),
    historyRevisions: positiveFlag("--history-revisions", a.historyRevisions),
    historyRangesPerFile: positiveFlag("--history-spans", a.historySpans),
  });
  return a.json ? encodeEnvelope(env) : summary(env);
}

// positiveFlag reads a count flag. Unset stays undefined, which build reads as
// its own default; zero or negative is refused rather than silently emptying a
// role.
function positiveFlag(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new UsageError(`${name} takes a whole number (got "${raw}")`);
  }
  if (n < 1) {
    throw new UsageError(`${name} must be at least 1 (got ${String(n)}); omit it for the default`);
  }
  return n;
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return pkg.version ?? "";
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "version" || cmd === "--version" || cmd === "-version") {
    process.stdout.write(version() + "\n");
    return exitOK;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage + "\n");
    return exitOK;
  }
  if (cmd === undefined) {
    process.stderr.write(usage + "\n");
    return exitUsage;
  }
  if (cmd !== "context") {
    process.stderr.write(`unknown command: ${cmd}\n${usage}\n`);
    return exitUsage;
  }
  try {
    process.stdout.write(contextCommand(rest));
    return exitOK;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${usage}\n`);
      return exitUsage;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return exitFailure;
  }
}

// exitCode rather than exit(): stdout may be a pipe, and exiting outright can
// cut a large envelope off before it is flushed.
process.exitCode = main(process.argv.slice(2));
