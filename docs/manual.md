# crow-metrics manual

This manual is meant to cover every aspect of a fairly tiny library. The sections are all independent, so feel free to jump right to the section that sounds most relevant to your interests.

- [Concepts](#concepts)
    - [Tags](#tags)
    - [Distributions](#distributions)
- [API](#api)
- [Metrics](#metrics)
    - [Options](#options)
    - [Adding tags or a prefix](#adding-tags-or-a-prefix)
    - [Creating metrics](#creating-metrics)
    - [Updating metrics](#updating-metrics)
- [Registry](#registry)
    - [Events](#events)
- [Snapshot](#snapshot)
- [Transforms](#transforms)
    - [deltaSnapshots](#deltasnapshots)
    - [tagDistribution](#tagdistribution)
    - [RingBuffer](#ringbuffer)
- [Exporters](#exporters)
    - [exportInfluxDb](#exportinfluxdb)
    - [exportPrometheus](#exportprometheus)


## Concepts

Each metric has a name and type. The name is a string, and crow doesn't limit what can be in that string, but most aggregation services are very opinionated about their naming convention. In general, you should probably restrict metric names to names that could be valid javascript variable names: start with a letter, and use only letters, digits, and underscore (`_`). Some aggregators will use dot (`.`) or slash (`/`) to build a folder-like tree of namespaces.

Typical metric names are:

  - `requests_received`
  - `mysql_select_count`
  - `users_query_msec`

The last one is an example of a timing. As a convention, timings should include the time unit as the last segment of their name.

Metric types are:

  - **counters**: numbers that increase only (never decrease)
      - example: the number of "200 OK" requests this web server has returned
  - **gauges**: dials that measure a changing state
      - example: the number of connections open, or requests currently running
      - example: the amount of memery being used (`process.memoryUsage().heapUsed`)
  - **distributions**: samples that are interesting for their [histogram](https://en.wikipedia.org/wiki/Histogram)
      - example: database query timings, to determine 95th percentile response time

### Tags

Each metric may also have a set of "tags" attached. A tag is a name/value pair, both strings, that identifies some variant of the metric.

Tags are used by aggregators to split out interesting details while allowing the general case to be summarized. For example, a request handler may use a different tag for successful operations and exceptions:

  - `requests_handled{success=true}`
  - `requests_handled{exception=IOError,success=false}`
  - `requests_handled{exception=AccessDenied,success=false}`

You can then build one graph showing total requests handled, another that compares successful requests to all failures, and another that breaks out each failure.

Metric names can be formatted into strings any way you like, by providing a formatter. The default format is to append each tag in alphabetical order, separated by commas, surrounded by curly braces. (This is a standard form used by most of the open-source aggregators.)

### Distributions

Distributions are collected and sampled using a method described in ["Effective Computation of Biased Quantiles over Data Streams"](http://www.cs.rutgers.edu/~muthu/bquant.pdf). It attempts to keep only the samples closest to the desired percentiles, so for example, if you only want the median, it keeps most of the samples that fall in the middle of the range, but discards samples on either end. To do this, the algorithm needs to know the desired percentiles, and the allowable error.

For most uses, this is overkill. If you specify an allowable rank error of 1%, and have fewer than 100 samples each minute, it's unlikely to discard _any_ of the samples, and will compute the percentiles directly. But if you have thousands of samples, it will discard most of them as it narrows in on the likely range of each percentile.

The upshot is that for small servers, it's equivalent to keeping all the samples and computing the percentiles exactly on each interval. For large servers, it processes batches of samples at a time (varying based on the desired error; 50 at a time for 1%) and computes a close estimate, using a small fraction of the samples.

Crow reports distributions as a collection of the computed percentiles you've requested, as well as the sum and count, by adding a `"p"` tag. If you're tracking a distribution of request timings called `request_msec`, and you've asked for percentiles 0.5, 0.9, and 0.99 (the median, 90th percentile, and 99th percentile), it will report these gauges:

```
request_msec{p=0.5}
request_msec{p=0.9}
request_msec{p=0.99}
request_msec{p=sum}
request_msec{p=count}
```

Exporters will usually format these gauges in a form that the aggregator expects.


## API

The top-level API consists of:

  - [Metrics](#metrics) for defining and recording metrics
  - [Registry](#registry) for collecting and reporting those metrics at a regular interval
  - [Snapshot](#snapshot) representing the periodic report

as well as transforms to convert `Snapshot`s into other formats, and exporters to help provide snapshots to aggregators like InfluxDB and Prometheus, in their preferred formats.


## Metrics

The primary interface for creating and updating metrics is `Metrics`. Each `Metrics` object belongs to a single registry (described below) and adds a prefix and set of default tags to all metrics it creates.

  - `const metrics = Metrics.create(options: RegistryOptions = {})`


### Options

- `period: number` (in milliseconds, default=60_000) - How often should snapshots be sent to observers? One minute is a good starting point, though some people prefer 30 seconds or even less. Crow will recognize a round number and arrange the timer to go off at "round" times, so for example, a one-minute period will report at the top of each minute (11:23:00, 11:24:00, ...).

- `log: BunyanLike` - If you want to see debug logs, provide a [bunyan](https://www.npmjs.com/package/bunyan)-compatible logger here. Otherwise, nothing will be logged.

- `percentiles: number[]` - Which percentiles do you want to report for distributions (like timings)? The values must be real numbers between 0 and 1. The default is `[ 0.5, 0.9, 0.99 ]`, or the 50th (median), 90th, and 99th percentiles. This option is used as a default, and may be overridden by individual distributions. For more about how the distributions are calculated, see [distributions](#distributions) above.

- `error: number` - What rank error is acceptible when approximating percentiles? The default is `0.01` (1%), which is usually fine.

- `tags: Tags` (object or ES6 `Map` of string keys & string values) - What tags should be applied to every metric? This is used to "pre-seed" a set of tags that refer to this service instance as a whole, like `instanceId` or `hostname`. They can be used to distinguish metrics reported from multiple nodes. The default is to add no extra tags.

- `expire: number` (in milliseconds) - How long should a metric go without an update, before Crow stops reporting on it? The default is "forever": never expire old metrics. This only applies to counters and distributions, and only matters if you use external data (like client IP or username) in tags -- which you should probably avoid. But if you do that, you could end up with thousands of stale metrics that refer to users who logged out hours ago, so you should use this option to let Crow stop reporting them.


### Adding tags or a prefix

A "child" `Metrics` object can be created that prefixes all metric names with a string, or attaches a default set of tags. This can be useful for handing to a sub-module, like a session or a database manager. For example, to attach an instance ID to every metric, and prefix them with `"db_"`:

```javascript
const newMetrics = metrics.withTags({ instanceId: this.instanceId }).withPrefix("db_");
```

The methods are:

- `withPrefix(prefix: string): Metrics`

  Return a new Metrics object that represents the same registry, but adds this prefix to all names. This call can be used multiple times, to build nested prefixes.

- `withTags(tags: Tags): Metrics`

  Return a new Metrics object that represents the same registry, with an extra set of default tags.


### Creating metrics

Because collecting metrics will often be in the "fast path" of your server, crow offloads the work of creating and naming metrics into the creation of `Counter`, `Gauge`, and `Distribution` objects. These objects contain the name and tags, and a precomputed key for looking up their current value in the registry. You should create these objects as early as possible, at server initialization time, or when a new session or request is created.

These methods on `Metrics` will create metric objects:

- `counter(name: string, tags: Tags = NoTags, fieldName?: string): Counter`
- `gauge(name: string, tags: Tags = NoTags, fieldName?: string): Gauge`
- `distribution(name: string, tags: Tags = NoTags, percentiles?: number[], error?: number, fieldName?: string): Distribution`

Each of these exposes their `MetricType`, string name, tags, and a formatting function. Check the [source code](../src/crow/metric_name.ts) for more details.

The optional `fieldName` may be used to distinguish two different metrics with the same name and tags, and will be used in some exporters (like InfluxDB) as the descriptive name of the exported value.


### Updating metrics

These methods on `Metrics` will update a counter, gauge, or distribution:

- `increment(name: Counter, count: number = 1)`

  Increment a counter.

- `getCounter(name: Counter): number`

  Get the current value of a counter.

- `setGauge(name: Gauge, getter: number | (() => number))`

  Add (or replace) a gauge. The getter is normally a function that computes the value on demand, but if the value changes rarely or never, you may use a constant value instead.

- `removeGauge(name: Gauge)`

  Remove a gauge.

- `addDistribution(name: Distribution, data: number | number[])`

  Add a data point (or array of data points) to a distribution.

- `time<A>(name: Distribution, f: () => A): A`

  Time a function call (in milliseconds) and record it as a data point in a distribution. Exceptions are not recorded. An example use: `metrics.time(requestTiming, () => this.handleRequest())`

- `timePromise<A>(name: Distribution, f: () => Promise<A>): Promise<A>`

  Time a function call that returns a promise (in milliseconds) and record it as a data point in a distribution. Rejected promises are not recorded.

- `timeMicro<A>(name: Distribution, f: () => A): A`

  Time a function call (in microseconds) and record it as a data point in a distribution. Exceptions are not recorded. This uses the new `perf_hooks` library in nodejs 8.

- `timeMicroPromise<A>(name: Distribution, f: () => Promise<A>): Promise<A>`

  Time a function call that returns a promise (in microseconds) and record it as a data point in a distribution. Rejected promises are not recorded. This uses the new `perf_hooks` library in nodejs 8.


## Registry

The registry is the central coordinator for metrics collection and dispersal. It tracks metrics in a single namespace, and periodically takes a snapshot and posts it to any listeners. Listeners may transform the snapshot and/or publish it to an aggregator like graphite, riemann, influxdb, or prometheus.

It's accessible as the `registry` field on a `Metrics` object:

```javascript
const metrics = Metrics.create();
const snapshot = metrics.registry.snapshot();
```

Interesting methods on the registry are:

- `stop()`

  Cancel the periodic timer that sends snapshots. Normally you don't need to call this, but if you're concerned about cleanup, or the nodejs VM won't exit cleanly, this may help.

- `snapshot(timestamp: number = Date.now()): Snapshot`

  Manually generate a snapshot of the current value of each metric. Distributions will be reset. This is called internally when posting snapshots events, so is probably only useful for tests.


### Events

The `events` field on a registry (also mirrored as an `events` field on each `Metrics` object) is an `EventSource`. Multiple listeners may subscribe to events. For example, to dump each snapshot to the console as it's generated:

```javascript
const metrics = Metrics.create();
metrics.events.foreach(snapshot => console.log(snapshot));
```

The useful methods on `EventSource` are:

- `attach(listener: Listener<A>)`

  Add another listener. A `Listener` is any object with a method `post(item: A)`.

- `forEach(listener: (item: A) => void)`

  Shortcut for adding a listener that just calls a simple function for each item.

- `remove(listener: Listener<A>)`

  Remove a previously-added listener.

- `map<B>(f: (item: A) => B): EventSource<B>`

  Transform each item that's posted, and create a new `EventSource` that posts these transformed items.

- `filter(f: (item: A) => boolean): EventSource<A>`

  Create a new `EventSource` that only posts items where the filter returned `true`.


## Snapshot

Each `Snapshot` object contains the set of metrics being collected and their current values. It has these fields:

  - `registry` - a reference back to the [Registry](#registry) that created it
  - `timestamp` - the current epoch time in milliseconds
  - `map` - an ES6 `Map<MetricName, number>` of metric names to values

`MetricName` is the prototype of `Counter`, `Gauge`, and `Distribution`, so it contains the name, tags, and a function for formatting the name into a string.

Distributions only add gauges to the map, but each gauge will have a `computedFrom` field pointing to the original distribution.

The only interesting method on `Snapshot` is:

- `flatten(formatter?: (name: MetricName) => string): Map<string, number>`

  Return a flattened `Map<string, number>` that converts each `MetricName` into a string, using the provided formatter. The default formatter generates the canonical (OpenTSDB-style) name, like `"name{tag=value,tag=value}"`.


## Transforms

Some transforms are included to help convert the format or contents of snapshots before exporting them.


### deltaSnapshots

Some metrics databases (like prometheus) can track counters and gauges separately, and want to know the type of each metric. Others (like graphite and influxdb) treat all values as gauges, so counters must be turned into instantaneous values before being reported. `deltaSnapshots` does that.

Each time a snapshot is posted, it compares counters to their values at the previous snapshot, and reports the difference. This turns them into a "value per time unit" metric. For example, a "bugs" counter, reported once a minute, would become a "bugs per minute" gauge.

None of the metric names are altered. The new all-gauge snapshot is posted as the result of the transform.

```javascript
const metrics = Metrics.create();
metrics.events.map(deltaSnapshots()).forEach(snapshot => ...);
```


### tagDistribution

Sometimes you may want to collate a set of counters into a distribution. For example, you might track errors tagged by the session that generated them:

```javascript
const errorCounter = metrics.counter("errors", { session: this.sessionId });
try {
  ...
} catch (error) {
  ...
  metrics.increment(errorCounter);
}
```

If you "rank" the errors by session, you can get a histogram and report the median, 90th percentile, and so on. Since a distribution also includes the sum, it will also contain total errors over the same period.

- `tagDistribution(metrics: Metrics, ...metricMatchers: MetricMatcher[]): Transform<Snapshot, Snapshot>`

Each `MetricMatcher` is an object that will match metrics in a snapshot and generate a new distribution. The possible fields in a `MetricMatcher` are:

- `match: string | RegExp | ((name: MetricName) => boolean)`

  A function that returns true if a metric should be converted, or a regex that will match the name, or an exact name.

- `sortByTags: string[]`

  These tag names will be used to distinguish different samples in the distribution. The distribution will contain any tags from the original counter (or gauge), with these removed.

- `name?: string`

  If present, override the metric name when generating the distribution. (Otherwise it will use the same name as the matched metric.)

- `addTags?: Tags`

  If present, add these tags to the distribution name.

- `percentiles?: number[]`

  If present, override the default percentiles list.

- `error?: number`

  If present, override the default error rank.

For example, this will rank errors by sessionId:

```javascript
const collateErrors = tagDistribution(metrics, { match: "errors", tags: [ "session" ], name: "errors_per_session" });
metrics.events.map(collateErrors).forEach(snapshot => ...);

// will be reported as a sample in a new metric "errors_per_session{code=10}":
metrics.increment(metrics.counter("errors", { session: this.sessionId, code: 10 }));
```


### RingBuffer

A `RingBuffer` is an `EventSource` listener that saves snapshots into a ring buffer for a specified amount of time (one hour, by default). This is used to power [viz](https://www.npmjs.com/package/crow-metrics-viz).

- `new RingBufferObserver(options: RingBufferOptions = {})`

Options:

- `span?: number`

  How long should it keep snapshots? The ring buffer will build an array large enough to hold snapshots covering this time period. As new snapshots arrive, ones older than this span will be dropped. The default is one hour (3600 * 1000).

Methods:

- `get(): Snapshot[]`

  Return the current buffer of snapshots, in order from oldest to newest. The array may be empty or short if the buffer has not completely filled yet.

- `getLatest(): Snapshot`

  Return the most recent snapshot, if one is available. Throws an error if no snapshots have been posted yet.


## Exporters

Several exporters are included to make it easy to forward snapshots to aggregators. More may be included in the future.


### exportGraphite

[Graphite](https://graphiteapp.org/) is the oldest/simplest format for exporting metrics. It listens on a raw TCP socket and expects to receive each metric on its own line, with a name, value, and timestamp.

The graphite exporter formats each snapshot into a set of lines, connects to the configured host/port, dumps them, and disconnects.

```javascript
const metrics = Metrics.create();
metrics.events.attach(exportGraphite({ hostname: "my.graphite.server:2003" }));
```

Options:
  - `hostname` - graphite host and port (default: "graphite.local:2003")
  - `timeout` (in milliseconds) - how long to wait on each connection before giving up
  - `tagDivider` - when a metric name has tags, what should we use to divide the name from each tag? (default: ";")
  - `tagSeparator` - when a metric name has tags, what should we use to separate each tag's key and value? (default: "=")
  - `log` - bunyan-style log for reporting errors


### exportInfluxDb

[InfluxDB](https://influxdb.com/) expects to receive an HTTP `POST` containing a summary of metrics from each server at a regular interval.

The InfluxDB exporter receives each snapshot as it's computed, formats it into a document in InfluxDB format, and posts it to the configured host.

```javascript
const metrics = Metrics.create();
metrics.events.attach(exportInfluxDb({ hostname: "my.influx.server:8086", database: "mydb" }));
```

Options:

  - `hostname` - influxdb host (default: "influxdb.local:8086")
  - `database` - influxdb database name (default: "test")
  - `url` - use a custom url, instead of `http://(hostname)/write?db=(database)` (overrides `hostname` and `database` options)
  - `timeout` (in milliseconds) - how long to wait before giving up (default is 5000, or five seconds)
  - `log` - bunyan-style log for reporting errors
  - `fieldName` - to use a default field name other than "value"


### exportPrometheus

[Prometheus](http://prometheus.io/) polls servers at a regular interval, expecting periodic metric summaries to be available via HTTP.

The prometheus exporter transforms a snapshot into a document of the form prometheus wants. You can host this document on your own internal HTTP server, or use [viz](https://www.npmjs.com/package/crow-metrics-viz) to host it.

To host it yourself, you can do something like this:

```javascript
let lastDocument: string = "";
metrics.events.map(exportPrometheus).forEach(document => {
  lastDocument = document;
});

const app = express();
app.get("/metrics", (request, response) => {
  response.set("Content-Type", "text/plain; version=0.0.4");
  response.send(lastDocument);
});
app.listen(9090);
```

The above code creates an HTTP server that provides a metrics summary to prometheus on `http://(localhost):9090/metrics`.

Counters and gauges are reported as-is, and distribution quantiles are reported as "summary" quantiles.
