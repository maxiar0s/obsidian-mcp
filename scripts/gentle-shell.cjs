const path = require("node:path");
const { pathToFileURL } = require("node:url");

const args = process.argv.slice(2).map((arg) =>
  arg.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (!process.env[name]) {
      console.error(`Missing environment variable: ${name}`);
      process.exit(1);
    }
    return process.env[name];
  })
);

const main = path.resolve(__dirname, "../dist/main.js");
process.argv = [process.execPath, main, "serve", ...args];

import(pathToFileURL(main).href).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
