// build produces the context envelope for a change: the manifest of changed
// files, the symbols inside them the diff touched, and the code around those
// symbols that a reviewer needs and the diff does not carry. Ports gorefactor's
// internal/changectx/changectx.go.
//
// Expansions leave here whole. The consumer cuts them against its own token
// ceiling, so trimming to a budget here would throw away context it may have
// had room for.

import { realpathSync } from "node:fs";

import { Builder, errorMessage, sortedUnique } from "./builder.ts";
import { classify } from "./classify.ts";
import { providerLanguage, providerName, schemaVersion, type Envelope, type File } from "./envelope.ts";
import { expand } from "./expand.ts";
import { changedFiles, mergeBase, repoRoot, type Change } from "./git.ts";
import { promptFragment } from "./prompt.ts";
import { resolveChanges } from "./resolve.ts";

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
    throw new Error(`locate the work tree at ${root}: ${errorMessage(err)}`);
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
    throw new Error(`resolve the merge base with ${opts.baseRef}: ${errorMessage(err)}`);
  }
  let changes: Change[];
  try {
    changes = changedFiles(repo, base);
  } catch (err) {
    throw new Error(`list the files changed since ${base}: ${errorMessage(err)}`);
  }

  const b = new Builder(repo, base);
  manifest(b, changes);
  resolveChanges(b, changes);
  expand(b);

  return {
    schemaVersion,
    provider: { name: providerName, version: opts.version, language: providerLanguage },
    baseSHA: base,
    files: b.files,
    expansions: b.exps,
    promptFragment,
    notes: sortedUnique(b.notes),
  };
}

// manifest classifies every changed path.
function manifest(b: Builder, changes: readonly Change[]): void {
  for (const c of changes) {
    const [cls, generated] = classify(b.repo, c);
    const f: File = { path: c.path, class: cls };
    if (generated) f.generated = true;
    b.files.push(f);
  }
}
