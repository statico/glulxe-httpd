import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import { parseArgs } from "node:util";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import papaparse from "papaparse";

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const { values: opts, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    exec: { type: "string", short: "x", default: "glulxe" },
    debug: { type: "boolean", short: "d", default: false },
    "session-timeout": { type: "string", short: "t", default: "900" },
    csv: { type: "string", short: "c" },
    port: { type: "string", short: "p", default: "8080" },
  },
  allowPositionals: true,
});

if (positionals.length !== 1) {
  console.error("Usage: node server.mjs [options] <story.ulx>");
  console.error("");
  console.error("Options:");
  console.error(
    '  -x, --exec <cmd>              Path to glulxe (default: "glulxe")'
  );
  console.error(
    '  -d, --debug                   Always create/return the same session ID, "test"'
  );
  console.error(
    "  -t, --session-timeout <secs>  Session timeout in seconds (default: 900)"
  );
  console.error(
    "  -c, --csv <path>              Log game sessions to a CSV file"
  );
  console.error(
    '  -p, --port <port>             Port to bind to (default: "8080")'
  );
  process.exit(1);
}

const [story] = positionals;
const options = {
  exec: opts.exec,
  debug: opts.debug,
  sessionTimeout: opts["session-timeout"],
  csv: opts.csv,
  port: opts.port,
};

const stat = fs.statSync(story);
if (!(stat && stat.isFile())) {
  console.error(`Missing story file at ${story}`);
  process.exit(1);
}

const sessions = {};

// Cleanup idle sessions.
setInterval(function () {
  const t = Date.now() - Number(options.sessionTimeout) * 1000;
  for (const id in sessions) {
    const sess = sessions[id];
    if (sess.lastUpdate < t) {
      console.log("Deleted session", id);
      sess.close();
      delete sessions[id];
    }
  }
}, 60 * 1000);

class Session {
  constructor() {
    this.id = options.debug ? "test" : randomUUID();
    this.running = true;
    this.lastUpdate = Date.now();
    this.buffer = "";

    this.process = spawn(options.exec, [story]);
    this.process.stdout.on("data", (data) => {
      this.buffer += data;
    });
    this.process.on("exit", (code) => {
      console.log(`Session ${this.id} exited with code ${code}`);
      this.running = false;
    });
    this.process.on("error", (err) => {
      console.log(`Session ${this.id} error: ${err}`);
      this.running = false;
    });
  }

  close() {
    this.process.kill();
    this.running = false;
  }

  async getBuffer() {
    // Wait up to 2 seconds for the buffer to end with the '>' prompt.
    let count = 0;
    while (true) {
      if (!this.running) break;
      if (this.buffer.endsWith(">")) break;
      count++;
      if (count > 8) break;
      await sleep(250);
    }
    const output = this.buffer.trim();
    this.buffer = "";
    return output;
  }

  async send(input) {
    if (!this.running) {
      throw new Error("Interpreter not running");
    }
    this.lastUpdate = Date.now();
    this.process.stdin.write(input.trim() + "\n");
    return this.getBuffer();
  }
}

function logToCSV(addr, sessionId, message, reply) {
  if (!options.csv) return;
  const datetime = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = papaparse.unparse([[datetime, sessionId, addr, message, reply]]);
  try {
    fs.appendFileSync(options.csv, line + "\n", "utf8");
  } catch (err) {
    console.error(`Could not write to ${options.csv}:`, err);
  }
}

if (options.csv) {
  fs.closeSync(fs.openSync(options.csv, "a"));
  console.log(`Logging sessions as CSV to ${options.csv}`);
}

const app = new Hono();

app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN || "*",
  })
);

app.get("/", (c) => {
  return c.text("ok\n");
});

app.post("/new", async (c) => {
  const remoteAddr =
    c.req.header("x-forwarded-for") || c.env.incoming?.socket?.remoteAddress;
  const sess = new Session();
  sessions[sess.id] = sess;
  console.log(sess.id, remoteAddr, "(new session)");
  const output = (await sess.getBuffer()).replace(
    /^Welcome to the Cheap Glk[^\n]+\n+/m,
    ""
  );
  return c.json({ session: sess.id, output });
});

app.post("/send", async (c) => {
  const remoteAddr =
    c.req.header("x-forwarded-for") || c.env.incoming?.socket?.remoteAddress;

  const body = await c.req.json();

  // Simple input sanitization.
  const message = body.message?.substr(0, 255).replace(/[^\w ]+/g, "");

  const { session } = body;
  if (session == null || message == null) {
    return c.json({ error: "Missing session or message" }, 400);
  }

  const sess = sessions[session];
  if (sess == null) {
    return c.json({ error: "No such session" }, 400);
  }

  // Save and restore is not supported.
  if (/^\s*(save|restore)\b/i.test(message)) {
    return c.json({
      output: "Save and restore is not currently supported.\n\n>",
    });
  }

  try {
    console.log(sess.id, remoteAddr, JSON.stringify(message));
    const output = await sess.send(message);
    logToCSV(remoteAddr, sess.id, message, output);
    const response = c.json({ output });
    if (!sess.running) {
      delete sessions[session];
    }
    return response;
  } catch (err) {
    console.error(sess.id, remoteAddr, `Error: ${err}`);
    return c.json({ error: String(err) }, 500);
  }
});

if (options.debug) {
  // Skip an extra request when debugging.
  sessions["test"] = new Session();
}

serve({ fetch: app.fetch, port: Number(options.port) }, () => {
  console.log(`glulxe listening at http://localhost:${options.port}`);
});
