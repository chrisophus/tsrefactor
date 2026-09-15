// The single ts-morph project load. Ports loadModule and index.unit from
// gorefactor's internal/changectx/resolve.go.
//
// Nothing here assumes where a repository keeps its TypeScript. The nearest
// tsconfig.json is found by walking up from each changed file to the top of the
// work tree, and a solution-style config (files: [] plus references) is
// followed to the configs that own the sources. The compiler is the one ts-morph
// bundles, never the target repository's, so a tree with no node_modules still
// loads: imports it cannot resolve become type-check notes, not a failure.

import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { Project, ts } from "ts-morph";

import { compareStrings } from "./envelope.ts";

// typeCheckNotesCap bounds how many diagnostics reach notes[]: enough to say
// what is wrong, not so many that a broken tree buries the envelope.
const typeCheckNotesCap = 5;

// defaultCompilerOptions stand in when no tsconfig.json covers the change.
// They are permissive about module shape so a stray file still binds.
const defaultCompilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  skipLibCheck: true,
};

export interface LoadedProject {
  project: Project;
  notes: string[];
}

// loadProject type-checks the TypeScript the changed files belong to. Problems
// come back as notes: a provider that fails entirely because one config is
// broken is useless on exactly the changes people most want reviewed.
export function loadProject(repo: string, changedAbs: readonly string[]): LoadedProject {
  const notes: string[] = [];
  const configs = discoverConfigs(repo, changedAbs);
  const leaves = new Map<string, ts.ParsedCommandLine>();
  for (const config of configs) {
    collectLeaves(repo, config, leaves, notes, new Set());
  }

  let options = defaultCompilerOptions;
  const files: string[] = [];
  if (leaves.size === 0) {
    notes.push(
      configs.length === 0
        ? "no tsconfig.json found above the changed TypeScript files; they were loaded with default compiler options"
        : "no usable tsconfig.json covers the changed TypeScript files; they were loaded with default compiler options",
    );
  } else {
    const ordered = [...leaves].sort(([a], [b]) => compareStrings(a, b));
    options = pickOptions(ordered, changedAbs);
    for (const [, parsed] of ordered) {
      files.push(...parsed.fileNames);
    }
  }

  const project = new Project({
    compilerOptions: options,
    skipAddingFilesFromTsConfig: true,
  });
  for (const f of [...new Set(files)].sort(compareStrings)) {
    project.addSourceFileAtPathIfExists(f);
  }
  for (const f of changedAbs) {
    if (!project.getSourceFile(f)) {
      project.addSourceFileAtPathIfExists(f);
    }
  }
  project.resolveSourceFileDependencies();
  notes.push(...typeCheckNotes(project, repo, changedAbs));
  return { project, notes };
}

// discoverConfigs returns the nearest tsconfig.json above each changed file,
// never looking outside the work tree.
function discoverConfigs(repo: string, changedAbs: readonly string[]): string[] {
  const found = new Set<string>();
  for (const abs of changedAbs) {
    let dir = dirname(abs);
    while (dir === repo || dir.startsWith(repo + sep)) {
      const candidate = join(dir, "tsconfig.json");
      if (existsSync(candidate)) {
        found.add(candidate);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return [...found].sort(compareStrings);
}

// collectLeaves parses a config and, when it only aggregates references,
// descends into them. A leaf is a config that owns source files.
function collectLeaves(
  repo: string,
  configPath: string,
  leaves: Map<string, ts.ParsedCommandLine>,
  notes: string[],
  stack: Set<string>,
): void {
  if (stack.has(configPath) || leaves.has(configPath)) {
    return;
  }
  stack.add(configPath);
  const rel = toRel(repo, configPath);
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory.bind(ts.sys),
    fileExists: ts.sys.fileExists.bind(ts.sys),
    readFile: ts.sys.readFile.bind(ts.sys),
    getCurrentDirectory: ts.sys.getCurrentDirectory.bind(ts.sys),
    onUnRecoverableConfigFileDiagnostic: (d) => notes.push(`tsconfig ${rel}: ${flatten(d)}`),
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
  if (!parsed) {
    return;
  }
  const refs = parsed.projectReferences ?? [];
  for (const e of parsed.errors) {
    // "No inputs were found" is the normal state of a solution-style config.
    if (e.code === 18_003 && refs.length > 0) {
      continue;
    }
    notes.push(`tsconfig ${rel}: ${flatten(e)}`);
  }
  if (parsed.fileNames.length === 0 && refs.length > 0) {
    for (const ref of refs) {
      collectLeaves(repo, ts.resolveProjectReferencePath(ref), leaves, notes, stack);
    }
    return;
  }
  leaves.set(configPath, parsed);
}

// pickOptions takes the compiler options of the config that owns the most
// changed files, so the change is checked the way its own build checks it.
function pickOptions(ordered: [string, ts.ParsedCommandLine][], changedAbs: readonly string[]): ts.CompilerOptions {
  const changed = new Set(changedAbs.map(normalize));
  let best = ordered[0]![1];
  let bestCount = -1;
  for (const [, parsed] of ordered) {
    const count = parsed.fileNames.filter((f) => changed.has(normalize(f))).length;
    if (count > bestCount) {
      best = parsed;
      bestCount = count;
    }
  }
  return best.options;
}

// typeCheckNotes reports errors in the changed files, plus configuration and
// global errors, capped. Errors elsewhere in the project are not the change's,
// and checking every file would cost the whole program on every run.
function typeCheckNotes(project: Project, repo: string, changedAbs: readonly string[]): string[] {
  const program = project.getProgram().compilerObject;
  const diags: ts.Diagnostic[] = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  for (const abs of [...changedAbs].sort(compareStrings)) {
    const sf = program.getSourceFile(abs);
    if (sf) {
      diags.push(...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf));
    }
  }
  const nodeModuleMode = isNodeModuleKind(program.getCompilerOptions().module);
  const formatBlind = new Set<string>();
  const errors: string[] = [];
  for (const d of diags) {
    if (d.category !== ts.DiagnosticCategory.Error) {
      continue;
    }
    const text = formatDiagnostic(repo, d);
    if (nodeModuleMode && formatBlindCodes.has(d.code) && d.file?.impliedNodeFormat === undefined) {
      formatBlind.add(text);
      continue;
    }
    errors.push(text);
  }
  const messages = [...new Set(errors)].sort(compareStrings);

  const out: string[] = [];
  if (messages.length > 0) {
    out.push(
      `${messages.length} type-check error(s) in the changed files; symbols they name may not resolve`,
      ...messages.slice(0, typeCheckNotesCap).map((m) => `type-check: ${m}`),
      ...(messages.length > typeCheckNotesCap
        ? [`type-check: ${messages.length - typeCheckNotesCap} further error(s) not listed (cap ${typeCheckNotesCap})`]
        : []),
    );
  }
  if (formatBlind.size > 0) {
    out.push(
      `${formatBlind.size} ESM/CommonJS diagnostic(s) were dropped: the loader does not know each file's module format under node16/nodenext, so imports that depend on package.json "type" or "exports" conditions may resolve imperfectly`,
    );
  }
  return out;
}

// formatBlindCodes are diagnostics that turn only on whether a file is ESM or
// CommonJS: import.meta outside ESM (1470) and CommonJS importing ESM (1479).
// ts-morph creates source files without the module format TypeScript infers
// from package.json, so under node16/nodenext every file reads as CommonJS and
// these fire on code that is correct.
const formatBlindCodes: ReadonlySet<number> = new Set([1470, 1479]);

function isNodeModuleKind(kind: ts.ModuleKind | undefined): boolean {
  return kind !== undefined && kind >= ts.ModuleKind.Node16 && kind <= ts.ModuleKind.NodeNext;
}

function formatDiagnostic(repo: string, d: ts.Diagnostic): string {
  const text = `TS${d.code}: ${flatten(d)}`;
  if (!d.file || d.start === undefined) {
    return text;
  }
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  return `${toRel(repo, d.file.fileName)}:${line + 1}:${character + 1}: ${text}`;
}

// flatten renders a diagnostic's message on one line; a note is one line.
function flatten(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, " ").replaceAll(/\s+/g, " ").trim();
}

function toRel(repo: string, abs: string): string {
  const rel = relative(repo, abs);
  return rel.startsWith("..") ? abs : rel.split(sep).join("/");
}

function normalize(p: string): string {
  return p.split(sep).join("/");
}
