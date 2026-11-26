// Pi's default docs guide and identity, matched by shape so wording from any Pi version is recognized.
const DEFAULT_DOCS = /^<docs>\nPi documentation \([^\n]*\):\n(?:- [^\n]*\n)+<\/docs>$/;
// The default identity is two sentences on one line; a prompt that adds anything is custom and stays.
const DEFAULT_PREAMBLE = /^You are [^\n]* inside pi, a coding agent harness\. (?:You help|Help) users [^.\n]*\.$/;

function isPiDefaultSection(name: string, value: string | null): boolean {
  const pattern = name === "docs" ? DEFAULT_DOCS : name === "preamble" ? DEFAULT_PREAMBLE : undefined;
  // Removing one of these sections leaves nothing to tell: the default was never shown.
  return pattern !== undefined && (value === null || pattern.test(value));
}

// Each default section is dropped on its own, in the prompt and in later system patches alike.
export function withoutPiDefaults<T extends string | null>(sections: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(sections).filter(([name, value]) => !isPiDefaultSection(name, value)));
}
