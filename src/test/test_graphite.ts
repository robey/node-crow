import * as net from "net";
import { BunyanLike, exportGraphite, Headers, Metrics } from "../";

import "should";
import "source-map-support/register";


describe("exportGraphite", () => {
  let m: Metrics;

  // listen on a port, accept one connection, then return the received content as a string.
  function listen(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(port, () => resolve(server));
    })
  }

  function acceptOne(server: net.Server): Promise<string> {
    return new Promise(resolve => {
      server.once("connection", client => {
        server.close();

        const buffer: Buffer[] = [];
        client.on("data", b => buffer.push(b));
        client.on("end", () => {
          client.end();
          resolve(Buffer.concat(buffer).toString());
        });
      });
    });
  }

  beforeEach(() => {
    m = Metrics.create();
  });

  afterEach(() => {
    m.registry.stop();
  });


  it("reports empty metrics", async () => {
    const server = await listen(0);
    const text = acceptOne(server);
    const hostname = `localhost:${server.address().port}`;

    m.events.attach(exportGraphite({ hostname, timeout: 500 }));
    m.registry.publish();
    (await text).should.eql("\n");
  });

  it("reports actual metrics", async () => {
    const server = await listen(0);
    const text = acceptOne(server);
    const hostname = `localhost:${server.address().port}`;

    m.events.attach(exportGraphite({ hostname, tagDivider: ".", tagSeparator: "_" }));
    m.increment(m.counter("tickets"), 5);
    m.setGauge(m.gauge("speed", { vessel: "sailboat" }), 100);
    m.addDistribution(m.distribution("bugs"), 20);
    m.registry.publish();

    const lines = (await text).split("\n");
    const timestamp = lines[0].split(" ")[2];
    (Date.now() - parseInt(timestamp, 10)).should.be.lessThan(1000);
    lines.should.eql([
      `tickets 5 ${timestamp}`,
      `speed.vessel_sailboat 100 ${timestamp}`,
      `bugs.p_50 20 ${timestamp}`,
      `bugs.p_90 20 ${timestamp}`,
      `bugs.p_99 20 ${timestamp}`,
      `bugs.p_count 1 ${timestamp}`,
      `bugs.p_sum 20 ${timestamp}`,
      ``
    ]);
  });

  it("reports carbon 2 metrics", async () => {
    const server = await listen(0);
    const text = acceptOne(server);
    const hostname = `localhost:${server.address().port}`;

    m.events.attach(exportGraphite({ hostname, tagDivider: ".", tagSeparator: "_" }));
    m.increment(m.counter("tickets"), 5);
    m.setGauge(m.gauge("speed", { vessel: "sailboat" }), 100);
    m.addDistribution(m.distribution("bugs"), 20);
    m.registry.publish();

    const lines = (await text).split("\n");
    const timestamp = lines[0].split(" ")[2];
    (Date.now() - parseInt(timestamp, 10)).should.be.lessThan(1000);
    lines.should.eql([
      `tickets 5 ${timestamp}`,
      `speed.vessel_sailboat 100 ${timestamp}`,
      `bugs.p_50 20 ${timestamp}`,
      `bugs.p_90 20 ${timestamp}`,
      `bugs.p_99 20 ${timestamp}`,
      `bugs.p_count 1 ${timestamp}`,
      `bugs.p_sum 20 ${timestamp}`,
      ``
    ]);
  });
});


describe("exportGraphite with url", () => {
  let m: Metrics;

  const saved: Array<{ postUrl: string, headers: {}, text: string }> = [];
  const httpPost = (postUrl: string, text: string, timeout: number, headers: Headers, log?: BunyanLike) => {
    saved.push({ postUrl, headers, text });
    return Promise.resolve();
  };

  beforeEach(() => {
    m = Metrics.create();
    saved.splice(0, saved.length);
  });

  afterEach(() => {
    m.registry.stop();
  });

  it("reports metrics", async () => {
    const headers = { "Content-type": "application/bees" };
    m.events.attach(exportGraphite({ url: "x", httpPost, headers, tagDivider: ".", tagSeparator: "_" }));

    m.increment(m.counter("tickets"), 5);
    m.setGauge(m.gauge("speed", { vessel: "sailboat" }), 100);
    m.addDistribution(m.distribution("bugs"), 20);
    m.registry.publish();

    saved.length.should.eql(1);
    saved[0].postUrl.should.eql("x");
    saved[0].headers.should.eql(headers);
    const timestamp = saved[0].text.split("\n")[1].split(" ")[2];
    (Date.now() - parseInt(timestamp, 10)).should.be.lessThan(1000);
    saved[0].text.split("\n").should.eql([
      `tickets 5 ${timestamp}`,
      `speed.vessel_sailboat 100 ${timestamp}`,
      `bugs.p_50 20 ${timestamp}`,
      `bugs.p_90 20 ${timestamp}`,
      `bugs.p_99 20 ${timestamp}`,
      `bugs.p_count 1 ${timestamp}`,
      `bugs.p_sum 20 ${timestamp}`,
      ``
    ]);
  });
});
