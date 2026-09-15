// build produces the context envelope for a change: the manifest of changed
// files, the symbols inside them the diff touched, and the code around those
// symbols that a reviewer needs and the diff does not carry. Ports gorefactor's
// internal/changectx/changectx.go.
//
// Expansions leave here whole. The consumer cuts them against its own token
// ceiling, so trimming to a budget here would throw away context it may have
// had room for.

import { realpathSync } from "node:fs";

import { classify } from "./classify.ts";
import {
  compareStrings,
  providerLanguage,
  providerName,
  schemaVersion,
  type Envelope,
  type Expansion,
  type File,
} from "./envelope.ts";
import { changedFiles, mergeBase, repoRoot, type Change } from "./git.ts";

// Options selects the change to describe.
export interface Options {
  // root is any directory inside the work tree. The envelope reports paths
  // relative to the tree's top level.
  root?: string | undefined;
  // baseRef is the ref the change is measured against. Its merge base with
  // HEAD becomes the envelope's baseSHA.
  baseRef: string;
  // version is reported as the provider version.
  version: string;
}

// Builder carries the state of one build call. Every stage appends to it and
// nothing reads back, which is what keeps the output a function of the
// revision alone.
interface Builder {
  repo: string;
  base: string;
  files: File[];
  exps: Expansion[];
  notes: string[];
}

// build produces the envelope for the change between opts.baseRef's merge base
// and the working tree. Only three failures abort it — locating the work tree,
// resolving the merge base, listing the changed files — and every later stage
// degrades into notes instead.
export function build(opts: Options): Envelope {
  const root = opts.root || ".";
  let repo: string;
  try {
    repo = repoRoot(root);
  } catch (err) {
    throw new Error(`locate the work tree at ${root}: ${message(err)}`);
  }
  try {
    repo = realpathSync(repo);
  } catch {
    // keep git's answer
  }
  let base: string;
  try {
    base = mergeBase(repo, opts.baseRef);
  } catch (err) {
    throw new Error(`resolve the merge base with ${opts.baseRef}: ${message(err)}`);
  }
  let changes: Change[];
  try {
    changes = changedFiles(repo, base);
  } catch (err) {
    throw new Error(`list the files changed since ${base}: ${message(err)}`);
  }

  const b: Builder = { repo, base, files: [], exps: [], notes: [] };
  manifest(b, changes);

  const env: Envelope = {
    schemaVersion,
    provider: { name: providerName, version: opts.version, language: providerLanguage },
    baseSHA: base,
    files: b.files,
    expansions: b.exps,
    notes: sortedUnique(b.notes),
  };
  return env;
}

// manifest classifies every changed path.
function manifest(b: Builder, changes: Change[]): void {
  for (const c of changes) {
    const [cls, generated] = classify(b.repo, c);
    const f: File = { path: c.path, class: cls };
    if (generated) f.generated = true;
    b.files.push(f);
  }
}

// sortedUnique drops empty and repeated strings and sorts the rest, so two runs
// of the same revision report the same list in the same order.
export function sortedUnique(input: readonly string[]): string[] {
  return [...new Set(input.filter((s) => s !== ""))].sort(compareStrings);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
