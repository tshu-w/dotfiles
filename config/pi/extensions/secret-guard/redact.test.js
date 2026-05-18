import assert from "node:assert/strict";
import { scrubOutput } from "./redact.js";

const fixtures = [
  {
    name: "env var preserves double quotes",
    input: 'OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz"',
    expected: 'OPENAI_API_KEY="[REDACTED]"',
  },
  {
    name: "env var preserves single quotes",
    input: "GITHUB_TOKEN='ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'",
    expected: "GITHUB_TOKEN='[REDACTED]'",
  },
  {
    name: "bare env var stops at whitespace",
    input: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ BAR=baz",
    expected: "GITHUB_TOKEN=[REDACTED] BAR=baz",
  },
  {
    name: "bare env var stops before inline comment",
    input: "NPM_TOKEN=npm_1234567890abcdefghijklmnopqrstuvwxyz # registry token",
    expected: "NPM_TOKEN=[REDACTED] # registry token",
  },
  {
    name: "bearer token preserves header shape",
    input: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret",
    expected: "Authorization: Bearer [REDACTED]",
  },
  {
    name: "github fine-grained PAT",
    input: "token=github_pat_1234567890abcdefghijklmnopqrstuvwxyz_ABCDE",
    expected: "token=[REDACTED]",
  },
  {
    name: "private key block",
    input: "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----\nafter",
    expected: "before\n[REDACTED:private-key]\nafter",
  },
  {
    name: "json style generic secret field",
    input: '{"client_secret":"supersecretvalue","safe":"ok"}',
    expected: '{"client_secret":"[REDACTED]","safe":"ok"}',
  },
  {
    name: "yaml style generic secret field",
    input: "password: correct-horse-battery-staple",
    expected: "password: [REDACTED]",
  },
  {
    name: "database URL preserves user and host",
    input: "postgres://alice:s3cr3t@example.com/db",
    expected: "postgres://alice:[REDACTED]@example.com/db",
  },
  {
    name: "npm token",
    input: "//registry.npmjs.org/:_authToken=npm_1234567890abcdefghijklmnopqrstuvwxyz",
    expected: "//registry.npmjs.org/:_authToken=[REDACTED]",
  },
  {
    name: "google API key",
    input: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    expected: "[REDACTED]",
  },
  {
    name: "does not redact ordinary short fields",
    input: "token: dev\npassword: local",
    expected: "token: dev\npassword: local",
  },
];

for (const fixture of fixtures) {
  assert.equal(scrubOutput(fixture.input), fixture.expected, fixture.name);
}

console.log(`secret-guard-redact: ${fixtures.length} fixtures passed`);
