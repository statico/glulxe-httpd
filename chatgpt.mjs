import chalk from "chalk";
import ora from "ora";
import { ChatGPTAPI } from "chatgpt";
import { spawn } from "child_process";
import { program } from "commander";
import { randomUUID } from "crypto";
import fs from "fs";

program
  .argument("<story.ulx>", "glulxe story file")
  .option("-x, --exec <cmd>", "Path to glulxe", "glulxe")
  .parse();

if (program.args.length !== 1) {
  program.help();
}
const [story] = program.args;

const options = program.opts();

class GameSession {
  constructor() {
    const stat = fs.statSync(story);
    if (!(stat && stat.isFile())) {
      console.error(`Missing story file at ${story}`);
      process.exit(1);
    }

    this.id = randomUUID();
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

  sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
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
      await this.sleep(250);
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
    return await this.getBuffer();
  }
}

class ChatGPTSession {
  constructor() {
    this.api = new ChatGPTAPI({ apiKey: process.env.OPENAI_API_KEY });
    this.parentMessageId = null;
    this.spinner = ora({ text: "Waiting for response...", color: "yellow" });
    this.name = `game-log-${new Date().toISOString().replace(/[^\w]/g, "-")}`;
  }

  async send(message) {
    console.log(chalk.cyan(message.trim().replace(/\s*>\s*$/s, "")) + "\n");
    this.spinner.start();
    const res = await this.api.sendMessage(message, {
      name: this.name,
      parentMessageId: this.parentMessageId,
    });
    this.spinner.stop();
    console.log(chalk.yellow.italic("> " + res.text) + "\n");
    this.parentMessageId = res.id;
    return res.text;
  }
}

const main = async () => {
  const game = new GameSession();
  const chatgpt = new ChatGPTSession();

  const spinner = ora({ text: "Sleeping...", color: "cyan" });
  const sleep = (ms) =>
    new Promise((resolve) => {
      spinner.start();
      setTimeout(() => {
        spinner.stop();
        resolve();
      }, ms);
    });

  await game.getBuffer(); // skip intro
  let output = await game.send("game");

  output = `You are about to play a text adventure game. You are an expert at playing text adventure games, which are also known as Interactive Fiction. Respond only with the command you wish to enter into the game. Start by typing "help" to see the list of commands. Your initial goal is to get inside the building. Your eventual goal is to win the game. The game starts now.\n\n${output}`;

  let i = 0;
  while (true) {
    // if (i++ > 10) break;
    await sleep(1500); // give chatgpt time to breathe

    const input = await chatgpt.send(output);
    if (/quit/i.test(input)) break;

    output = await game.send(input);
    if (/game over/i.test(output)) break;
  }
};

main()
  .then(() => {})
  .catch((err) => {
    console.error(chalk.red(err));
    process.exit(1);
  });
