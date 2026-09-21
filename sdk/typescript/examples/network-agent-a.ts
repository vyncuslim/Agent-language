import { main } from "../src/cli.js";
await main(["run", ...process.argv.slice(2)]).catch(() => {
  console.error("Agent A rejected request");
  process.exitCode = 1;
});
