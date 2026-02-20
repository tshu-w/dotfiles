import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { execSync, spawn } from "node:child_process"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const home = process.env.HOME || ""
const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
const xdgState = process.env.XDG_STATE_HOME || path.join(home, ".local", "state")

const projectDir = process.env.FRIDAY_PROJECT_DIR || path.join(xdgConfig, "pi-friday")
const dataDir = process.env.FRIDAY_DATA_HOME || path.join(xdgData, "friday")
const sessionsDir = path.join(xdgState, "pi", "sessions", "friday", "telegram")
const runtimeDir = path.join(dataDir, "runtime")
const offsetFile = path.join(runtimeDir, "tg.offset")

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim()
if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set")
}

// Fallback chain: provider error → try next
const PROVIDER_FALLBACK = [
    { provider: "openai-codex", model: "gpt-5.2-codex" },
    { provider: "anthropic", model: "claude-opus-4-6" },
    { provider: "google-gemini-cli", model: "gemini-3-pro-preview" },
    { provider: "kimi-coding", model: "k2p5" },
    { provider: "openrouter", model: "auto" },
]

const FORCE_KILL_DELAY_MS = 3000
const PROGRESS_MESSAGE_DELAY_MS = 1500
const DEFAULT_AUTO_NEW_SESSION_IDLE_SEC = 2 * 60 * 60
const AUTO_NEW_SESSION_IDLE_SEC = (() => {
    const raw = Number.parseInt(String(process.env.FRIDAY_AUTO_NEW_SESSION_IDLE_SEC || "").trim(), 10)
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_AUTO_NEW_SESSION_IDLE_SEC
    return raw
})()

const STOP_MODE_USER = "user"
const STOP_MODE_SHUTDOWN = "shutdown"

mkdirSync(sessionsDir, { recursive: true })
mkdirSync(runtimeDir, { recursive: true })

function getChatSessionDir(chatId) {
    const chatDir = path.join(sessionsDir, String(chatId))
    mkdirSync(chatDir, { recursive: true })
    return chatDir
}

function getLatestSessionFile(chatDir) {
    try {
        const files = readdirSync(chatDir)
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => {
                const file = path.join(chatDir, name)
                return { file, name, mtimeMs: statSync(file).mtimeMs }
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
        return files[0] || null
    } catch (err) {
        if (err?.code !== "ENOENT") {
            console.error("[friday] failed listing sessions:", err)
        }
        return null
    }
}

function parseUserIdSet(...envNames) {
    const out = new Set()
    for (const name of envNames) {
        const raw = (process.env[name] || "").trim()
        if (!raw) continue
        for (const part of raw.split(/[\s,]+/)) {
            if (!part) continue
            const n = Number.parseInt(part, 10)
            if (Number.isFinite(n)) out.add(n)
        }
    }
    return out
}

const userIds = parseUserIdSet("FRIDAY_USER_IDS", "FRIDAY_USER_ID")
if (userIds.size === 0) {
    throw new Error("FRIDAY_USER_IDS is empty; set allowed Telegram user ids")
}

// Track running processes per chat to allow /stop
const runningTasks = new Map() // chatId -> { child, stopHeartbeat, stopped }
const chatQueues = new Map()   // chatId -> Promise (tail of FIFO queue)
const pendingNewSessions = new Set() // chatId -> next message should start a new session
const lastInboundAtByChat = new Map() // chatId -> previous inbound Telegram message timestamp (seconds)

async function withChatQueue(chatId, fn) {
    let releaseTurn
    const myTurn = new Promise((resolve) => { releaseTurn = resolve })
    const prevTurn = chatQueues.get(chatId)
    chatQueues.set(chatId, myTurn)
    if (prevTurn) await prevTurn

    try {
        return await fn()
    } finally {
        releaseTurn()
        if (chatQueues.get(chatId) === myTurn) chatQueues.delete(chatId)
    }
}

function loadOffset() {
    if (!existsSync(offsetFile)) return 0
    const raw = readFileSync(offsetFile, "utf8").trim()
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
}

function saveOffset(offset) {
    writeFileSync(offsetFile, String(offset))
}

function displayName(from) {
    if (!from) return "unknown"
    return from.username || [from.first_name, from.last_name].filter(Boolean).join(" ") || String(from.id)
}

async function tgApi(method, payload) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: payload ? "POST" : "GET",
        headers: payload ? { "Content-Type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
    })
    if (!res.ok) throw new Error(`Telegram API HTTP ${res.status}`)
    const json = await res.json()
    if (!json.ok) throw new Error(json.description || "Telegram API error")
    return json.result
}

function isTransientTelegramError(err) {
    const msg = String(err?.message || err || "")
    return (
        msg.includes("UND_ERR_CONNECT_TIMEOUT") ||
        msg.includes("Connect Timeout") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("Telegram API HTTP 5")
    )
}

async function tgApiRetry(method, payload, options = {}) {
    const attempts = Number.isFinite(options.attempts) ? options.attempts : 3
    const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : 500
    let lastErr
    for (let i = 0; i < attempts; i++) {
        try {
            return await tgApi(method, payload)
        } catch (err) {
            lastErr = err
            if (!isTransientTelegramError(err) || i === attempts - 1) break
            await sleep(baseDelayMs * (i + 1))
        }
    }
    throw lastErr
}

async function sendText(chatId, text, replyToMessageId) {
    const safe = (text || "").trim() || "✅ Processed."
    try {
        await tgApi("sendMessage", {
            chat_id: chatId,
            text: safe,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_to_message_id: replyToMessageId,
        })
    } catch (err) {
        // If Markdown fails (e.g. unclosed tags), fallback to plain text
        if (String(err).includes("can't parse entities")) {
            await tgApi("sendMessage", {
                chat_id: chatId,
                text: safe,
                disable_web_page_preview: true,
                reply_to_message_id: replyToMessageId,
            })
        } else {
            throw err
        }
    }
}

async function notifyOnlineOnStartup() {
    const chatId = String(process.env.TELEGRAM_DEFAULT_CHAT_ID || "").trim()
    if (!chatId) return

    try {
        await sendText(chatId, "🟢 Friday 已重新上线")
    } catch (err) {
        console.error("[friday] failed sending startup online message:", err)
    }
}

async function sendTyping(chatId) {
    await tgApiRetry("sendChatAction", { chat_id: chatId, action: "typing" }, { attempts: 2 })
}

function startTypingHeartbeat(chatId, intervalMs = 4500) {
    const timer = setInterval(() => {
        sendTyping(chatId).catch((err) => {
            console.error("[friday] failed sending typing heartbeat:", err)
        })
    }, intervalMs)
    return () => clearInterval(timer)
}

function stopTask(task, mode = STOP_MODE_USER) {
    if (!task) return false

    task.stopped = true
    if (task.stopHeartbeat) {
        try { task.stopHeartbeat() } catch {}
        task.stopHeartbeat = null
    }

    const childRef = task.child
    if (!childRef) return true

    try { childRef.kill("SIGTERM") } catch {}

    if (mode === STOP_MODE_USER) {
        setTimeout(() => {
            try { childRef.kill("SIGKILL") } catch {}
        }, FORCE_KILL_DELAY_MS).unref()
    }

    return true
}

function getRunState(result, stopRequested) {
    if (result.stopped) return "stopped"
    if (stopRequested && result.ok) return "stop-no-effect"
    if (stopRequested) return "stop-failed"
    if (!result.ok) return "failed"
    return "ok"
}

async function finalizeRun(chatId, replyToMessageId, result, stopRequested) {
    switch (getRunState(result, stopRequested)) {
        case "stopped":
            console.log("[friday] task was stopped by user")
            await sendText(chatId, "🛑 当前任务已中断。", replyToMessageId)
            return
        case "stop-no-effect":
            await sendText(chatId, "❌ 中断未生效：任务已执行完成。", replyToMessageId)
            return
        case "stop-failed":
            console.error("[friday] pi call failed during stop:", result.error)
            await sendText(chatId, `❌ 中断失败：${truncateText(result.error, 160)}`, replyToMessageId)
            return
        case "failed":
            console.error("[friday] pi call failed:", result.error)
            await sendText(chatId, `🔴 处理失败：${truncateText(result.error, 300)}`, replyToMessageId)
            return
        case "ok":
            if (result.output) console.log("[friday] pi stdout:", result.output)
            return
        default:
            return
    }
}

function cleanPiOutput(raw) {
    return (raw || "")
        .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
        .trim()
}

function extractTelegramText(message) {
    return (message?.text || message?.caption || "").trim() || "[non-text message]"
}

function buildPrompt(message, text) {
    const lines = [
        "[Telegram inbound]",
        `from: ${displayName(message.from)} chat_type=${message.chat.type}`,
        "message:",
        text,
    ]

    const reply = message?.reply_to_message
    if (reply) {
        const replyText = extractTelegramText(reply)
        lines.push("")
        lines.push("reply_to:")
        lines.push(`from: ${displayName(reply.from)}`)
        lines.push("message:")
        lines.push(truncateText(replyText, 1500))
    }

    return lines.join("\n")
}

function getToolLabel(toolName) {
    const name = String(toolName || "")
    if (name === "read") return "读取文件"
    if (name === "bash") return "执行命令"
    if (name === "edit") return "修改文件"
    if (name === "write") return "写入文件"
    return name || "工具"
}

function truncateText(text, max = 56) {
    const value = String(text || "").trim()
    if (!value) return ""
    return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function redactCommandPreview(command) {
    const oneLine = String(command || "").replace(/\s+/g, " ").trim()
    if (!oneLine) return ""
    return truncateText(
        oneLine
            .replace(/(token|api[_-]?key|secret|password)\s*[=:]\s*\S+/gi, "$1=***")
            .replace(/[A-Za-z0-9_-]{32,}/g, "***"),
    )
}

function summarizeToolAction(toolName, args) {
    const name = String(toolName || "")
    const p = typeof args?.path === "string" ? truncateText(args.path) : ""
    if (name === "read") return p ? `读取 ${p}` : "读取文件"
    if (name === "edit") return p ? `修改 ${p}` : "修改文件"
    if (name === "write") return p ? `写入 ${p}` : "写入文件"
    if (name === "bash") {
        const preview = redactCommandPreview(args?.command)
        return preview ? `执行命令 ${preview}` : "执行命令"
    }
    return getToolLabel(name)
}

function extractAssistantText(message) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return ""
    return message.content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
        .trim()
}

function createProgressReporter(chatId) {
    let desiredText = "✨ 请稍等…"
    let lastSentText = ""
    let statusMessageId
    let editQueue = Promise.resolve()
    let resolveCreated
    let createdResolved = false

    const createdPromise = new Promise((resolve) => {
        resolveCreated = resolve
    })

    const resolveCreatedOnce = () => {
        if (createdResolved) return
        createdResolved = true
        resolveCreated()
    }

    const createTimer = setTimeout(async () => {
        try {
            const result = await tgApi("sendMessage", {
                chat_id: chatId,
                text: desiredText,
                disable_web_page_preview: true,
                disable_notification: true,
            })
            statusMessageId = result?.message_id
            lastSentText = desiredText
        } catch (err) {
            console.error("[friday] failed sending progress message:", err)
        } finally {
            resolveCreatedOnce()
        }
    }, PROGRESS_MESSAGE_DELAY_MS)

    function queueEdit(nextText) {
        desiredText = nextText
        if (!statusMessageId) return
        editQueue = editQueue.then(async () => {
            if (!statusMessageId || desiredText === lastSentText) return
            try {
                await tgApiRetry("editMessageText", {
                    chat_id: chatId,
                    message_id: statusMessageId,
                    text: desiredText,
                    disable_web_page_preview: true,
                }, { attempts: 2 })
                lastSentText = desiredText
            } catch (err) {
                const msg = String(err?.message || err)
                if (!msg.includes("message is not modified")) {
                    console.error("[friday] failed updating progress message:", err)
                }
            }
        })
    }

    return {
        update(text) {
            queueEdit(text)
        },
        async finish() {
            clearTimeout(createTimer)
            resolveCreatedOnce()
            await createdPromise
            await editQueue

            if (!statusMessageId) return

            try {
                await tgApiRetry("deleteMessage", {
                    chat_id: chatId,
                    message_id: statusMessageId,
                })
            } catch (err) {
                console.error("[friday] failed deleting progress message:", err)
            }
        },
    }
}

function runPi(prompt, sessionDir, continueSession, chatId, replyToMessageId, onEvent, { provider, model } = {}) {
    return new Promise((resolve) => {
        const args = [
            "-p",
            "--mode",
            "json",
            "--session-dir",
            sessionDir,
        ]
        if (continueSession) args.push("--continue")
        if (provider) args.push("--provider", provider)
        if (model) args.push("--model", model)
        args.push(prompt)

        const child = spawn("pi", args, {
            cwd: projectDir,
            env: {
                ...process.env,
                TELEGRAM_DEFAULT_CHAT_ID: String(chatId),
                TELEGRAM_REPLY_TO_MESSAGE_ID: String(replyToMessageId),
            },
            stdio: ["ignore", "pipe", "pipe"],
        })

        // Register running task
        const task = runningTasks.get(chatId)
        if (task) {
            task.child = child
        }

        let stderr = ""
        let stdoutBuffer = ""
        let assistantOutput = ""
        let apiErrorMessage = ""
        let settled = false

        const settle = (result) => {
            if (settled) return
            settled = true
            if (runningTasks.get(chatId)?.child === child) {
                runningTasks.get(chatId).child = null
            }
            resolve(result)
        }

        const handleStdoutLine = (line) => {
            const raw = line.trim()
            if (!raw) return
            let event
            try {
                event = JSON.parse(raw)
            } catch {
                return
            }
            onEvent?.(event)
            if (event?.type === "message_end") {
                const msg = event?.message
                // Capture API-level errors (e.g. quota exhaustion) — pi exits 0 but stopReason is "error"
                if (msg?.stopReason === "error" && msg?.errorMessage) {
                    apiErrorMessage = msg.errorMessage
                }
                const text = extractAssistantText(msg)
                if (text) assistantOutput = text
            }
        }

        child.stdout.setEncoding("utf8")
        child.stdout.on("data", (chunk) => {
            stdoutBuffer += chunk
            let idx
            while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
                const line = stdoutBuffer.slice(0, idx)
                stdoutBuffer = stdoutBuffer.slice(idx + 1)
                handleStdoutLine(line)
            }
        })

        child.stderr.setEncoding("utf8")
        child.stderr.on("data", (chunk) => {
            stderr += chunk
        })

        child.on("error", (err) => {
            settle({ ok: false, error: err.message || String(err) })
        })

        child.on("close", (code, signal) => {
            if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer)
            // Check if killed by signal (e.g. SIGTERM from /stop)
            if (signal) {
                settle({ ok: false, error: `pi killed by ${signal}`, stopped: true })
                return
            }
            if (code !== 0) {
                const detail = cleanPiOutput(stderr) || `pi exited with ${code}`
                settle({ ok: false, error: detail })
                return
            }
            // Pi exited 0 but API returned an error (e.g. quota exhaustion)
            if (apiErrorMessage && !assistantOutput) {
                settle({ ok: false, error: apiErrorMessage })
                return
            }
            settle({ ok: true, output: assistantOutput })
        })
    })
}

// Load project-level pi settings (.pi/settings.json in projectDir)
function loadProjectSettings() {
    const settingsPath = path.join(projectDir, ".pi", "settings.json")
    try {
        return JSON.parse(readFileSync(settingsPath, "utf8"))
    } catch (err) {
        if (err?.code !== "ENOENT") {
            console.warn("[friday] failed to parse", settingsPath, err.message)
        }
        return {}
    }
}

async function runPiWithFallback(prompt, sessionDir, continueSession, chatId, replyToMessageId, onEvent, { onProviderSwitch } = {}) {
    let lastError = null
    const triedProviders = []

    // Build fallback chain: project settings preference first, then default chain
    const projectSettings = loadProjectSettings()
    let chain = []
    
    if (projectSettings.defaultProvider && projectSettings.defaultModel) {
        chain.push({ provider: projectSettings.defaultProvider, model: projectSettings.defaultModel })
    }
    
    // Add remaining providers from PROVIDER_FALLBACK (skip if already added from settings)
    for (const entry of PROVIDER_FALLBACK) {
        if (!chain.some(e => e.provider === entry.provider && e.model === entry.model)) {
            chain.push(entry)
        }
    }

    for (let i = 0; i < chain.length; i++) {
        // Check if user requested stop before trying next provider
        const task = runningTasks.get(chatId)
        if (task?.stopped) {
            console.log("[friday] task stopped by user, aborting fallback chain")
            return { ok: false, error: "Task stopped by user", stopped: true }
        }

        const { provider, model } = chain[i]
        console.log(`[friday] Trying ${provider}/${model}...`)
        onProviderSwitch?.(provider, model)

        const shouldContinue = i === 0 ? continueSession : true
        const result = await runPi(prompt, sessionDir, shouldContinue, chatId, replyToMessageId, onEvent, { provider, model })

        if (result.ok) {
            if (i > 0) {
                const tried = triedProviders.map(p => p.provider).join(" → ")
                console.log(`[friday] fallback: ${tried} → ${provider}/${model}`)
            }
            return result
        }

        // If the process was killed by a signal (user /stop), don't try next provider
        if (result.stopped) {
            console.log(`[friday] ${provider} stopped by signal, aborting fallback chain`)
            return result
        }

        triedProviders.push({ provider, model })
        lastError = result.error
        console.log(`[friday] ${provider} failed: ${truncateText(result.error, 200)}, trying next...`)
    }

    return { ok: false, error: lastError || "All providers failed" }
}

async function handleCommand(chatId, text, message) {
    const cmd = text.split(/\s+/)[0].toLowerCase()
    const logDir = path.join(dataDir, "logs")
    const errLogPath = path.join(logDir, "friday.err.log")

    switch (cmd) {
        case "/ping":
            await sendText(chatId, "🏓 Pong!", message.message_id)
            return true
        case "/help":
            await sendText(chatId,
                "🤖 *Friday 基础指令*\n\n" +
                "/ping - 检查运行状态\n" +
                "/status - 查看运行信息\n" +
                "/new - 开启新会话 (重置上下文)\n" +
                "/stop - 停止当前运行的任务\n" +
                "/logs - 获取最近 20 行错误日志\n" +
                "/restart - 重启 Friday 服务\n" +
                "/help - 显示此帮助",
                message.message_id
            )
            return true
        case "/status": {
            const chatDir = getChatSessionDir(chatId)
            const latest = getLatestSessionFile(chatDir)
            const isRunning = !!runningTasks.get(chatId)?.child
            const stats = [
                "📊 *运行状态*",
                `状态: ${isRunning ? "🔴 正在思考/执行工具" : "🟢 空闲"}`,
                `会话目录: \`${chatDir}\``,
                `最近会话: \`${latest ? latest.name : "(none)"}\``,
                `内存占用: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB`,
                `当前 Offset: ${loadOffset()}`
            ]
            await sendText(chatId, stats.join("\n"), message.message_id)
            return true
        }
        case "/new": {
            pendingNewSessions.add(chatId)
            await sendText(chatId, "🆕 已设置：下一条消息将开启新会话。", message.message_id)
            return true
        }
        case "/stop": {
            if (!stopTask(runningTasks.get(chatId))) {
                await sendText(chatId, "ℹ️ 当前没有正在运行的任务。", message.message_id)
            }
            return true
        }
        case "/logs": {
            try {
                const outLogPath = path.join(logDir, "friday.out.log")
                let outContent = ""
                let errContent = ""

                if (existsSync(errLogPath)) {
                    errContent = cleanPiOutput(execSync(`tail -20 "${errLogPath}"`, { encoding: "utf8" }))
                }
                if (existsSync(outLogPath)) {
                    outContent = cleanPiOutput(execSync(`tail -20 "${outLogPath}"`, { encoding: "utf8" }))
                }

                if (!errContent && !outContent) {
                    await sendText(chatId, "📭 暂无日志记录。", message.message_id)
                    return true
                }

                let response = ""
                if (errContent) response += `🚨 *Recent Errors:*\n\`\`\`\n${errContent}\n\`\`\`\n`
                if (outContent) response += `📝 *Recent Activity:*\n\`\`\`\n${outContent}\n\`\`\``

                await sendText(chatId, response, message.message_id)
            } catch (err) {
                await sendText(chatId, `❌ 读取日志失败: ${err.message}`, message.message_id)
            }
            return true
        }
        case "/restart":
            setTimeout(() => {
                const uid = process.getuid ? process.getuid() : 501
                spawn("launchctl", ["kickstart", "-k", `gui/${uid}/dev.friday.bot`], { detached: true, stdio: "ignore" }).unref()
            }, 100)
            return true
        default:
            return false
    }
}

async function handleUpdate(update) {
    const message = update?.message
    if (!message) return

    const userId = message?.from?.id
    if (!Number.isFinite(userId)) return

    const chatId = String(message.chat.id)
    if (!userIds.has(userId)) {
        await sendText(chatId, "⛔️ You are not allowed to use Friday.", message.message_id)
        return
    }

    const text = (message.text || message.caption || "").trim() || "[non-text message]"

    // Command interception
    if (text.startsWith("/")) {
        const handled = await handleCommand(chatId, text, message)
        if (handled) return
    }

    await withChatQueue(chatId, async () => {
        const chatDir = getChatSessionDir(chatId)
        const forceNew = pendingNewSessions.has(chatId)
        pendingNewSessions.delete(chatId)

        const hasQuote = !!message.reply_to_message
        const prevTs = lastInboundAtByChat.get(chatId)
        const messageTs = Number(message.date)
        const nowTs = Number.isFinite(messageTs) && messageTs > 0
            ? Math.floor(messageTs)
            : Math.floor(Date.now() / 1000)
        const idleTooLong = Number.isFinite(prevTs) && nowTs >= prevTs && (nowTs - prevTs >= AUTO_NEW_SESSION_IDLE_SEC)
        const autoNew = !hasQuote && idleTooLong
        const continueSession = hasQuote ? true : !(forceNew || autoNew)

        lastInboundAtByChat.set(chatId, nowTs)

        const progressState = {
            phase: "思考中",
            toolCount: 0,
            lastTool: "",
            lastDetail: "",
            modelLabel: "",
        }

        const progressReporter = createProgressReporter(chatId)
        const task = {
            child: null,
            stopHeartbeat: startTypingHeartbeat(chatId),
            stopped: false,
        }

        await sendTyping(chatId).catch(() => {})
        runningTasks.set(chatId, task)

        const prompt = buildPrompt(message, text)
        try {
            const result = await runPiWithFallback(prompt, chatDir, continueSession, chatId, message.message_id, makeEventHandler(progressReporter, progressState), {
                onProviderSwitch: (_provider, model) => {
                    progressState.modelLabel = model
                },
            })

            if (task.stopHeartbeat) {
                try { task.stopHeartbeat() } catch {}
                task.stopHeartbeat = null
            }
            await progressReporter.finish()
            await finalizeRun(chatId, message.message_id, result, task.stopped)
        } finally {
            runningTasks.delete(chatId)
        }
    })
}

function makeEventHandler(pr, ps) {
    return (event) => {
        let updated = false
        switch (event?.type) {
            case "message_start":
                if (event?.message?.role === "assistant") {
                    ps.phase = "思考中"
                    updated = true
                }
                break
            case "tool_execution_start":
                ps.phase = "执行工具"
                ps.toolCount += 1
                ps.lastTool = getToolLabel(event?.toolName)
                ps.lastDetail = summarizeToolAction(event?.toolName, event?.args)
                updated = true
                break
            case "auto_compaction_start":
                ps.phase = "整理上下文"
                updated = true
                break
            case "auto_retry_start":
                ps.phase = `自动重试 ${event?.attempt ?? "?"}/${event?.maxAttempts ?? "?"}`
                updated = true
                break
            default:
                break
        }

        if (updated) {
            const modelTag = ps.modelLabel ? ` ${ps.modelLabel}` : ""
            if (ps.toolCount > 0) {
                const detail = ps.lastDetail || ps.lastTool
                pr.update(`✨ ${ps.phase}…${modelTag}\n第${ps.toolCount}步：${detail}`)
            } else {
                pr.update(`✨ ${ps.phase}…${modelTag}`)
            }
        }
    }
}

let stop = false

function shutdownRunningTasks() {
    if (runningTasks.size === 0) return

    console.log(`[friday] shutting down ${runningTasks.size} running task(s)...`)
    for (const task of runningTasks.values()) {
        stopTask(task, STOP_MODE_SHUTDOWN)
    }

    setTimeout(() => {
        for (const task of runningTasks.values()) {
            if (!task.child) continue
            try { task.child.kill("SIGKILL") } catch {}
        }
        process.exit(1)
    }, FORCE_KILL_DELAY_MS).unref()
}

process.on("SIGINT", () => {
    stop = true
    shutdownRunningTasks()
})
process.on("SIGTERM", () => {
    stop = true
    shutdownRunningTasks()
})

let offset = loadOffset()
await notifyOnlineOnStartup()
console.log(`[friday] startup loop online, offset=${offset}`)

while (!stop) {
    try {
        const updates = await tgApi("getUpdates", {
            offset: offset > 0 ? offset + 1 : undefined,
            limit: 50,
            timeout: 60,
            allowed_updates: ["message"],
        })

        if (!Array.isArray(updates) || updates.length === 0) continue

        for (const update of updates) {
            const updateId = Number.parseInt(String(update?.update_id ?? "0"), 10)
            if (Number.isFinite(updateId) && updateId > offset) {
                offset = updateId
                saveOffset(offset)
            }
            // Non-blocking so we can process commands while a prompt is running
            handleUpdate(update).catch((err) => {
                console.error("[friday] failed handling update", update?.update_id, err)
            })
        }
    } catch (err) {
        console.error("[friday] polling error:", err)
        await sleep(2000)
    }
}

console.log("[friday] startup loop stopped")
