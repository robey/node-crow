import { EventSource } from "./events";
import { Metric } from "./metric";
import { Metrics } from "./metrics";
import { Distribution, MetricName, MetricType, Tags } from "./metric_name";
import { Snapshot } from "./snapshot";

const DEFAULT_PERCENTILES = [ 0.5, 0.9, 0.99 ];
const DEFAULT_ERROR = 0.01;

export interface BunyanLike {
  error(data: any, text: string): void;
  info(text: string): void;
  trace(text: string): void;
}

export interface RegistryOptions {
  // default tags to apply to each metric:
  tags?: Tags;

  // default percentiles to track on distributions
  percentiles?: number[];

  // default error to allow on distribution ranks
  error?: number;

  // (msec) how often to send snapshots to observers
  period?: number;

  // (msec) stop reporting counters and distributions that haven't been touched in this long
  expire?: number;

  // bunyan(-like) logger for debugging
  log?: BunyanLike;
}

/*
 * Coordinator for metrics collection and dispersal within a single namespace.
 * Values are set using a `Metrics` object, and the registry periodcially
 * takes a snapshot and posts it to any listeners. (A typical listener might
 * push the metrics into riemann, influxdb, or prometheus.)
 *
 * You would usually not create one of these manually. Instead, you would use
 * `Metrics.create()`, which creates a registry implicitly.
 */
export class Registry {
  // metrics are stored by their "fully-qualified" name, using stringified tags.
  registry: Map<string, Metric> = new Map();

  events = new EventSource<Snapshot>();

  percentiles: number[] = DEFAULT_PERCENTILES;
  error: number = DEFAULT_ERROR;

  currentTime = Date.now();
  version = "?";

  period = 60000;
  periodRounding = 1;
  lastPublish = Date.now();

  timer?: NodeJS.Timer;

  constructor(public options: RegistryOptions = {}) {
    if (options.percentiles !== undefined) this.percentiles = options.percentiles;
    if (options.error !== undefined) this.error = options.error;
    if (options.period !== undefined) this.period = options.period;

    // if the period is a multiple of minute, 30 sec, 5 sec, or 1 sec, then
    // round the next publish time to that.
    this.periodRounding = 1;
    [ 60000, 30000, 15000, 10000, 5000, 1000 ].forEach(r => {
      if (this.periodRounding == 1 && this.period % r == 0) {
        this.periodRounding = r;
      }
    });

    this.schedulePublish();

    try {
      this.version = require("../../package.json").version;
    } catch (error) {
      // don't worry about it.
    }
    if (this.options.log) {
      this.options.log.info(`crow-metrics ${this.version} started; period_sec=${this.period / 1000}`);
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  private schedulePublish(): void {
    const nextTime = Math.round((this.lastPublish + this.period) / this.periodRounding) * this.periodRounding;
    let duration = nextTime - Date.now();
    while (duration < 0) duration += this.period;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.publish(nextTime), duration);
    this.timer.unref();
  }

  // timestamp is optional. exposed for testing.
  publish(timestamp?: number): void {
    if (timestamp == null) timestamp = Date.now();
    this.currentTime = timestamp;
    if (this.options.expire) {
      for (const [ key, metric ] of this.registry) {
        if (metric.name.type == MetricType.Gauge) continue;
        if (metric.isExpired(timestamp, this.options.expire)) this.registry.delete(key);
      }
    }

    const snapshot = this.snapshot(timestamp);
    this.lastPublish = snapshot.timestamp;
    if (this.options.log) {
      this.options.log.trace(`Publishing ${this.registry.size} metrics to ${this.events.subscriberCount} observers.`);
    }

    this.events.post(snapshot);
    this.schedulePublish();
  }

  /*
   * Return a snapshot of the current value of each metric.
   * Distributions will be reset.
   */
  snapshot(timestamp: number = Date.now()): Snapshot {
    const map = new Map<MetricName, number>();
    for (const metric of this.registry.values()) {
      metric.capture(map);
    }
    return new Snapshot(this, timestamp, map);
  }

  get(name: MetricName): Metric | undefined {
    return this.registry.get(name.canonical);
  }

  getOrMake(name: MetricName): Metric {
    let metric = this.registry.get(name.canonical);
    if (metric === undefined) {
      metric = new Metric(name);
      this.registry.set(name.canonical, metric);
    }
    if (metric.name.type != name.type) {
      throw new Error(`${name.name} is already a ${MetricType[metric.name.type]}`);
    }
    return metric;
  }

  remove(name: MetricName) {
    this.registry.delete(name.canonical);
  }
}
