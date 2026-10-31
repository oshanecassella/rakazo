import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { DevinCloudAgentProvider } from "./devin-cloud-agent.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

const ORG = "org-test";
const SESSIONS = `/v3/organizations/${ORG}/sessions`;

interface WireSession {
  session_id: string;
  title: string;
  url: string;
  status: string;
  status_detail: string | null;
  is_archived: boolean;
  created_at: number;
  tags: string[];
  pull_requests: Array<{ pr_url: string; pr_state: string | null }>;
}

class DevinWire {
  readonly sessions = new Map<string, WireSession>();
  readonly requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  apiKey = "wire-key";
  loseNextLaunchResponse = false;
  private sequence = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/v3/")) throw new Error("Unexpected path");
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${this.apiKey}`)
      return new Response("unauthorized", { status: 401 });
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path: url.pathname, body });

    if (url.pathname === SESSIONS && method === "POST") {
      const session: WireSession = {
        session_id: `devin-${++this.sequence}`,
        title: body.title,
        url: `https://app.devin.ai/sessions/devin-${this.sequence}`,
        status: "running",
        status_detail: "working",
        is_archived: false,
        created_at: Math.floor(Date.now() / 1000),
        tags: body.tags ?? [],
        pull_requests: [],
      };
      this.sessions.set(session.session_id, session);
      if (this.loseNextLaunchResponse) {
        this.loseNextLaunchResponse = false;
        throw new Error("Connection lost after create");
      }
      return Response.json(session);
    }
    if (url.pathname === SESSIONS && method === "GET")
      return Response.json({ items: [...this.sessions.values()] });

    const match = new RegExp(`^${SESSIONS}/([^/]+)(?:/(messages|archive))?$`).exec(url.pathname);
    const session = match && this.sessions.get(decodeURIComponent(match[1]!));
    if (!match || !session) return new Response("not found", { status: 404 });
    if (method === "GET" && !match[2]) return Response.json(session);
    if (method === "POST" && match[2] === "messages") {
      if (session.is_archived) return new Response("archived", { status: 409 });
      if (!body?.message?.trim()) return new Response("validation", { status: 400 });
      if (session.status === "suspended") session.status = "resuming";
      else session.status = "running";
      session.status_detail = "working";
      return Response.json({ ok: true });
    }
    if (method === "POST" && match[2] === "archive") {
      session.is_archived = true;
      session.status = "suspended";
      session.status_detail = "user_request";
      return Response.json(session);
    }
    return new Response("unhandled", { status: 404 });
  };
}

function provider(wire: DevinWire, mode = "swe-2-max") {
  return new DevinCloudAgentProvider({ apiKey: wire.apiKey, orgId: ORG, mode, fetch: wire.fetch });
}

describe("Devin HTTP boundary", () => {
  it("launches a session in the configured mode with a dedupe tag", async () => {
    const wire = new DevinWire();
    const result = await provider(wire).launch(
      { idempotencyKey: "operation", prompt: "Fix the flaky test" },
      context,
    );
    expect(wire.requests[0]).toMatchObject({
      method: "POST",
      path: SESSIONS,
      body: {
        prompt: "Fix the flaky test",
        title: "Fix the flaky test",
        devin_mode: "swe-2-max",
        resumable: true,
      },
    });
    expect((wire.requests[0]!.body!.tags as string[])[0]).toMatch(/^rakazo-[0-9a-f]{20}$/);
    expect(result.id).toBe("devin-1");
    expect(result.url).toBe("https://app.devin.ai/sessions/devin-1");
    expect(result.status).toBe("running");
  });

  it("omits devin_mode when unset so the org default applies", async () => {
    const wire = new DevinWire();
    const p = new DevinCloudAgentProvider({ apiKey: wire.apiKey, orgId: ORG, fetch: wire.fetch });
    await p.launch({ idempotencyKey: "op", prompt: "Task" }, context);
    expect(wire.requests[0]!.body).not.toHaveProperty("devin_mode");
  });

  it("recovers the accepted session when the create response is lost", async () => {
    const wire = new DevinWire();
    wire.loseNextLaunchResponse = true;
    const result = await provider(wire).launch(
      { idempotencyKey: "operation", prompt: "Task" },
      context,
    );
    expect(result.id).toBe("devin-1");
    expect(result.status).toBe("running");
  });

  it("replies by posting a message and reporting the resumed session", async () => {
    const wire = new DevinWire();
    const p = provider(wire);
    const launched = await p.launch({ idempotencyKey: "op", prompt: "Task" }, context);
    wire.sessions.get(launched.id)!.status = "suspended";
    const result = await p.reply(launched.id, { prompt: "Also add tests" }, context);
    expect(wire.requests.at(-2)).toMatchObject({
      method: "POST",
      path: `${SESSIONS}/devin-1/messages`,
      body: { message: "Also add tests" },
    });
    expect(result.status).toBe("running");
  });

  it("rejects replies to archived sessions as expired", async () => {
    const wire = new DevinWire();
    const p = provider(wire);
    const launched = await p.launch({ idempotencyKey: "op", prompt: "Task" }, context);
    wire.sessions.get(launched.id)!.is_archived = true;
    await expect(p.reply(launched.id, { prompt: "hi" }, context)).rejects.toBeInstanceOf(
      CloudAgentRequestRejected,
    );
    expect(wire.requests.some((r) => r.path.endsWith("/messages"))).toBe(false);
  });

  it("cancels by archiving and only reports once the archive is visible", async () => {
    const wire = new DevinWire();
    const p = provider(wire);
    const launched = await p.launch({ idempotencyKey: "op", prompt: "Task" }, context);
    const result = await p.cancel(launched.id, context);
    expect(wire.requests.some((r) => r.method === "POST" && r.path.endsWith("/archive"))).toBe(
      true,
    );
    expect(result.status).toBe("cancelled");
  });

  it.each([
    ["new", null, false, "running"],
    ["claimed", null, false, "running"],
    ["running", "working", false, "running"],
    ["resuming", null, false, "running"],
    ["exit", null, false, "finished"],
    ["error", null, false, "failed"],
    ["suspended", "finished", false, "finished"],
    ["suspended", "user_request", false, "cancelled"],
    ["suspended", "out_of_credits", false, "failed"],
    ["running", "working", true, "cancelled"],
  ] as const)("maps status %s/%s archived=%s to %s", async (status, detail, archived, expected) => {
    const wire = new DevinWire();
    const p = provider(wire);
    const launched = await p.launch({ idempotencyKey: "op", prompt: "Task" }, context);
    const session = wire.sessions.get(launched.id)!;
    session.status = status;
    session.status_detail = detail;
    session.is_archived = archived;
    expect((await p.get(launched.id, context)).status).toBe(expected);
  });

  it.each([400, 401, 403, 404, 422, 429, 500, 503])(
    "never exposes a %s response body",
    async (status) => {
      const p = new DevinCloudAgentProvider({
        apiKey: "fake-key",
        orgId: ORG,
        fetch: async () => new Response("fake-key and fake-secret", { status }),
      });
      const error = await p.get("devin-1", context).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/fake-key|fake-secret/);
    },
  );

  it("treats 401 and 403 as retryable credential failures", async () => {
    for (const status of [401, 403]) {
      const p = new DevinCloudAgentProvider({
        apiKey: "fake-key",
        orgId: ORG,
        fetch: async () => new Response("denied", { status }),
      });
      await expect(p.get("devin-1", context)).rejects.toBeInstanceOf(CloudAgentRetryLater);
    }
  });

  it("rejects malformed and oversized response bodies", async () => {
    for (const body of ['{"bad":true}', "invalid fake-secret", " ".repeat(1_000_001)]) {
      const p = new DevinCloudAgentProvider({
        apiKey: "fake-key",
        orgId: ORG,
        fetch: async () => new Response(body),
      });
      await expect(p.get("devin-1", context)).rejects.toThrow();
    }
  });
});
