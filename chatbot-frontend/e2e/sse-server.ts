import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local SSE server for specs that need a stream to stay OPEN after a frame.
 *
 * Playwright's `route.fulfill` can only send a complete body, and closing the body
 * is what `EventSource` reports as an error — so a "still generating" state (the
 * worker's `retrying` frame) cannot be asserted through a fulfilled route. Routing
 * the stream request here instead gives real progressive frames plus a socket that
 * stays open until the test ends.
 */

export interface SseFrame {
  /** Milliseconds to wait before writing this frame. */
  delayMs?: number;
  data: Record<string, unknown>;
}

export interface SseServerHandle {
  /** Base URL to rewrite `/stream/{jobId}` requests to. */
  url: string;
  /** Job ids that were actually requested, in order. */
  servedJobs: string[];
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param scripts frames per job id; `"*"` serves any job id with no explicit entry.
 */
export async function startSseServer(
  scripts: Record<string, SseFrame[]>,
): Promise<SseServerHandle> {
  const servedJobs: string[] = [];
  const openResponses = new Set<ServerResponse>();

  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const jobId = decodeURIComponent(
        (req.url ?? "").split("?")[0].split("/").filter(Boolean).pop() ?? "",
      );
      servedJobs.push(jobId);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // The page thinks it called the gateway on :8080, so CORS still applies.
        "Access-Control-Allow-Origin": "*",
      });
      openResponses.add(res);
      res.on("close", () => openResponses.delete(res));

      // Long reconnect delay: a spec asserts on one stream, never on a retry of it.
      res.write("retry: 60000\n\n");

      const frames = scripts[jobId] ?? scripts["*"] ?? [];
      void (async () => {
        for (const [i, frame] of frames.entries()) {
          await sleep(frame.delayMs ?? 0);
          if (res.writableEnded || res.destroyed) {
            return;
          }
          res.write(`id: ${i + 1}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        }
        // Deliberately NOT ended: an open socket is the point of this server.
      })();
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    servedJobs,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of openResponses) {
          res.destroy();
        }
        openResponses.clear();
        server.close(() => resolve());
      }),
  };
}
