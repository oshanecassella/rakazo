import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DevinCli, DevinCliProcess } from "./devin-local-agent.js";
import { DevinLocalAgentProvider, devinAgentId } from "./devin-local-agent.js";

const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

class FakeTurn implements DevinCliProcess {
  static nextPid = 10_000;
  readonly pid = FakeTurn.nextPid++;
  killed = false;
  private resolve!: (value: { code: number; stderr: string }) => void;
  readonly done = new Promise<{ code: number; stderr: string }>((resolve) => {
    this.resolve = resolve;
  });
  constructor(private readonly alive: Set<number>) {
    alive.add(this.pid);
  }
  kill() {
    this.killed = true;
    this.finish(143);
  }
  finish(code = 0, stderr = "") {
    this.alive.delete(this.pid);
    this.resolve({ code, stderr });
  }
}

class FakeDevinCli implements DevinCli {
  readonly alive = new Set<number>();
  readonly runs: { cwd: string; args: string[] }[] = [];
  readonly turns: FakeTurn[] = [];
  sessions = new Map<string, { id: string; title?: string }[]>();

  run(cwd: string, args: string[]) {
    this.runs.push({ cwd, args });
    const turn = new FakeTurn(this.alive);
    this.turns.push(turn);
    return turn;
  }
  async list(cwd: string) {
    return this.sessions.get(cwd) ?? [];
  }
  lastTurn() {
    return this.turns[this.turns.length - 1]!;
  }
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("DevinLocalAgentProvider", () => {
  let root: string;
  let cli: FakeDevinCli;
  let provider: DevinLocalAgentProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "devin-agent-"));
    cli = new FakeDevinCli();
    provider = new DevinLocalAgentProvider({
      workspaceRoot: root,
      cli,
      isAlive: (pid) => cli.alive.has(pid),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("launches a session, replays the same key, and finishes with a title", async () => {
    const request = { idempotencyKey: "create-1", prompt: "Fix the login bug" };
    const first = await provider.launch(request, ctx);
    expect(first.id).toBe(devinAgentId("create-1"));
    expect(first.status).toBe("running");
    expect(cli.runs).toHaveLength(1);
    expect(cli.runs[0]!.cwd).toBe(join(root, first.id));

    const replay = await provider.launch(request, ctx);
    expect(replay.id).toBe(first.id);
    expect(cli.runs).toHaveLength(1);

    cli.sessions.set(join(root, first.id), [{ id: "calm-forest", title: "Fix the login bug" }]);
    cli.lastTurn().finish(0);
    await settle();

    const done = await provider.get(first.id, ctx);
    expect(done.status).toBe("finished");
    expect(done.title).toBe("Fix the login bug");
  });

  it("rejects a follow-up while a turn is running, then resumes the same session", async () => {
    const first = await provider.launch({ idempotencyKey: "busy", prompt: "Task" }, ctx);
    await expect(provider.reply(first.id, { prompt: "More" }, ctx)).rejects.toThrow(/busy/i);

    cli.sessions.set(join(root, first.id), [{ id: "calm-forest" }]);
    cli.lastTurn().finish(0);
    await settle();

    const followup = await provider.reply(first.id, { prompt: "Also add tests" }, ctx);
    expect(followup.status).toBe("running");
    expect(cli.runs[1]!.args).toEqual(["-r", "calm-forest", "-p", "Also add tests"]);
  });

  it("cancels a running turn and stays cancelled", async () => {
    const first = await provider.launch({ idempotencyKey: "stop", prompt: "Task" }, ctx);
    const turn = cli.lastTurn();
    const cancelled = await provider.cancel(first.id, ctx);
    expect(cancelled.status).toBe("cancelled");
    expect(turn.killed).toBe(true);
    await settle();
    expect((await provider.cancel(first.id, ctx)).status).toBe("cancelled");
    expect((await provider.get(first.id, ctx)).status).toBe("cancelled");
  });

  it("reports not_found for unknown agents and failed for nonzero exits", async () => {
    await expect(provider.get("dv-missing", ctx)).rejects.toThrow();
    const first = await provider.launch({ idempotencyKey: "oops", prompt: "Task" }, ctx);
    cli.lastTurn().finish(1, "devin: agent error");
    await settle();
    expect((await provider.get(first.id, ctx)).status).toBe("failed");
  });

  it("rejects an aborted launch without starting a turn", async () => {
    await expect(
      provider.launch(
        { idempotencyKey: "aborted", prompt: "Task" },
        { ...ctx, signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    expect(cli.runs).toHaveLength(0);
  });

  it("keeps reporting finished after the host restarts mid-state", async () => {
    const first = await provider.launch({ idempotencyKey: "restart", prompt: "Task" }, ctx);
    const turn = cli.lastTurn();
    // Simulate the API restarting: process exits without the done hook running.
    turn.killed = true;
    cli.alive.delete(turn.pid);
    const snapshot = await provider.get(first.id, ctx);
    expect(snapshot.status).toBe("finished");
  });
});
