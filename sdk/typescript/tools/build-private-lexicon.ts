import { main } from "../src/cli.js";
await main(["pack", "build", ...process.argv.slice(2)]).catch(() => {
  console.error("Private vocabulary build rejected");
  process.exitCode = 1;
});
