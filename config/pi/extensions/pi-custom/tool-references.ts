export function rewriteToolReferences(text: string, names: Map<string, string>): string {
  for (const [mcpName, piName] of [...names].sort((a, b) => b[1].length - a[1].length)) {
    const name = piName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text
      .replace(new RegExp(`^(- )${name}(?=:)`, "gm"), `$1${mcpName}`)
      .replaceAll(`\`${piName}\``, `\`${mcpName}\``)
      .replace(new RegExp(`(?<![\\w./-])${name}(?=\\()`, "g"), mcpName)
      .replace(new RegExp(`\\b(Use (?:the )?)${name}(?![\\w./-])`, "g"), `$1${mcpName}`)
      .replace(new RegExp(`(?<![\\w./-])${name}(?= tool\\b)`, "g"), mcpName);
  }
  return text;
}
