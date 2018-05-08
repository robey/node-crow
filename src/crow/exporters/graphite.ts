import * as net from "net";
import { Listener, Transform } from "../events";
import { BunyanLike } from "../registry";
import { Snapshot } from "../snapshot";
import { deltaSnapshots } from "../transforms/delta";

const DEFAULT_HOSTNAME = "graphite.local:2003";
const DEFAULT_PORT = 2003;
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_TAG_DIVIDER = ";";
const DEFAULT_TAG_SEPARATOR = "=";

export interface ExportGraphiteOptions {
  // graphite host and port
  hostname?: string;

  // how long to wait on each connection before giving up (msec)
  timeout?: number;

  // when a metric name has tags, what should we use to divide the name from each tag? (default: ";")
  tagDivider?: string;

  // when a metric name has tags, what should we use to separate each tag's key and value? (default: "=")
  tagSeparator?: string;

  // bunyan-style log for reporting errors
  log?: BunyanLike;
}

/*
 * As metrics snapshots are generated, send them to a graphite/carbon server.
 *
 *     const metrics = Metrics.create();
 *     metrics.attach(exportInfluxDb({ hostname: "influxdb.local:8086", database: "prod" }));
 *
 * The graphite/carbon format is documented as 3 lines at the bottom of this
 * wiki page:
 *   http://graphite.wikidot.com/getting-your-data-into-graphite
 * but is described anecdotally on countless other sites, because so many
 * tools use it as an interchange format.
 *
 * "All graphite messages are of the following form. `metric_path value timestamp\n`"
 */
export function exportGraphite(options: ExportGraphiteOptions = {}): Listener<Snapshot> {
  const hostname = options.hostname || DEFAULT_HOSTNAME;
  const timeout = options.timeout || 5000;
  const tagDivider = options.tagDivider || DEFAULT_TAG_DIVIDER;
  const tagSeparator = options.tagSeparator || DEFAULT_TAG_SEPARATOR;

  const generate = generateGraphite(tagDivider, tagSeparator);
  return {
    async post(item: Snapshot) {
      const document = generate(item);

      if (options.log) options.log.trace(`Sending metrics to graphite at ${hostname} ...`);
      try {
        const socket = await connect(hostname, timeout);
        socket.write(document);
        socket.end();
        await new Promise(resolve => socket.once("end", resolve));
      } catch (error) {
        if (options.log) options.log.error({ err: error }, "Unable to write metrics to graphite");
      }
    }
  };
}

export function generateGraphite(tagDivider: string, tagSeparator: string): Transform<Snapshot, string> {
  const deltas = deltaSnapshots();

  return (s: Snapshot) => {
    const lines: string[] = [];
    const snapshot = deltas(s);
    for (const [ name, value ] of snapshot.map) {
      if (value == null || value === undefined) continue;
      const label = name.format(
        (k, v) => `${k}${tagSeparator}${fixValue(v)}`,
        list => tagDivider + list.join(tagDivider)
      );
      lines.push(`${label} ${value} ${snapshot.timestamp}`);
    }
    return lines.join("\n") + "\n";
  };
}

// if a tag value is a float, turn it into a 2-digit int with no dot
function fixValue(v: string): string {
  if (v.match(/^0\.\d+$/)) {
    return (v.slice(2) + "0").slice(0, 2);
  } else {
    return v;
  }
}

function connect(hostname: string, timeout: number): Promise<net.Socket> {
  const [ host, portstr ] = hostname.split(":");
  const port = (portstr === undefined) ? DEFAULT_PORT : parseInt(portstr, 10);
  return withTimeout(timeout, `connect to ${hostname}`, new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  }));
}

/*
 * spin off a future, but bail if it doesn't complete within a timeout.
 */
export function withTimeout<A>(msec: number, name: string, future: Promise<A>): Promise<A> {
  let completed = false;
  return Promise.race([
    future.then(rv => {
      completed = true;
      return rv;
    }, error => {
      completed = true;
      throw error;
    }),
    (new Promise<void>(resolve => setTimeout(resolve, msec))).then(() => {
      if (completed) return future;
      throw new Error(`Timeout: ${name}`);
    })
  ]);
}
