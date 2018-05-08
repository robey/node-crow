import * as net from "net";
import { BunyanLike, exportGraphite, Metrics } from "../";

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
