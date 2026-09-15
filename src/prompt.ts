// promptFragment is the TypeScript half of a review prompt. Ports the shape of
// gorefactor's internal/changectx/prompt.go. The consumer owns the harness half
// (the output schema, the rule against restating prior findings, that zero
// findings is a valid answer) and concatenates this as data framed as advice.
// It says how TypeScript and React code is conventionally read, so keep it
// about idiom and leave anything about output format out of it.
export const promptFragment = `Reviewing TypeScript.

A promise nobody awaits is an error nobody sees. A call that returns a promise
and is neither awaited, returned, nor given a rejection handler drops its
failure, and a try/catch only covers what is awaited inside it. An async
callback passed where a synchronous one is expected — forEach, an event
handler, a useEffect body — runs unobserved. A catch binding is unknown; code
that reads .message from it without narrowing is assuming. Sequential awaits in
a loop are a choice worth a reason when the calls are independent.

unknown is checked and any is not. A value typed any turns every use of it into
an unchecked claim, and it spreads to whatever it is assigned to. "as" and the
non-null "!" are assertions, not conversions: they silence the checker without
testing anything, and "as unknown as" says the types disagree and the code
overruled them. Input from the network, storage, or JSON.parse is unknown until
something narrows it.

null and undefined are different absences, and ?? and || are different
defaults. || replaces 0, "" and false along with null and undefined, which is a
bug wherever those are real values. Optional chaining turns a missing value into
undefined silently, so a chain that should never be empty hides the day it is.
An optional property and a property typed "| undefined" are not the same
contract when exact optional property types are on.

Typing is structural. Any object with the right shape satisfies an interface,
declared or not, and excess-property checks apply only to fresh object
literals, so a misspelled option passed through a variable is accepted. An
interface declared beside its only implementation usually adds nothing. A
union of object types wants a discriminant field and a switch whose default
assigns to never, so adding a member breaks the build at every place that has
to handle it.

React hooks run in the same order on every render: no hook inside a condition,
loop, or early return. A dependency array is a claim about what the callback
reads; a value it reads and does not list is a stale closure, and a function or
object created during render and listed changes identity every render. An effect
that subscribes, starts a timer, or fetches returns the cleanup that undoes it.
State derived from props or other state is usually a memo or a plain
computation, not a second copy kept in sync. With a query cache, a query key is
a contract: every query a view shows has to be reachable by the invalidation
that refreshes the view, and a new or renamed key that no invalidation matches
serves stale data without an error.

Tests usually sit beside the code as *.test.ts or *.test.tsx, grouped in
describe blocks. Look for state shared between cases that one test mutates and
another reads, for mocks that are not reset between tests, and for async UI
assertions that do not await. With Testing Library, queries by role, label, or
text say what a user sees, and a test id says less; a snapshot asserts little
beyond that something rendered.

Load-bearing idioms: discriminated unions with exhaustive handling, early
returns over nesting, readonly and "as const" for data that must not change,
and import type for imports that exist only for the checker. A barrel index
file re-exports names, so where a symbol is used is not where it is imported
from.
`;
