import assert from "node:assert/strict";
import { isConfigLikePath, scrubOutput } from "../redact.js";

const envOptions = { envAssignments: true };
const configOptions = { envAssignments: true, genericFields: true };

const knownToken = "sk-" + "a".repeat(24);
const bearerToken = "b".repeat(24);
const privateKey = [
  "-----BEGIN " + "PRIVATE KEY-----",
  "example-private-key-material",
  "-----END " + "PRIVATE KEY-----",
].join("\n");
const urlWithPassword = `postgres://alice:${"example-" + "password"}@example.com/db`;

const fixtures = [
  {
    name: "known token prefix is always redacted",
    actual: scrubOutput(`token=${knownToken}`),
    expected: "token=[REDACTED]",
  },
  {
    name: "bearer token is always redacted",
    actual: scrubOutput(`Authorization: Bearer ${bearerToken}`),
    expected: "Authorization: Bearer [REDACTED]",
  },
  {
    name: "private key block is always redacted",
    actual: scrubOutput(`before\n${privateKey}\nafter`),
    expected: "before\n[REDACTED:private-key]\nafter",
  },
  {
    name: "URL password is always redacted",
    actual: scrubOutput(urlWithPassword),
    expected: "postgres://alice:[REDACTED]@example.com/db",
  },
  {
    name: "env assignment preserves quotes when enabled",
    actual: scrubOutput('OPENAI_API_KEY="example-value"', envOptions),
    expected: 'OPENAI_API_KEY="[REDACTED]"',
  },
  {
    name: "env assignment remains intact for source reads",
    actual: scrubOutput('OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")'),
    expected: 'OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")',
  },
  {
    name: "JSON secret field is redacted for config reads",
    actual: scrubOutput('{"client_secret":"example-value","safe":"ok"}', configOptions),
    expected: '{"client_secret":"[REDACTED]","safe":"ok"}',
  },
  {
    name: "YAML secret field is redacted for config reads",
    actual: scrubOutput("password: example-value", configOptions),
    expected: "password: [REDACTED]",
  },
  {
    name: "short generic config value stays visible",
    actual: scrubOutput("token: local", configOptions),
    expected: "token: local",
  },
  {
    name: "Python annotations remain intact",
    actual: scrubOutput("def login(token: str, password: Optional[str], api_key: SecretStr) -> bool:"),
    expected: "def login(token: str, password: Optional[str], api_key: SecretStr) -> bool:",
  },
  {
    name: "TypeScript annotations remain intact",
    actual: scrubOutput("type Credentials = { token: string; client_secret: SecretString }"),
    expected: "type Credentials = { token: string; client_secret: SecretString }",
  },
];

for (const fixture of fixtures) {
  assert.equal(fixture.actual, fixture.expected, fixture.name);
}

for (const path of [".env", ".env.local", "config.json", "values.yaml", "app.toml", ".npmrc"]) {
  assert.equal(isConfigLikePath(path), true, `${path} should be config-like`);
}
for (const path of ["main.py", "types.ts", "README.md", "script.sh", "notes.txt"]) {
  assert.equal(isConfigLikePath(path), false, `${path} should not be config-like`);
}

console.log(`secret-guard-redact: ${fixtures.length} redaction cases and 11 path cases passed`);
