# crow-metrics

[![Build Status](https://travis-ci.org/robey/crow-metrics.svg?branch=master)](https://travis-ci.org/robey/crow-metrics)

<img src="docs/crow-small.png" align="right">

Crow is a library for collecting metrics about your server, similar to Twitter's Ostrich or Netflix's Servo.(\*) It helps you track things like:

  - How many requests am I handling per second?
  - How many requests am I handling concurrently?
  - What is the 90th percentile of latency in my database queries?

On a period of your choosing (for example, minutely) these metrics are summarized. You can then publish them to a graphing or monitoring system like Riemann, InfluxDB, Graphite, or Prometheus.

The goal of crow is to make it *dead simple* to collect and report these metrics, and to motivate you to add them everywhere!

To have your server also serve up a little webpage of graphs, check out [crow-metrics-viz](https://www.npmjs.com/package/crow-metrics-viz).

(\*) Servo? Crow? _Get it?_ Ha ha ha.

- [Example](#example)
- [How does it work?](#how-does-it-work)
- [Documentation](docs/manual.md)


## Example

Here's a quick example of a web service that counts requests and response times, and publishes them to an [InfluxDB](http://influxdb.com/) server:

```javascript
const crow = require("crow-metrics");
const request = require("request");

const webService = express();

// one registry to rule them all, publishing once a minute.
const metrics = crow.Metrics.create({ period: 60000 });

// publish metrics to InfluxDB.
metrics.events.attach(crow.exportInfluxDb({ hostname: "influxdb.prod.example.com:8086", database: "prod" }));

// track heap-used as a gauge.
// the function will be called on-demand, once a minute.
const heapUsed = metrics.gauge("heap_used");
metrics.setGauge(heapUsed, () => process.memoryUsage().heapUsed);

// my website.
const requestCount = metrics.counter("request_count");
const requestTime = metrics.distribution("request_time_msec");
webService.get("/", (request, response) => {
  // count incoming requests:
  metrics.increment(requestCount);

  // time how long it takes to respond:
  metrics.time(requestTime, () => {
    response.send("Hello!\n");
  });
});
```


## How does it work?

Metrics consist of counters, gauges, and distributions, all described in [the API documentation](./docs/manual.md). They're defined and collected in a `Registry` (usually there is only one). On a configurable period, these metrics are summarized and sent to listeners. The listeners can push the summary to a push-based service like Graphite, or post the results to a web service for a poll-based service like Prometheus.

In the example above:

```javascript
const metrics = crow.Metrics.create({ period: 60000 });
```

creates a new registry, and a `Metrics` object to create and update metrics.

```javascript
const heapUsed = metrics.gauge("heap_used");
const requestCount = metrics.counter("request_count");
const requestTime = metrics.distribution("request_time_msec");
```

These lines define metrics, creating a `Gauge`, `Counter`, and `Distribution` object, each with optional tags. Updating a counter then becomes the single line:

```javascript
metrics.increment(requestCount);
```

The collected metrics are pushed once per minute into the `events` object, so this line attaches a listener that will post those results to an influxDB instance:

```javascript
metrics.events.attach(crow.exportInfluxDb({ hostname: "influxdb.prod.example.com:8086", database: "prod" }));
```

Check out [the API documentation](./docs/manual.md) for more details.


## Requirements

The code is written in typescript and compiled into ES7, using async/await and the "perf_tools" module for microsecond-level timing, so it requires at least nodejs 8.


## License

Apache 2 (open-source) license, included in `LICENSE.txt`.


## Authors

@robey - Robey Pointer <robeypointer@gmail.com>
