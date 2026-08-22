const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const originals = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function stamp() {
  return new Date().toISOString();
}

function toLine(level, args) {
  const body = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  return `[${stamp()}] [${level}] ${body}\n`;
}

function writeFile(chunk) {
  try {
    fs.appendFileSync(LOG_FILE, chunk, "utf8");
  } catch (err) {
    process.stderr.write(`[logger] write failed: ${err.message}\n`);
  }
}

/**
 * Write a raw line to logs/app.log AND stdout (Render-style unified stream).
 * Used by morgan.
 */
function write(message) {
  const text = typeof message === "string" ? message : String(message);
  const line = text.endsWith("\n") ? text : `${text}\n`;
  writeFile(line);
  process.stdout.write(line);
}

let consoleMirrored = false;

/**
 * Mirror console.log / warn / error into logs/app.log without changing call sites.
 * Safe to call once at boot (Passenger only captures stderr by default).
 */
function mirrorConsole() {
  if (consoleMirrored) return;
  consoleMirrored = true;

  console.log = (...args) => {
    writeFile(toLine("LOG", args));
    originals.log(...args);
  };
  console.warn = (...args) => {
    writeFile(toLine("WARN", args));
    originals.warn(...args);
  };
  console.error = (...args) => {
    writeFile(toLine("ERROR", args));
    originals.error(...args);
  };
}

const logger = {
  /** Absolute path — handy for `tail -f` */
  filePath: LOG_FILE,

  write,
  mirrorConsole,

  info(...args) {
    writeFile(toLine("INFO", args));
    originals.log(...args);
  },

  warn(...args) {
    writeFile(toLine("WARN", args));
    originals.warn(...args);
  },

  error(...args) {
    writeFile(toLine("ERROR", args));
    originals.error(...args);
  },

  /** Morgan stream: file + console in one place */
  stream: {
    write(message) {
      write(message);
    },
  },
};

module.exports = logger;
