import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = Number(process.env.VAML_LIVE_AUDIO_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid VAML_LIVE_AUDIO_PORT");

const here = dirname(fileURLToPath(import.meta.url));
const loopbackPage = join(here, "live-acoustic-test-v4.html");
const twoComputerPage = join(here, "two-computer-acoustic-test-v5.html");
const twoComputerEvidencePage = join(here, "two-computer-acoustic-evidence.html");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    let page: string;
    if (url.pathname === "/" || url.pathname === "/live-acoustic-test-v4.html") {
      page = loopbackPage;
    } else if (
      url.pathname === "/two-computer" ||
      url.pathname === "/two-computer-acoustic-test.html" ||
      url.pathname === "/two-computer-acoustic-test-v2.html" ||
      url.pathname === "/two-computer-acoustic-test-v3.html" ||
      url.pathname === "/two-computer-acoustic-test-v4.html" ||
      url.pathname === "/two-computer-acoustic-test-v5.html"
    ) {
      page = twoComputerPage;
    } else if (
      url.pathname === "/two-computer-evidence" ||
      url.pathname === "/two-computer-acoustic-evidence.html"
    ) {
      page = twoComputerEvidencePage;
    } else {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const html = await readFile(page);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(html);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    name: "VAML Live Acoustic Test",
    loopbackUrl: `http://${host}:${port}/`,
    twoComputerUrl: `http://${host}:${port}/two-computer`,
    evidenceUrl: `http://${host}:${port}/two-computer-evidence`,
    instruction: "For rigorous verification, use /two-computer-evidence to preserve Computer B's raw microphone WAV, then analyze that capture independently of the browser decoder.",
  }));
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
