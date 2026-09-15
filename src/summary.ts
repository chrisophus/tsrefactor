// summary renders an envelope as a few lines for a person at a terminal. The
// JSON is what the consumer reads; this exists so a human can see whether the
// provider found what they expected before wiring it into anything. Ports
// gorefactor's internal/changectx/summary.go.

import { compareStrings, type Envelope } from "./envelope.ts";

export function summary(env: Envelope): string {
  const lines: string[] = [];
  lines.push(
    `context envelope v${env.schemaVersion}  base ${shortSHA(env.baseSHA ?? "")}  provider ${env.provider.name} ${env.provider.version}`,
  );

  const files = env.files ?? [];
  const classes = new Map<string, number>();
  let symbols = 0;
  let generated = 0;
  for (const f of files) {
    bump(classes, f.class);
    symbols += f.symbols?.length ?? 0;
    if (f.generated) generated++;
  }
  lines.push(`files: ${files.length} (${counts(classes)})`);
  if (generated > 0) {
    lines.push(`generated: ${generated} file(s) flagged for summary rather than reading`);
  }
  lines.push(`symbols: ${symbols}`);

  const exps = env.expansions ?? [];
  const roles = new Map<string, number>();
  for (const e of exps) bump(roles, e.role);
  lines.push(`expansions: ${exps.length} (${counts(roles)})`);
  for (const n of env.notes ?? []) {
    lines.push(`note: ${n}`);
  }
  return lines.join("\n") + "\n";
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

// counts renders a count map with its keys sorted, so the same envelope prints
// the same line every time.
function counts(m: Map<string, number>): string {
  if (m.size === 0) {
    return "none";
  }
  return [...m.keys()]
    .sort(compareStrings)
    .map((k) => `${k} ${m.get(k)}`)
    .join(", ");
}

function shortSHA(sha: string): string {
  if (sha === "") return "(none)";
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}
