import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const sessionSchema = z.array(
  z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    last_activity_at: z.number().optional(),
  }),
);

interface DevinAgentState {
  id: string;
  cliSessionId?: string;
  title: string;
  status: CloudAgentStatus;
  pid?: number;
}

export interface DevinCliProcess {
  pid: number;
  done: Promise<{ code: number; stderr: string }>;
  kill(): void;
}

export interface DevinCli {
  run(cwd: string, args: string[]): DevinCliProcess;
  list(cwd: string): Promise<z.infer<typeof sessionSchema>>;
}

export interface DevinLocalAgentOptions {
  bin?: string;
  workspaceRoot?: string;
  cli?: DevinCli;
  /** Injectable for tests; defaults to a live pid probe. */
  isAlive?: (pid: number) => boolean;
}

function createDevinCli(bin: string): DevinCli {
  return {
    run(cwd, args) {
      const child = spawn(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < 64_000) stderr += chunk;
      });
      child.stdout?.resume();
      const done = new Promise<{ code: number; stderr: string }>((resolve) => {
        child.once("error", (error) => resolve({ code: 1, stderr: String(error) }));
        child.once("exit", (code) => resolve({ code: code ?? 1, stderr }));
      });
      return {
        pid: child.pid!,
        done,
        kill: () => {
          child.kill("SIGTERM");
        },
      };
    },
    async list(cwd) {
      const { stdout } = await execFileAsync(bin, ["list", "--format", "json"], {
        cwd,
        maxBuffer: 4 * 1024 * 1024,
      });
      return sessionSchema.parse(JSON.parse(stdout));
    },
  };
}

/**
 * Devin Cloud Agent provider backed by the local `devin` CLI instead of a
 * hosted API. Each cloud agent maps to one Devin session living in its own
 * directory under workspaceRoot; `devin -p` starts a turn and `devin -r` sends
 * follow-ups. `devin list --format json` supplies titles and session ids.
 */
export class DevinLocalAgentProvider implements CloudAgentProvider {
  private readonly workspaceRoot: string;
  private readonly cli: DevinCli;
  private readonly isAlive: (pid: number) => boolean;
  /** Turns started in this process; after a restart only the pid survives. */
  private readonly turns = new Map<number, DevinCliProcess>();
  /** Per-agent mutation queue: state.json has a single writer at a time. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private writeSeq = 0;

  constructor(options: DevinLocalAgentOptions = {}) {
    this.workspaceRoot =
      options.workspaceRoot ?? join(homedir(), ".local", "share", "rakazo", "devin-agents");
    this.cli = options.cli ?? createDevinCli(options.bin ?? "devin");
    this.isAlive =
      options.isAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
  }

  describe() {
    return {
      id: "devin",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: false },
    };
  }

  launch(request: CloudAgentLaunchRequest, context: AdapterContext): Promise<CloudAgentHandle> {
    // Stable id makes a retried create resolve to the same agent, like Cursor's
    // client-supplied id.
    const id = devinAgentId(request.idempotencyKey);
    return this.enqueue(id, async () => {
      const signal = request.signal ?? context.signal;
      if (signal.aborted) throw new Error("Cloud agent launch aborted");
      const existing = await this.readState(id);
      if (existing) return this.handle(await this.refresh(existing));
      const dir = this.dir(id);
      await mkdir(dir, { recursive: true });
      const state: DevinAgentState = {
        id,
        title: request.prompt.split("\n", 1)[0]!.slice(0, 80) || "Devin agent",
        status: "running",
      };
      this.startTurn(state, ["-p", request.prompt], signal);
      await this.writeState(state);
      return this.handle(state);
    });
  }

  get(id: string, _context: AdapterContext, _runId?: string): Promise<CloudAgentSnapshot> {
    return this.enqueue(id, async () => this.handle(await this.refresh(await this.stateOrThrow(id))));
  }

  reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    return this.enqueue(id, async () => {
      const signal = request.signal ?? context.signal;
      if (signal.aborted) throw new Error("Cloud agent reply aborted");
      const state = await this.refresh(await this.stateOrThrow(id));
      if (state.status === "expired") throw new CloudAgentRequestRejected("expired");
      if (state.status === "running") throw new Error("Cloud agent is busy with another run");
      const cliSessionId = await this.ensureCliSessionId(state);
      if (!cliSessionId) throw new CloudAgentRetryLater("unavailable");
      this.startTurn(state, ["-r", cliSessionId, "-p", request.prompt], signal);
      await this.writeState(state);
      return this.handle(state);
    });
  }

  cancel(id: string, _context: AdapterContext, _runId?: string): Promise<CloudAgentSnapshot> {
    return this.enqueue(id, async () => {
      const state = await this.refresh(await this.stateOrThrow(id));
      if (state.status !== "running") return this.handle(state);
      // Persist cancelled before signalling the turn so the done hook, which
      // reads the state file back, can never overwrite it with a result.
      const pid = state.pid;
      state.status = "cancelled";
      state.pid = undefined;
      await this.writeState(state);
      this.killTurn(pid);
      return this.handle(state);
    });
  }

  private enqueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  private killTurn(pid: number | undefined) {
    if (pid === undefined || !this.isAlive(pid)) return;
    const turn = this.turns.get(pid);
    try {
      if (turn) turn.kill();
      else process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private dir(id: string) {
    return join(this.workspaceRoot, id);
  }

  private statePath(id: string) {
    return join(this.dir(id), "agent.json");
  }

  private async readState(id: string): Promise<DevinAgentState | null> {
    try {
      const raw = await readFile(this.statePath(id), "utf8");
      const parsed = JSON.parse(raw) as DevinAgentState;
      return parsed && typeof parsed.id === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeState(state: DevinAgentState) {
    const path = this.statePath(state.id);
    await mkdir(this.dir(state.id), { recursive: true });
    const tmp = `${path}.${process.pid}.${this.writeSeq++}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, path);
  }

  private async stateOrThrow(id: string) {
    const state = await this.readState(id);
    if (!state) throw new CloudAgentRequestRejected("not_found");
    return state;
  }

  private async refresh(state: DevinAgentState): Promise<DevinAgentState> {
    if (state.status === "running") {
      const alive = state.pid !== undefined && this.isAlive(state.pid);
      if (!alive) {
        // A dead pid with no recorded exit means the host process restarted
        // mid-turn; the turn itself is over.
        state.pid = undefined;
        state.status = "finished";
        await this.writeState(state);
      }
    }
    if (!state.cliSessionId) {
      await this.ensureCliSessionId(state).catch(() => undefined);
    }
    return state;
  }

  private async ensureCliSessionId(state: DevinAgentState) {
    if (state.cliSessionId) return state.cliSessionId;
    const sessions = await this.cli.list(this.dir(state.id));
    const [latest] = sessions;
    if (latest) {
      state.cliSessionId = latest.id;
      if (latest.title) state.title = latest.title;
      await this.writeState(state);
      return latest.id;
    }
    return undefined;
  }

  private startTurn(state: DevinAgentState, args: string[], signal: AbortSignal) {
    const turn = this.cli.run(this.dir(state.id), args);
    state.pid = turn.pid;
    state.status = "running";
    this.turns.set(turn.pid, turn);
    const onAbort = () => turn.kill();
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    void turn.done
      .then(({ code, stderr }) =>
        this.enqueue(state.id, async () => {
          signal.removeEventListener("abort", onAbort);
          this.turns.delete(turn.pid);
          const latest = await this.readState(state.id);
          if (!latest || latest.status === "cancelled") return;
          latest.pid = undefined;
          latest.status = code === 0 ? "finished" : "failed";
          await this.writeState(latest);
          if (stderr && code !== 0) {
            // Kept on disk next to the state file for operator diagnosis.
            await writeFile(
              join(this.dir(state.id), "last-error.txt"),
              stderr.slice(0, 64_000),
            ).catch(() => undefined);
          }
          await this.ensureCliSessionId(latest).catch(() => undefined);
        }),
      )
      .catch(() => undefined);
  }

  private handle(state: DevinAgentState): CloudAgentSnapshot {
    return {
      id: state.id,
      title: state.title,
      status: state.status,
      url: "",
    };
  }
}

export function devinAgentId(key: string) {
  return `dv-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}
