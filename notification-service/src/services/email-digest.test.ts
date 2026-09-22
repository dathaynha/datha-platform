import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { Counter } from "prom-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import * as templatesModule from "./email-templates";
import { resetTransporter, sweepDigests } from "./email-digest";

vi.mock("nodemailer");
vi.mock("./email-templates");
vi.mock("../config", () => ({
  config: {
    SMTP_HOST: "localhost",
    SMTP_PORT: 1025,
    SMTP_SECURE: false,
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_FROM: "DatHa Platform <noreply@datha.local>",
    NOTIFICATIONS_DIGEST_MIN_INTERVAL_HOURS: 24,
    SHELL_PUBLIC_URL: "http://localhost:4000",
  },
}));

const createTransport = vi.mocked(nodemailer.createTransport);
const renderDigestEmail = vi.mocked(templatesModule.renderDigestEmail);

const CANDIDATE = {
  owner_id: "google_owner",
  email: "owner@example.com",
  locale: "de",
};

const RENDERED = {
  subject: "Daily digest — 3 unread",
  text: "text body",
  html: "<div>html body</div>",
};

/** Routes mock results by SQL shape — candidates, counts, top N, stamp. */
function mockDb(
  candidates: unknown[],
  unread = 3,
): Pool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes("FROM notification_preferences")) {
      return Promise.resolve({ rows: candidates });
    }
    if (sql.includes("GROUP BY severity")) {
      return Promise.resolve({
        rows: unread > 0 ? [{ severity: "info", count: String(unread) }] : [],
      });
    }
    if (sql.includes("ORDER BY created_at DESC")) {
      return Promise.resolve({
        rows: [
          {
            title_key: "NOTIFICATIONS.FILE_CLEANUP.TITLE",
            body_key: "NOTIFICATIONS.FILE_CLEANUP.BODY",
            params: {},
            severity: "info",
            created_at: new Date("2026-08-04T00:00:00Z"),
          },
        ],
      });
    }
    return Promise.resolve({ rows: [] }); // digest_state stamp
  });
  return { query } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}

function deps(db: Pool) {
  return {
    db,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as FastifyBaseLogger,
    emailsSent: { inc: vi.fn() } as unknown as Counter<"outcome">,
  };
}

describe("sweepDigests", () => {
  const sendMail = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetTransporter();
    sendMail.mockResolvedValue({});
    createTransport.mockReturnValue({ sendMail } as never);
    renderDigestEmail.mockResolvedValue(RENDERED);
  });

  it("does nothing when no owner is due", async () => {
    const db = mockDb([]);
    await sweepDigests(deps(db));
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("skips owners without a captured email and never stamps digest_state", async () => {
    const db = mockDb([{ ...CANDIDATE, email: "" }]);
    const d = deps(db);
    await sweepDigests(d);

    expect(sendMail).not.toHaveBeenCalled();
    expect(d.emailsSent.inc).toHaveBeenCalledWith({
      outcome: "skipped_no_email",
    });
    const stamped = db.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO digest_state"),
    );
    expect(stamped).toBe(false);
  });

  it("sends the rendered digest and stamps digest_state", async () => {
    const db = mockDb([CANDIDATE]);
    const d = deps(db);
    await sweepDigests(d);

    expect(renderDigestEmail).toHaveBeenCalledWith("de", {
      unreadCount: 3,
      severityCounts: { info: 3 },
      items: [
        expect.objectContaining({
          titleKey: "NOTIFICATIONS.FILE_CLEANUP.TITLE",
        }),
      ],
      shellUrl: "http://localhost:4000",
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: "DatHa Platform <noreply@datha.local>",
      to: "owner@example.com",
      subject: RENDERED.subject,
      text: RENDERED.text,
      html: RENDERED.html,
    });
    const stamped = db.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO digest_state"),
    );
    expect(stamped).toBe(true);
    expect(d.emailsSent.inc).toHaveBeenCalledWith({ outcome: "sent" });
  });

  it("skips (and retries later) when the shell catalog is unreachable", async () => {
    renderDigestEmail.mockResolvedValue(null);
    const db = mockDb([CANDIDATE]);
    const d = deps(db);
    await sweepDigests(d);

    expect(sendMail).not.toHaveBeenCalled();
    expect(d.emailsSent.inc).toHaveBeenCalledWith({
      outcome: "skipped_no_catalog",
    });
    const stamped = db.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO digest_state"),
    );
    expect(stamped).toBe(false);
  });

  it("counts a failed send without stamping, and never throws", async () => {
    sendMail.mockRejectedValue(new Error("smtp down"));
    const db = mockDb([CANDIDATE]);
    const d = deps(db);
    await sweepDigests(d);

    expect(d.emailsSent.inc).toHaveBeenCalledWith({ outcome: "failed" });
    const stamped = db.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO digest_state"),
    );
    expect(stamped).toBe(false);
  });
});
