# TODO / Notes

## 2026-02-16 — Friday 选型困惑（session / exec vs RPC）

### 背景/现状
- Friday 目前是“每条 Telegram 消息 spawn 一次 pi（exec/single-shot）”。
- 为了持久记忆：每个 chat 维护 `sessions/{chat_id}/current` symlink -> 某个 `*.jsonl`，startup 在 spawn 前读它决定 `--session`。
- `sessions` skill 负责查看/旋转/指定 `current`（并加了“模型可建议/触发 rotate”的策略说明）。

### 核心困惑（问题本质）
- “新话题/从头开始”希望 **从这条消息开始**进入新 session。
- 但在 exec 模式下：`--session <file>` 在 spawn 时就固定；模型在这轮里再改 symlink，只能影响“下一轮”。
  - ⇒ 不改入口层就无法 100% 保证“本条消息既不受旧上下文影响，又落到新 session 文件里”。

### 已澄清的点
- pi 自己（TUI）有 `/new` / `/resume`，但在我们这种 print/json + 包装 prompt 的方式下，Telegram 发 `/new` 不能透传触发。
- pi extension 里有 session API，但在“单次 spawn 后退出”的架构里，中途切换对同一条消息意义有限；且很多切换能力更适合 command/rpc 语境。

### 选型岔路
**A) 继续 exec（最 AI-native/最小框架）**
- 优点：简单、易自愈、无常驻状态、运维轻。
- 代价：对“本条消息前置路由/即时换会话”能力弱。

**B) 改成 RPC 常驻（pi 已提供协议）**
- 优点：可在处理同一条输入前先 `new_session` / `switch_session`；更强交互/取消/队列。
- 代价：Friday 侧要维护 RPC client 编排：进程生命周期、stdout/stderr 协议状态机、并发队列（多 chat）、可能还有 extension_ui 子协议。

**C) 折中：exec + 极少入口层确定性路由**
- 在 spawn 前做“强信号关键词”判断：命中就先 rotate `current`，再调用 pi。
- 代码改动很小，但会引入一些“非 AI 决策”的框架逻辑。

### 当前未决的问题（下次继续从这里接）
1) 更看重：最小框架（exec）还是“这条消息就能正确切会话”（需要 C 或 RPC）？
2) “强信号预切换”是否接受？关键词/阈值放 env 可配是否合适？
3) 群聊多话题并行时，session 粒度按 chat 够不够，还是要按话题拆分？

> 提示：这不是实现 bug，而是 exec 架构天然的时序限制。
