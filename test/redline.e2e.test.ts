// End to end with the consumer: redline discovers tsrefactor from .redline.yml,
// runs it as a subprocess against the change, and keeps its envelope in the
// session. Skipped when redline is not installed, since it is a separate
// program this repository does not build.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import type { Envelope } from "../src/envelope.ts";
import { sanitizedGitEnv } from "../src/git.ts";
import { bugFixture, hookPath, pagePath } from "./bugFixture.ts";
import { cliPath, fixtureRepo, tempDir, writeFile } from "./helpers.ts";

const redlineInstalled = spawnSync("sh", ["-c", "command -v redline"], { encoding: "utf8" }).status === 0;

test(
  "redline runs tsrefactor as a context provider and keeps its envelope",
  { skip: redlineInstalled ? false : "redline is not on PATH" },
  (t) => {
    const dir = fixtureRepo(t, {
      ...bugFixture,
      ".redline.yml": `context:
  - name: tsrefactor
    command: tsrefactor
    args: ["context", "--changed", "{{base}}", "--json"]
    scope: ["app/**/*.ts", "app/**/*.tsx"]
`,
    });
    writeFile(
      dir,
      hookPath,
      readFileSync(join(dir, hookPath), "utf8").replace("keys: readonly string[][])", "keys: readonly string[][], exact = false)"),
    );

    // redline finds the provider on PATH; point it at this checkout's source.
    const bin = tempDir(t);
    writeFile(bin, "tsrefactor", `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`);
    chmodSync(join(bin, "tsrefactor"), 0o755);

    const env = sanitizedGitEnv();
    env["PATH"] = `${bin}${delimiter}${env["PATH"] ?? ""}`;
    const res = spawnSync(
      "redline",
      ["run", "--base", "HEAD", "--no-lint", "--no-open", "--file", "--session", "e2e"],
      { cwd: dir, env, encoding: "utf8", timeout: 240_000 },
    );
    assert.equal(res.status, 0, `redline run failed:\n${res.stdout}\n${res.stderr}`);

    const session = JSON.parse(readFileSync(join(dir, ".redline", "sessions", "e2e", "session.json"), "utf8")) as {
      envelopes?: Envelope[];
      unexamined?: string[];
    };
    const ours = session.envelopes?.find((e) => e.provider.name === "tsrefactor");
    assert.ok(ours, `no tsrefactor envelope in the session: ${JSON.stringify(session.envelopes?.map((e) => e.provider))}`);
    assert.ok(ours.promptFragment?.startsWith("Reviewing TypeScript."));
    assert.ok(
      ours.expansions?.some((x) => x.role === "caller" && x.file === pagePath && x.details?.["line"] === "7"),
      `the page's call through the barrel did not reach the session: ${JSON.stringify(ours.expansions, null, 2)}`,
    );
    assert.ok(!JSON.stringify(session).includes('"unexamined"'), "a TypeScript file was reported as unexamined");
  },
);
