import { mkdir, writeFile } from "node:fs/promises";

const result = await Bun.build({
  entrypoints: ["./src/main.jsx"],
  outdir: "./dist/assets",
  target: "browser",
  minify: true,
  sourcemap: "none",
  naming: {
    entry: "main.[ext]",
    asset: "main.[ext]",
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

await mkdir("./dist", { recursive: true });
await writeFile(
  "./dist/index.html",
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Startup Networking Tracker</title>
    <link rel="stylesheet" href="/assets/main.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/main.js"></script>
  </body>
</html>
`,
);

console.log("Built frontend to dist/");
