# Claude Code provider

Claude models in Pi through your existing Claude Code login. Provider ID: `claude-code`.

On machines requiring local ad-hoc signing, sign `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` after installing or updating dependencies.

Pi tools remain available; Claude Code's built-in tools, extra MCP servers, skills, auto-memory and automatic compaction are disabled. No other Pi extension is required.

Claude Code's default system prompt is supplemented with Pi's tool guidance, project instructions, skills, user instructions and extension sections. Pi's default identity and documentation guide are omitted. Explicit full-prompt overrides remain exact.

Prompt caching is enabled by default. Token costs shown by Pi are catalogue-based estimates, not subscription charges. The context limit is 200K.
