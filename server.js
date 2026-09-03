const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const readline = require("readline");
const crypto = require("crypto");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const MANIFEST_URL =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

const COLORS = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m"
};

function log(message, color = COLORS.reset) {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`${color}[${time}]${COLORS.reset} ${message}`);
}

function fail(message) {
  log(message, COLORS.red);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validateConfig(config) {
  if (!config || !Array.isArray(config.servers)) {
    throw new Error("config.json: \"servers\" must be an array.");
  }

  const ids = new Set();
  const tcpPorts = new Set();

  for (const server of config.servers) {
    if (!server.id || !/^[A-Za-z0-9_-]+$/.test(server.id)) {
      throw new Error(
        `Invalid server id "${server.id}". Use only A-Z, a-z, 0-9, _ and -.`
      );
    }

    if (ids.has(server.id)) {
      throw new Error(`Duplicate server id: ${server.id}`);
    }
    ids.add(server.id);

    if (server.platform !== "java") {
      throw new Error(
        `Unsupported platform for "${server.id}": ${server.platform}. Java is enabled by default.`
      );
    }

    if (!server.version) {
      throw new Error(`Missing Minecraft version for "${server.id}".`);
    }

    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
      throw new Error(`Invalid TCP port for "${server.id}": ${server.port}`);
    }

    if (tcpPorts.has(server.port)) {
      throw new Error(`Duplicate Java TCP port: ${server.port}`);
    }
    tcpPorts.add(server.port);

    if (!/^\d+(?:\.\d+)*(?:[A-Za-z0-9_-]+)?$/.test(server.memory)) {
      throw new Error(
        `Invalid memory value for "${server.id}": ${server.memory}. Example: 2G`
      );
    }
  }

  if (config.bedrock?.enabled) {
    const port = config.bedrock.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid Bedrock UDP port: ${port}`);
    }
  }
}

function requestJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error("Too many HTTP redirects."));
    }

    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "mc-runtime/1.0",
          Accept: "application/json"
        }
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return requestJson(next, redirects + 1).then(resolve, reject);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`HTTP ${res.statusCode} while requesting ${url}`)
          );
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Invalid JSON received from ${url}`));
          }
        });
      }
    );

    req.setTimeout(20000, () => {
      req.destroy(new Error("Request timed out."));
    });

    req.on("error", reject);
  });
}

function downloadFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      return reject(new Error("Too many download redirects."));
    }

    ensureDir(path.dirname(destination));

    const temp = `${destination}.download`;
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "mc-runtime/1.0"
        }
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return downloadFile(next, destination, redirects + 1).then(
            resolve,
            reject
          );
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`HTTP ${res.statusCode} while downloading ${url}`)
          );
        }

        const out = fs.createWriteStream(temp);
        res.pipe(out);

        out.on("finish", () => {
          out.close((closeErr) => {
            if (closeErr) {
              return reject(closeErr);
            }
            try {
              fs.renameSync(temp, destination);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        });

        out.on("error", (err) => {
          out.destroy();
          try { fs.unlinkSync(temp); } catch {}
          reject(err);
        });

        res.on("error", (err) => {
          out.destroy();
          try { fs.unlinkSync(temp); } catch {}
          reject(err);
        });
      }
    );

    req.setTimeout(120000, () => {
      req.destroy(new Error("Download timed out."));
    });

    req.on("error", (err) => {
      try { fs.unlinkSync(temp); } catch {}
      reject(err);
    });
  });
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function writeProperties(file, values) {
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  }

  const seen = new Set();
  const output = [];

  for (const line of lines) {
    if (!line || line.startsWith("#") || !line.includes("=")) {
      output.push(line);
      continue;
    }

    const key = line.slice(0, line.indexOf("="));
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      output.push(`${key}=${values[key]}`);
      seen.add(key);
    } else {
      output.push(line);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      output.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(file, output.join("\n").replace(/\n+$/, "") + "\n");
}

function ensureEula(serverDir) {
  const eulaPath = path.join(serverDir, "eula.txt");

  if (!fs.existsSync(eulaPath)) {
    fs.writeFileSync(eulaPath, "eula=false\n");
    return false;
  }

  const content = fs.readFileSync(eulaPath, "utf8");
  return /^\s*eula\s*=\s*true\s*$/im.test(content);
}

function formatMemory(memory) {
  const value = String(memory).trim().toUpperCase();
  if (!/^\d+(?:M|G)$/.test(value)) {
    throw new Error(`Invalid memory "${memory}". Use values such as 1024M or 2G.`);
  }
  return value;
}

function checkJava() {
  return new Promise((resolve, reject) => {
    const p = spawn("java", ["-version"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    p.stderr.on("data", (d) => (output += d.toString()));
    p.stdout.on("data", (d) => (output += d.toString()));

    p.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("Java was not found in PATH. Install Java and retry."));
      } else {
        reject(err);
      }
    });

    p.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`Java check failed with exit code ${code}.`));
      }
      const match = output.match(/version "([^"]+)"/);
      resolve(match ? match[1] : "unknown");
    });
  });
}

class ManagedServer {
  constructor(runtime, config) {
    this.runtime = runtime;
    this.config = config;
    this.process = null;
    this.starting = false;
    this.stopping = false;
    this.exitPromise = null;
  }

  get dir() {
    return path.resolve(ROOT, "servers", "java", this.config.id);
  }

  get jar() {
    return path.join(this.dir, "server.jar");
  }

  get metadataFile() {
    return path.join(this.dir, "version-meta.json");
  }

  get propertiesFile() {
    return path.join(this.dir, "server.properties");
  }

  isRunning() {
    return !!this.process && !this.process.killed;
  }

  async prepare(manifest) {
    ensureDir(this.dir);

    const entry = manifest.versions.find(
      (version) => version.id === this.config.version
    );

    if (!entry) {
      throw new Error(
        `Minecraft version "${this.config.version}" was not found in Mojang's version manifest.`
      );
    }

    log(
      `Checking Minecraft ${this.config.version} for ${this.config.id}...`,
      COLORS.cyan
    );

    const metadata = await requestJson(entry.url);

    if (
      !metadata.downloads ||
      !metadata.downloads.server ||
      !metadata.downloads.server.url
    ) {
      throw new Error(
        `Mojang metadata has no Vanilla server download for ${this.config.version}.`
      );
    }

    const expectedSha1 = metadata.downloads.server.sha1 || null;

    if (!fs.existsSync(this.jar)) {
      log(`Downloading Vanilla server ${this.config.version}...`, COLORS.yellow);
      await downloadFile(metadata.downloads.server.url, this.jar);
      log(`server.jar downloaded for ${this.config.id}.`, COLORS.green);
    } else {
      log(`server.jar found for ${this.config.id}.`, COLORS.green);
    }

    if (expectedSha1) {
      const actualSha1 = await sha1File(this.jar);
      if (actualSha1.toLowerCase() !== expectedSha1.toLowerCase()) {
        log(`server.jar checksum mismatch; re-downloading...`, COLORS.yellow);
        try { fs.unlinkSync(this.jar); } catch {}
        await downloadFile(metadata.downloads.server.url, this.jar);

        const secondHash = await sha1File(this.jar);
        if (secondHash.toLowerCase() !== expectedSha1.toLowerCase()) {
          throw new Error(
            `Checksum verification failed for ${this.config.id}.`
          );
        }
      }
    }

    fs.writeFileSync(
      this.metadataFile,
      JSON.stringify(
        {
          id: this.config.id,
          version: this.config.version,
          releaseTime: metadata.releaseTime || null,
          sha1: expectedSha1,
          serverUrl: metadata.downloads.server.url
        },
        null,
        2
      ) + "\n"
    );

    const eulaAccepted = ensureEula(this.dir);
    if (!eulaAccepted) {
      throw new Error(
        `EULA not accepted for "${this.config.id}". Edit ${path.relative(
          ROOT,
          path.join(this.dir, "eula.txt")
        )} and change eula=false to eula=true.`
      );
    }

    writeProperties(this.propertiesFile, {
      "server-port": this.config.port,
      "server-ip": "",
      motd: "Node.js Minecraft Server",
      "online-mode": "true",
      "view-distance": "10",
      "simulation-distance": "10"
    });
  }

  async start(manifest) {
    if (this.process || this.starting) {
      throw new Error(`Server "${this.config.id}" is already running.`);
    }

    this.starting = true;
    try {
      await this.prepare(manifest);

      const memory = formatMemory(this.config.memory);

      log(
        `Starting Java server "${this.config.id}" on ${this.runtime.config.host}:${this.config.port}...`,
        COLORS.green
      );

      const child = spawn(
        "java",
        [`-Xms${memory}`, `-Xmx${memory}`, "-jar", "server.jar", "nogui"],
        {
          cwd: this.dir,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env
        }
      );

      this.process = child;
      this.stopping = false;

      child.stdout.on("data", (data) => {
        process.stdout.write(`[JAVA:${this.config.id}] ${data}`);
      });

      child.stderr.on("data", (data) => {
        process.stderr.write(`[JAVA:${this.config.id}] ${data}`);
      });

      child.on("error", (err) => {
        fail(`Java process error (${this.config.id}): ${err.message}`);
      });

      this.exitPromise = new Promise((resolve) => {
        child.on("close", (code, signal) => {
          this.process = null;
          this.starting = false;
          const reason =
            signal ? `signal ${signal}` : `exit code ${code}`;
          log(`Java server "${this.config.id}" exited (${reason}).`, COLORS.yellow);
          resolve(code);
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (err) {
      this.process = null;
      throw err;
    } finally {
      this.starting = false;
    }
  }

  send(command) {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error(`Server "${this.config.id}" is not running.`);
    }

    this.process.stdin.write(`${command}\n`);
  }

  async stop(timeoutMs = 30000) {
    if (!this.process) return;

    if (this.stopping) {
      return this.exitPromise;
    }

    this.stopping = true;

    try {
      this.send("stop");
    } catch {}

    const processRef = this.process;

    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ]);

    if (this.process === processRef && this.process) {
      log(
        `Java server "${this.config.id}" did not stop gracefully; terminating process.`,
        COLORS.yellow
      );

      try { this.process.kill("SIGTERM"); } catch {}

      await Promise.race([
        this.exitPromise,
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
    }

    if (this.process === processRef && this.process) {
      try { this.process.kill("SIGKILL"); } catch {}
    }

    return this.exitPromise;
  }
}

class BedrockServer {
  constructor(runtime, config) {
    this.runtime = runtime;
    this.config = config;
    this.process = null;
    this.exitPromise = null;
    this.stopping = false;
  }

  get binary() {
    return path.resolve(ROOT, this.config.binary);
  }

  get dir() {
    return path.resolve(ROOT, this.config.serverDir);
  }

  isRunning() {
    return !!this.process;
  }

  async start() {
    if (!this.config.enabled) {
      throw new Error("Bedrock support is disabled in config.json.");
    }

    if (this.process) {
      throw new Error("Bedrock server is already running.");
    }

    ensureDir(this.dir);

    if (!fs.existsSync(this.binary)) {
      throw new Error(
        `Bedrock binary not found: ${path.relative(ROOT, this.binary)}`
      );
    }

    try {
      fs.accessSync(this.binary, fs.constants.X_OK);
    } catch {
      throw new Error(
        `Bedrock binary is not executable: ${path.relative(ROOT, this.binary)}. Run chmod +x on it.`
      );
    }

    log(
      `Starting Bedrock server on ${this.runtime.config.host}:${this.config.port}...`,
      COLORS.green
    );

    const child = spawn(this.binary, [], {
      cwd: this.dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    this.process = child;
    this.stopping = false;

    child.stdout.on("data", (data) => {
      process.stdout.write(`[BEDROCK] ${data}`);
    });

    child.stderr.on("data", (data) => {
      process.stderr.write(`[BEDROCK] ${data}`);
    });

    child.on("error", (err) => {
      fail(`Bedrock process error: ${err.message}`);
    });

    this.exitPromise = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        this.process = null;
        const reason =
          signal ? `signal ${signal}` : `exit code ${code}`;
        log(`Bedrock server exited (${reason}).`, COLORS.yellow);
        resolve(code);
      });
    });
  }

  send(command) {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error("Bedrock server is not running.");
    }
    this.process.stdin.write(`${command}\n`);
  }

  async stop(timeoutMs = 30000) {
    if (!this.process) return;

    if (this.stopping) {
      return this.exitPromise;
    }

    this.stopping = true;

    // Bedrock Dedicated Server accepts "stop" through stdin.
    try { this.send("stop"); } catch {}

    const processRef = this.process;

    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ]);

    if (this.process === processRef && this.process) {
      try { this.process.kill("SIGTERM"); } catch {}
      await Promise.race([
        this.exitPromise,
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
    }

    if (this.process === processRef && this.process) {
      try { this.process.kill("SIGKILL"); } catch {}
    }

    return this.exitPromise;
  }
}

class Runtime {
  constructor(config) {
    this.config = config;
    this.javaServers = new Map();
    this.bedrock = new BedrockServer(this, {
      enabled: config.bedrock?.enabled ?? false,
      port: config.bedrock?.port ?? 19132,
      serverDir: config.bedrock?.serverDir ?? "./servers/bedrock",
      binary: config.bedrock?.binary ?? "./servers/bedrock/bedrock_server"
    });
    this.shuttingDown = false;
    this.manifest = null;
  }

  async init() {
    log("MC Runtime starting...", COLORS.cyan);

    const javaVersion = await checkJava();
    log(`Java detected: ${javaVersion}`, COLORS.green);

    for (const cfg of this.config.servers) {
      this.javaServers.set(cfg.id, new ManagedServer(this, cfg));
    }

    ensureDir(path.join(ROOT, "servers", "java"));
    ensureDir(path.join(ROOT, "servers", "bedrock"));

    log("Loading Mojang version manifest...", COLORS.cyan);
    this.manifest = await requestJson(MANIFEST_URL);
    log(
      `Mojang manifest loaded (${this.manifest.versions?.length || 0} versions).`,
      COLORS.green
    );

    for (const server of this.javaServers.values()) {
      await server.prepare(this.manifest);
    }

    if (this.bedrock.config.enabled) {
      log("Bedrock support is enabled.", COLORS.yellow);
    } else {
      log("Bedrock support is disabled.", COLORS.gray);
    }
  }

  async startConfiguredServers() {
    for (const server of this.javaServers.values()) {
      await server.start(this.manifest);
    }
  }

  printStatus() {
    console.log("");
    console.log("=== MC Runtime Status ===");

    for (const [id, server] of this.javaServers) {
      console.log(`JAVA ${id}: ${server.isRunning() ? "RUNNING" : "STOPPED"}`);
    }

    console.log(
      `BEDROCK: ${this.bedrock.isRunning() ? "RUNNING" : "STOPPED"}`
    );
    console.log("");
  }

  resolveJava(id) {
    if (id) {
      const server = this.javaServers.get(id);
      if (!server) {
        throw new Error(`Unknown Java server id: ${id}`);
      }
      return server;
    }

    const running = [...this.javaServers.values()].filter((s) => s.isRunning());

    if (running.length === 1) return running[0];

    if (this.javaServers.size === 1) {
      return [...this.javaServers.values()][0];
    }

    throw new Error(
      "Multiple Java servers are configured. Use: java <server-id> <command>"
    );
  }

  async handleCommand(line) {
    const input = line.trim();
    if (!input) return;

    const parts = input.split(/\s+/);
    const command = parts.shift().toLowerCase();

    if (command === "status") {
      this.printStatus();
      return;
    }

    if (command === "exit" || command === "quit") {
      await this.shutdown();
      return;
    }

    if (command === "java") {
      if (parts.length === 0) {
        throw new Error(
          "Usage: java <command> OR java <server-id> <command>"
        );
      }

      let server;
      let minecraftCommand;

      if (this.javaServers.size === 1) {
        server = [...this.javaServers.values()][0];
        minecraftCommand = parts.join(" ");
      } else {
        const candidate = this.javaServers.get(parts[0]);
        if (!candidate) {
          throw new Error(
            "Multiple Java servers configured. Use: java <server-id> <command>"
          );
        }
        server = candidate;
        minecraftCommand = parts.slice(1).join(" ");
      }

      if (!minecraftCommand) {
        throw new Error("Minecraft command cannot be empty.");
      }

      server.send(minecraftCommand);
      return;
    }

    if (command === "bedrock") {
      if (!this.bedrock.config.enabled) {
        throw new Error("Bedrock is disabled in config.json.");
      }

      const bedrockCommand = parts.join(" ");
      if (!bedrockCommand) {
        throw new Error("Usage: bedrock <command>");
      }

      this.bedrock.send(bedrockCommand);
      return;
    }

    if (command === "help") {
      console.log(`
Commands:
  status                         Show runtime/server status
  java <command>                 Send command to the only Java server
  java <id> <command>            Send command to a specific Java server
  bedrock <command>              Send command to Bedrock
  exit                           Gracefully stop all servers and exit
  help                           Show this help

Examples:
  java list
  java say Hello
  java time set day
  java stop
  java survival-1218 list
  status
  exit
`);
      return;
    }

    throw new Error(`Unknown runtime command: ${command}. Type "help".`);
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    log("Shutting down Minecraft servers...", COLORS.yellow);

    const tasks = [];

    for (const server of this.javaServers.values()) {
      if (server.isRunning()) tasks.push(server.stop());
    }

    if (this.bedrock.isRunning()) {
      tasks.push(this.bedrock.stop());
    }

    await Promise.allSettled(tasks);

    log("MC Runtime stopped.", COLORS.green);
    process.exitCode = 0;
  }
}

async function main() {
  if (process.versions.node.split(".")[0] < 18) {
    throw new Error(
      `Node.js 18+ is required. Current version: ${process.version}`
    );
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error("config.json was not found.");
  }

  const config = readJson(CONFIG_PATH);
  validateConfig(config);

  const runtime = new Runtime(config);

  let shuttingDown = false;

  const signalHandler = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}; performing graceful shutdown...`, COLORS.yellow);
    await runtime.shutdown();
  };

  process.on("SIGINT", () => signalHandler("SIGINT"));
  process.on("SIGTERM", () => signalHandler("SIGTERM"));

  process.on("uncaughtException", (err) => {
    fail(`Uncaught exception: ${err.stack || err.message}`);
    runtime.shutdown().finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    fail(`Unhandled rejection: ${reason?.stack || reason}`);
    runtime.shutdown().finally(() => process.exit(1));
  });

  try {
    await runtime.init();
    await runtime.startConfiguredServers();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "mc-runtime> "
    });

    rl.on("SIGINT", async () => {
      await signalHandler("SIGINT");
      rl.close();
    });

    rl.on("line", async (line) => {
      try {
        await runtime.handleCommand(line);
        if (!runtime.shuttingDown) rl.prompt();
        else rl.close();
      } catch (err) {
        fail(err.message);
        if (!runtime.shuttingDown) rl.prompt();
      }
    });

    rl.on("close", async () => {
      if (!runtime.shuttingDown) {
        await runtime.shutdown();
      }
    });

    console.log("");
    log("Runtime ready. Type \"help\" for commands.", COLORS.green);
    rl.prompt();
  } catch (err) {
    fail(err.stack || err.message);
    process.exitCode = 1;
  }
}

main();
