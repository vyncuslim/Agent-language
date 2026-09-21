import { once } from "node:events";
import { envKey, option } from "../src/cli.js";
import { ShardedSemanticIndex } from "../src/vocabulary.js";
import { startServer } from "../src/transport.js";
const args = process.argv.slice(2),
  key = envKey("VAML_PACK_KEY");
const index = new ShardedSemanticIndex(
  option(args, "--vocab"),
  key,
  option(args, "--catalog"),
  Number(option(args, "--min-revision")),
);
const server = startServer(
  "127.0.0.1",
  Number(option(args, "--port")),
  {
    agentId: option(args, "--id"),
    peerId: option(args, "--peer-id"),
    catalogId: index.catalogId,
    packKey: key,
    index,
  },
  (f) => console.log("FRAME_HEX " + f.toString("hex")),
  (count) => console.log(JSON.stringify({ semanticRecordsResolved: count })),
);
await once(server, "listening");
console.log("LISTEN " + (server.address() as { port: number }).port);
process.on("SIGTERM", () => {
  server.close();
  index.close();
  key.fill(0);
  process.exit(0);
});
