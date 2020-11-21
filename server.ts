import * as bodyParser from 'body-parser'
import { ChildProcess, spawn } from 'child_process'
import * as commander from 'commander'
import * as cors from 'cors'
import * as express from 'express'
import * as fs from 'fs'
import { unparse } from 'papaparse'
import * as touch from 'touch'
import * as uuid from 'uuid'

require('console-stamp')(console)

const sleep = (ms: number) =>
  new Promise((resolve, reject) => {
    setTimeout(resolve, ms)
  })

commander
  .usage('<story.ulx>')
  .option('-x, --exec <cmd>', 'Path to glulxe', 'glulxe')
  .option('-d, --debug', 'Always create/return the same session ID, "test"')
  .option(
    '-t, --session-timeout <timeout>',
    'Session timeout (in seconds)',
    '900'
  )
  .option('-c, --csv <path>', 'Log game sessions to a CSV file')
  .option('-p, --port <port>', 'Port to bind to', '8080')
  .parse(process.argv)

if (commander.args.length !== 1) {
  commander.help()
}

const sessions: { [key: string]: Session } = {}

// Cleanup idle sessions.
setInterval(function () {
  const t = Date.now() - Number(commander.sessionTimeout) * 1000
  for (const id in sessions) {
    const sess = sessions[id]
    if (sess.lastUpdate < t) {
      console.log('Deleted session', id)
      sess.close()
      delete sessions[id]
    }
  }
}, 60 * 1000)

class Session {
  public id: string
  public running: boolean
  public lastUpdate: number
  private process: ChildProcess
  private buffer: string

  constructor() {
    this.id = commander.debug ? 'test' : uuid.v4()
    this.running = true
    this.lastUpdate = Date.now()
    this.buffer = ''

    this.process = spawn(commander.exec, [commander.args[0]])
    this.process.stdout.on('data', (data) => {
      this.buffer += data
    })
    this.process.on('exit', (code) => {
      console.log(`Session ${this.id} exited with code ${code}`)
      this.running = false
    })
    this.process.on('error', (err) => {
      console.log(`Session ${this.id} error: ${err}`)

      this.running = false
    })
  }

  close() {
    this.process.kill()
    this.running = false
  }

  async getBuffer(): Promise<string> {
    // Wait up to 2 seconds for the buffer to end with the '>' prompt.
    let count = 0
    while (true) {
      if (!this.running) break
      if (this.buffer.endsWith('>')) break
      count++
      if (count > 8) break
      await sleep(250)
    }
    // Remove the prompt before returning.
    const output = this.buffer.trim().replace(/\n*>$/, '')
    this.buffer = ''
    return output
  }

  async send(input: string): Promise<string> {
    if (!this.running) {
      throw new Error('Interpreter not running')
    }
    this.lastUpdate = Date.now()
    this.process.stdin.write(input.trim() + '\n')
    return this.getBuffer()
  }
}

function logToCSV(
  addr: string,
  sessionId: string,
  message: string,
  reply: string
) {
  if (!commander.csv) return
  const datetime = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const line = unparse([[datetime, sessionId, addr, message, reply]])
  try {
    fs.appendFileSync(commander.csv, line, 'utf8')
  } catch (err) {
    console.error(`Could not write to ${commander.csv}:`, err)
  }
}

if (commander.csv) {
  touch.sync(commander.csv)
  console.log(`Logging sessions as CSV to ${commander.csv}`)
}

const app = express()
app.use(bodyParser.json())
app.use(cors())

app.get('/', function (req, res) {
  res.set('Content-Type', 'text/plain')
  res.send('ok\n')
})

app.post('/new', async function (req, res) {
  const remoteAddr = req.get('x-forwarded-for') || req.connection.remoteAddress
  const sess = new Session()
  sessions[sess.id] = sess
  console.log(sess.id, remoteAddr, '(new session)')
  const output = (await sess.getBuffer()).replace(
    /^Welcome to the Cheap Glk[^\n]+\n+/m,
    ''
  )
  res.json({ session: sess.id, output })
})

app.post('/send', async function (req, res) {
  const remoteAddr = req.get('x-forwarded-for') || req.connection.remoteAddress

  // Simple input sanitization.
  const message = req.body.message?.substr(0, 255).replace(/[^\w ]+/g, '')

  const { session } = req.body
  if (session == null || message == null) {
    res.status(400).json({ error: 'Missing session or message' })
    return
  }

  const sess = sessions[session]
  if (sess == null) {
    res.status(400).json({ error: 'No such session' })
    return
  }

  try {
    console.log(sess.id, remoteAddr, JSON.stringify(message))
    const output = await sess.send(message)
    logToCSV(remoteAddr, sess.id, message, output)
    res.json({ output })
    if (!sess.running) {
      delete sessions[session]
    }
  } catch (err) {
    console.error(sess.id, remoteAddr, `Error: ${err}`)
    res.status(500).json({ error: String(err) })
    return
  }
})

if (commander.debug) {
  // Skip an extra request when debugging.
  sessions['test'] = new Session()
}

const listener = app.listen(Number(commander.port), () => {
  console.log(`ifhttp listening at http://localhost:${commander.port}`)
})
