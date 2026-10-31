import { createHash } from "node:crypto";
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
import { readBodyCapped } from "./web-ssrf.js";

const sessionSchema = z.object({
  session_id: z.string().min(1),
  title: z.string().nullish(),
  url: z.string().optional(),
  status: z.string(),
  status_detail: z.string().nullish(),
  is_archived: z.boolean().default(false),
  created_at: z.number().optional(),
  tags: z.array(z.string()).optional(),
  pull_requests: z
    .array(z.object({ pr_url: z.string(), pr_state: z.string().nullish() }))
    .optional(),
});

const sessionListSchema = z.object({ items: z.array(sessionSchema) });

/** Suspended detail values that mean the session died rather than fell asleep. */
const FAILED_SUSPEND_DETAILS = new Set([
  "error",
  "out_of_credits",
  "out_of_quota",
  "no_quota_allocation",
  "payment_declined",
  "org_usage_limit_exceeded",
  "user_usage_limit_exceeded",
  "total_session_limit_exceeded",
  "contract_expired",
]);

export interface DevinCloudAgentOptions {
  apiKey: string;
  orgId: string;
  /** Devin agent mode from the v3 enum, e.g. "swe-2-max". Empty inherits org default. */
  mode?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Devin v3 wire formats and credential handling stay inside this adapter. */
export class DevinCloudAgentProvider implements CloudAgentProvider {
  private readonly apiKey: string;
  private readonly orgId: string;
  private readonly mode?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DevinCloudAgentOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("DEVIN_API_KEY is required");
    this.orgId = options.orgId.trim();
    if (!this.orgId) throw new Error("DEVIN_ORG_ID is required");
    this.mode = options.mode?.trim() || undefined;
    this.baseUrl = (options.baseUrl?.trim() || "https://api.devin.ai").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  describe() {
    return {
      id: "devin",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: false },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const startedAt = Date.now();
    const tag = dedupeTag(request.idempotencyKey);
    const urlImages = request.images?.flatMap((image) => ("url" in image ? [image.url] : [])) ?? [];
    let response: unknown;
    try {
      response = await this.request(
        "POST",
        this.orgPath("/sessions"),
        {
          prompt: request.prompt,
          title: request.prompt.split("\n", 1)[0]!.slice(0, 80) || "Devin agent",
          resumable: true,
          tags: [tag],
          ...(this.mode ? { devin_mode: this.mode } : {}),
          ...(request.repository ? { repos: [request.repository] } : {}),
          ...(urlImages.length ? { attachment_urls: urlImages } : {}),
        },
        request.signal ?? context.signal,
      );
    } catch (error) {
      if (error instanceof CloudAgentRequestRejected || error instanceof CloudAgentRetryLater)
        throw error;
      // The create may have landed before the answer was lost. Tag plus a
      // created_after floor makes the accepted session findable again.
      const recovered = await this.findByTag(tag, startedAt, context.signal).catch(() => undefined);
      if (!recovered) throw new Error("Cloud agent create is awaiting reconciliation");
      return this.handle(recovered);
    }
    const parsed = sessionSchema.safeParse(response);
    if (!parsed.success) throw new Error("Invalid cloud agent response");
    return this.handle(parsed.data);
  }

  async get(id: string, context: AdapterContext, _runId?: string): Promise<CloudAgentSnapshot> {
    return this.handle(await this.session(id, context.signal));
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // Read first, like Cursor: a failed read means nothing was sent and the
    // caller can safely resend. Messaging auto-resumes suspended sessions.
    const session = await this.session(id, request.signal ?? context.signal).catch((error) => {
      if (error instanceof CloudAgentRequestRejected || error instanceof CloudAgentRetryLater)
        throw error;
      throw new CloudAgentRetryLater("unavailable");
    });
    if (session.is_archived) throw new CloudAgentRequestRejected("expired");
    await this.request(
      "POST",
      `${this.orgPath("/sessions")}/${encodeURIComponent(id)}/messages`,
      { message: request.prompt },
      request.signal ?? context.signal,
    );
    return this.handle(await this.session(id, context.signal));
  }

  async cancel(id: string, context: AdapterContext, _runId?: string): Promise<CloudAgentSnapshot> {
    const snapshot = await this.get(id, context);
    if (snapshot.status !== "running") return snapshot;
    // Archiving puts a running session to sleep; there is no gentler stop.
    await this.request(
      "POST",
      `${this.orgPath("/sessions")}/${encodeURIComponent(id)}/archive`,
      {},
      context.signal,
    );
    // Never report the stop before observing it.
    return this.get(id, context);
  }

  private orgPath(suffix: string) {
    return `/v3/organizations/${encodeURIComponent(this.orgId)}${suffix}`;
  }

  private async session(id: string, signal: AbortSignal) {
    const parsed = sessionSchema.safeParse(
      await this.request(
        "GET",
        `${this.orgPath("/sessions")}/${encodeURIComponent(id)}`,
        undefined,
        signal,
      ),
    );
    if (!parsed.success || parsed.data.session_id !== id)
      throw new Error("Invalid cloud agent response");
    return parsed.data;
  }

  private async findByTag(tag: string, startedAtMs: number, signal: AbortSignal) {
    const parsed = sessionListSchema.safeParse(
      await this.request("GET", this.orgPath("/sessions"), undefined, signal),
    );
    if (!parsed.success) return undefined;
    const floor = Math.floor(startedAtMs / 1000) - 60;
    return parsed.data.items.find(
      (item) => item.tags?.includes(tag) && (item.created_at ?? floor) >= floor,
    );
  }

  private handle(session: z.infer<typeof sessionSchema>): CloudAgentSnapshot {
    const detail = session.status_detail ?? "";
    const status: CloudAgentStatus = session.is_archived
      ? "cancelled"
      : session.status === "error"
        ? "failed"
        : session.status === "exit"
          ? "finished"
          : session.status === "suspended"
            ? detail === "user_request"
              ? "cancelled"
              : FAILED_SUSPEND_DETAILS.has(detail)
                ? "failed"
                : "finished"
            : "running";
    const pr = session.pull_requests?.[0];
    return {
      id: session.session_id,
      title: session.title || "Devin agent",
      status,
      url: session.url ?? `https://app.devin.ai/sessions/${encodeURIComponent(session.session_id)}`,
      ...(pr?.pr_url ? { prUrl: pr.pr_url } : {}),
    };
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      redirect: "error",
      signal: boundedSignal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404) throw new CloudAgentRequestRejected("not_found");
      if ([400, 409, 422].includes(response.status)) throw new CloudAgentRequestRejected();
      if (response.status === 401 || response.status === 403)
        throw new CloudAgentRetryLater("credential");
      if (response.status === 429)
        throw new CloudAgentRetryLater("rate_limited", retryAfterMs(response.headers));
      throw new Error(`Cloud agent request failed (${response.status})`);
    }
    if (response.status === 204) {
      void response.body?.cancel().catch(() => undefined);
      return {};
    }
    const bytes = await readBodyCapped(response, 1_000_000, boundedSignal);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Invalid cloud agent response");
    }
  }
}

function dedupeTag(idempotencyKey: string) {
  return `rakazo-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 20)}`;
}

/** Retry-After is delta-seconds or an HTTP date. */
function retryAfterMs(headers: Headers) {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}
