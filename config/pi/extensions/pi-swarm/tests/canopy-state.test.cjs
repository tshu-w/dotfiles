const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function fakeHost() {
	let sequence = 0;
	const turns = new Map();
	const persisted = [];
	const delivered = [];
	const stopped = [];
	const shutdown = [];
	return {
		turns,
		persisted,
		delivered,
		stopped,
		shutdown,
		prepareChild(request) {
			const id = `child-${++sequence}`;
			return { id, sessionFile: `/tmp/${id}.jsonl`, cwd: request.cwd ?? "/work" };
		},
		runChild(child, message) {
			const turn = deferred();
			turns.set(child.id, { ...turn, message });
			return turn.promise;
		},
		async stopChild(child) { stopped.push(child.id); },
		async shutdownChild(child) { shutdown.push(child.id); },
		persist(child) { persisted.push(structuredClone(child)); },
		deliver(completion) { delivered.push(structuredClone(completion)); },
	};
}

async function tick() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function main() {
	const jiti = createJiti(__filename, {
		interopDefault: true,
		alias: { "@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js` },
	});
	const { Canopy, TreeScheduler } = await jiti.import("../canopy.ts");

	{
		const host = fakeHost();
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		const { id } = canopy.spawn({ message: "research", context: "fresh" });
		assert.equal(id, "child-1");
		assert.equal(canopy.get(id).status, "running");
		await tick();
		host.turns.get(id).resolve({ status: "completed", result: "done" });
		await tick();
		assert.deepEqual(host.delivered, [{ id, status: "completed", result: "done" }]);
		assert.equal(canopy.get(id).status, "completed");

		canopy.send(id, "review again");
		assert.equal(canopy.get(id).status, "running");
		await tick();
		assert.equal(host.turns.get(id).message, "review again");
	}

	{
		const host = fakeHost();
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		const { id } = canopy.spawn({ message: "waited" });
		const waiting = canopy.wait({ ids: [id], timeoutSeconds: 1 });
		await tick();
		host.turns.get(id).resolve({ status: "completed", result: "wait result" });
		const result = await waiting;
		await tick();
		assert.deepEqual(result, {
			results: [{ id, status: "completed", result: "wait result" }],
			pending: [],
			timed_out: false,
		});
		assert.deepEqual(host.delivered, [], "wait consumes the completion before automatic delivery");
		assert.equal(canopy.get(id).result, undefined, "consumed payloads are not duplicated in the latest registry state");
	}

	{
		const host = fakeHost();
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		const { id } = canopy.spawn({ message: "initial analysis" });
		await tick();
		canopy.send(id, "compare costs");
		canopy.send(id, "check risks");
		assert.deepEqual(canopy.get(id).queuedMessages, ["compare costs", "check risks"]);
		const waiting = canopy.wait({ ids: [id], timeoutSeconds: 1 });

		host.turns.get(id).resolve({ status: "completed", result: "analysis result" });
		await tick();
		assert.equal(canopy.get(id).status, "running");
		assert.equal(host.turns.get(id).message, "compare costs");
		assert.deepEqual(host.delivered, []);

		host.turns.get(id).resolve({ status: "completed", result: "cost result" });
		await tick();
		assert.equal(host.turns.get(id).message, "check risks");
		host.turns.get(id).resolve({ status: "completed", result: "risk result" });

		const result = await waiting;
		assert.deepEqual(result.pending, []);
		assert.equal(result.timed_out, false);
		assert.match(result.results[0].result, /\[Child turn 1 — completed\]\nanalysis result/);
		assert.match(result.results[0].result, /\[Child turn 2 — completed\]\ncost result/);
		assert.match(result.results[0].result, /\[Child turn 3 — latest — completed\]\nrisk result/);
		assert.deepEqual(canopy.get(id).queuedMessages, []);
		assert.deepEqual(host.delivered, [], "wait consumes the aggregated completion");
	}

	{
		const host = fakeHost();
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		const ids = [
			canopy.spawn({ message: "a" }).id,
			canopy.spawn({ message: "b" }).id,
			canopy.spawn({ message: "c" }).id,
		];
		assert.throws(() => canopy.spawn({ message: "d" }), /concurrency limit/i);
		canopy.send(ids[0], "queued before stop");
		const stopped = await canopy.stop(ids[0]);
		assert.deepEqual(stopped, { id: ids[0], status: "stopped" });
		assert.deepEqual(host.stopped, [ids[0]]);
		assert.deepEqual(canopy.get(ids[0]).queuedMessages, []);
		assert.deepEqual(host.delivered, [], "explicit stop consumes its completion");
		assert.throws(() => canopy.send("not-a-child", "x"), /direct child/i);
	}

	{
		const host = fakeHost();
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		const { id } = canopy.spawn({ message: "slow" });
		const result = await canopy.wait({ ids: [id], timeoutSeconds: 0.01 });
		assert.deepEqual(result, { results: [], pending: [id], timed_out: true });
	}

	{
		const host = fakeHost();
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		canopy.restore([{
			id: "restored",
			sessionFile: "/tmp/restored.jsonl",
			cwd: "/work",
			status: "running",
			consumed: false,
			createdAt: "2026-07-22T00:00:00.000Z",
			updatedAt: "2026-07-22T00:00:00.000Z",
		}]);
		assert.equal(canopy.get("restored").status, "stopped");
		canopy.deliverPending();
		await tick();
		assert.deepEqual(host.delivered, [{ id: "restored", status: "stopped" }]);
	}

	{
		const host = fakeHost();
		const originalStop = host.stopChild;
		host.stopChild = async (child) => {
			if (child.id === "child-1") throw new Error("abort failed");
			await originalStop(child);
		};
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		const first = canopy.spawn({ message: "failed shutdown" }).id;
		const second = canopy.spawn({ message: "successful shutdown" }).id;
		await tick();
		await assert.rejects(canopy.shutdown(), AggregateError);
		assert.equal(canopy.get(first).status, "stopped");
		assert.equal(canopy.get(second).status, "stopped");
		assert.deepEqual(host.shutdown, [first, second], "shutdown continues after one stop failure");
	}

	{
		const host = fakeHost();
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		canopy.restore([{
			id: "queued-restored",
			sessionFile: "/tmp/queued-restored.jsonl",
			cwd: "/work",
			status: "running",
			queuedMessages: ["preserved follow-up"],
			consumed: false,
			createdAt: "2026-07-22T00:00:00.000Z",
			updatedAt: "2026-07-22T00:00:00.000Z",
		}]);
		canopy.deliverPending();
		await tick();
		assert.match(host.delivered[0].result, /1 queued follow-up preserved/);
		canopy.send("queued-restored", "new follow-up");
		await tick();
		assert.equal(host.turns.get("queued-restored").message, "preserved follow-up");
		host.turns.get("queued-restored").resolve({ status: "completed", result: "preserved result" });
		await tick();
		assert.equal(host.turns.get("queued-restored").message, "new follow-up");
		host.turns.get("queued-restored").resolve({ status: "completed", result: "new result" });
		await tick();
		assert.match(host.delivered.at(-1).result, /preserved result/);
		assert.match(host.delivered.at(-1).result, /new result/);
	}

	{
		const host = fakeHost();
		host.stopChild = async () => { throw new Error("abort failed"); };
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		const { id } = canopy.spawn({ message: "failed stop" });
		await tick();
		await assert.rejects(canopy.stop(id), /abort failed/);
		host.turns.get(id).resolve({ status: "completed", result: "continued" });
		await tick();
		assert.deepEqual(host.delivered, [{ id, status: "completed", result: "continued" }]);
	}

	{
		const host = fakeHost();
		const canopy = new Canopy(host, new TreeScheduler(), { rootId: "root", maxConcurrent: 3 });
		const { id } = canopy.spawn({ message: "abort wait" });
		const abort = new AbortController();
		const waiting = canopy.wait({ ids: [id], timeoutSeconds: 10, signal: abort.signal });
		abort.abort();
		await assert.rejects(waiting, { name: "AbortError" });
		await tick();
		host.turns.get(id).resolve({ status: "completed", result: "after abort" });
		await tick();
		assert.deepEqual(host.delivered, [{ id, status: "completed", result: "after abort" }]);
	}

	console.log("pi-swarm canopy: lifecycle state machine passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
