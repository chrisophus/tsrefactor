// The context envelope: the wire contract between redline and a language
// provider. Redline owns the schema and the role vocabulary; this file is the
// TypeScript port of gorefactor's internal/changectx/envelope.go, checked
// against redline's internal/envelope/envelope.go.
//
// Symbol and scope are opaque strings on the far side. Anything that only makes
// sense for TypeScript goes in details, which redline renders generically.

// schemaVersion is the version of the wire format this package writes. The
// consumer refuses a version it does not know rather than reading fields that
// may have moved.
export const schemaVersion = 1;

export const providerName = "tsrefactor";
export const providerLanguage = "typescript";

// roles is the closed vocabulary, in the order the consumer ranks it. Inventing
// a role here would rank it last on the far side.
export const roles = [
  "enclosing",
  "caller",
  "callee",
  "removal",
  "type",
  "sibling",
  "test",
  "history",
  "indirect-caller",
] as const;

export type Role = (typeof roles)[number];

// unknownRoleRank sorts a role redline does not know after every role it does.
const unknownRoleRank = 99;

const rankByRole = new Map<string, number>(roles.map((r, i) => [r, i]));

// roleRank returns the role's ordering position and whether it is known.
export function roleRank(role: string): [rank: number, known: boolean] {
  const n = rankByRole.get(role);
  return n === undefined ? [unknownRoleRank, false] : [n, true];
}

export type Class = "source" | "generated" | "vendored" | "test" | "migration" | "lockfile" | "other";

/** @public — part of the wire contract, reached through Envelope. */
export interface Provider {
  name: string;
  version: string;
  language?: string;
}

// File is one changed file in the manifest.
export interface File {
  path: string;
  class: Class;
  generated?: boolean;
  symbols?: string[];
}

// Expansion is one piece of context beyond the diff. Priority orders
// expansions within a role and nothing else. StartLine and EndLine are 1-based
// and inclusive; absent means the expansion has no line span.
export interface Expansion {
  role: Role;
  priority?: number;
  symbol?: string;
  scope?: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  details?: Record<string, string>;
}

// Envelope is this provider's answer for one change.
export interface Envelope {
  schemaVersion: number;
  provider: Provider;
  baseSHA?: string;
  files?: File[];
  expansions?: Expansion[];
  promptFragment?: string;
  notes?: string[];
}

// validate reports whether an envelope is one redline can spend. It checks the
// frame, never the contents: a provider that found nothing is a legitimate
// answer. An unknown role is not a failure here; unknownRoles reports it.
export function validate(env: Envelope | null | undefined): Error | undefined {
  if (env == null) {
    return new Error("envelope is absent");
  }
  if (env.schemaVersion !== schemaVersion) {
    return new Error(`envelope schema version ${env.schemaVersion}, want ${schemaVersion}`);
  }
  // validate is given data that may not match the type it claims, which is
  // the point of validating it, so these checks are not unnecessary.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if ((env.provider?.name ?? "").trim() === "") {
    return new Error("envelope names no provider");
  }
  for (const [i, x] of (env.expansions ?? []).entries()) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!x.role) {
      return new Error(`expansion ${i} has no role`);
    }
  }
  return undefined;
}

// unknownRoles lists roles the envelope uses that redline does not rank,
// sorted. Reported rather than rejected, so a provider one version ahead
// degrades rather than fails.
export function unknownRoles(env: Envelope): string[] {
  const seen = new Set<string>();
  for (const x of env.expansions ?? []) {
    if (!roleRank(x.role)[1]) {
      seen.add(x.role);
    }
  }
  return [...seen].sort(compareStrings);
}

// generatedFiles returns the paths the manifest marks as machine output, sorted.
export function generatedFiles(env: Envelope): string[] {
  return (env.files ?? []).filter((f) => f.generated).map((f) => f.path).sort(compareStrings);
}

// encodeEnvelope renders the envelope as the JSON the consumer reads: two-space
// indent, one trailing newline, and the omitempty rules of the Go structs — a
// zero number, false, empty string, or empty list is left out, while content
// and provider.version are always written. Keys are emitted in struct order and
// details keys sorted, because the same revision must produce the same bytes.
export function encodeEnvelope(env: Envelope): string {
  return JSON.stringify(toWire(env), null, 2) + "\n";
}

function toWire(env: Envelope): Record<string, unknown> {
  const provider: Record<string, unknown> = { name: env.provider.name, version: env.provider.version };
  if (env.provider.language) provider["language"] = env.provider.language;

  const out: Record<string, unknown> = { schemaVersion: env.schemaVersion, provider };
  if (env.baseSHA) out["baseSHA"] = env.baseSHA;
  if (env.files?.length) out["files"] = env.files.map(fileToWire);
  if (env.expansions?.length) out["expansions"] = env.expansions.map(expansionToWire);
  if (env.promptFragment) out["promptFragment"] = env.promptFragment;
  if (env.notes?.length) out["notes"] = [...env.notes];
  return out;
}

function fileToWire(f: File): Record<string, unknown> {
  const out: Record<string, unknown> = { path: f.path, class: f.class };
  if (f.generated) out["generated"] = true;
  if (f.symbols?.length) out["symbols"] = [...f.symbols];
  return out;
}

function expansionToWire(x: Expansion): Record<string, unknown> {
  const out: Record<string, unknown> = { role: x.role };
  if (x.priority) out["priority"] = x.priority;
  if (x.symbol) out["symbol"] = x.symbol;
  if (x.scope) out["scope"] = x.scope;
  if (x.file) out["file"] = x.file;
  if (x.startLine) out["startLine"] = x.startLine;
  if (x.endLine) out["endLine"] = x.endLine;
  out["content"] = x.content;
  const keys = Object.keys(x.details ?? {}).sort(compareStrings);
  if (keys.length > 0) {
    const details: Record<string, string> = {};
    for (const k of keys) details[k] = x.details![k]!;
    out["details"] = details;
  }
  return out;
}

// compareStrings orders strings by code unit, independent of locale, so a sort
// gives the same answer on every machine.
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
