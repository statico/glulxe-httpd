import bodyParser from "body-parser";
import { spawn } from "child_process";
import { program } from "commander";
import cors from "cors";
import { randomUUID } from "crypto";
import express from "express";
import fs from "fs";
import papaparse from "papaparse";
import touch from "touch";

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

program
  .argument("<story.ulx>", "glulxe story file")
  .option("-x, --exec <cmd>", "Path to glulxe", "glulxe")
  .option("-d, --debug", 'Always create/return the same session ID, "test"')
  .option(
    "-t, --session-timeout <timeout>",
    "Session timeout (in seconds)",
    "900"
  )
  .option("-c, --csv <path>", "Log game sessions to a CSV file")
  .option("-p, --port <port>", "Port to bind to", "8080")
  .parse();

if (program.args.length !== 1) {
  program.help();
}
const [story] = program.args;

const options = program.opts();

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
  touch.sync(options.csv);
  console.log(`Logging sessions as CSV to ${options.csv}`);
}

const app = express();
app.use(bodyParser.json());

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || undefined,
  })
);

app.get("/", function (req, res) {
  res.set("Content-Type", "text/plain");
  res.send("ok\n");
});

app.post("/new", async function (req, res) {
  const remoteAddr = req.get("x-forwarded-for") || req.socket.remoteAddress;
  const sess = new Session();
  sessions[sess.id] = sess;
  console.log(sess.id, remoteAddr, "(new session)");
  const output = (await sess.getBuffer()).replace(
    /^Welcome to the Cheap Glk[^\n]+\n+/m,
    ""
  );
  res.json({ session: sess.id, output });
});

app.post("/send", async function (req, res) {
  const remoteAddr = req.get("x-forwarded-for") || req.socket.remoteAddress;

  // Simple input sanitization.
  const message = req.body.message?.substr(0, 255).replace(/[^\w ]+/g, "");

  const { session } = req.body;
  if (session == null || message == null) {
    res.status(400).json({ error: "Missing session or message" });
    return;
  }

  const sess = sessions[session];
  if (sess == null) {
    res.status(400).json({ error: "No such session" });
    return;
  }

  // Save and restore is not supported.
  if (/^\s*(save|restore)\b/i.test(message)) {
    res.json({ output: "Save and restore is not currently supported.\n\n>" });
    return;
  }

  try {
    console.log(sess.id, remoteAddr, JSON.stringify(message));
    const output = await sess.send(message);
    logToCSV(remoteAddr, sess.id, message, output);
    res.json({ output });
    if (!sess.running) {
      delete sessions[session];
    }
  } catch (err) {
    console.error(sess.id, remoteAddr, `Error: ${err}`);
    res.status(500).json({ error: String(err) });
    return;
  }
});

if (options.debug) {
  // Skip an extra request when debugging.
  sessions["test"] = new Session();
}

app.listen(Number(options.port), () => {
  console.log(`glulxe listening at http://localhost:${options.port}`);
});
