// The priority hint and the caller context window, shared by every expansion
// stage. They live apart from expand.ts so the stages can use them without
// importing the orchestrator that calls the stages, which would be a cycle.

import type { Decl } from "./decls.ts";

// callerContextLines is how much surrounding code a call site carries. A call
// alone does not say what it is guarding or what it does with the result.
export const callerContextLines = 2;

// priorityFor scores a declaration within its role. Exported symbols outrank
// unexported ones, and a heavily rewritten declaration outranks a one-line
// edit. The scale is local to a role; the consumer never compares across two.
export function priorityFor(d: Pick<Decl, "exported" | "changed">): number {
  return 50 + (d.exported ? 30 : 0) + Math.min(d.changed, 20);
}
