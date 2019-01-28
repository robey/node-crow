import * as http from "http";
import * as https from "https";
import * as url from "url";
import { BunyanLike } from "../registry";

let counter = 0;

export type Headers = { [name: string]: string };

export type Post = (
  postUrl: string,
  text: string,
  timeout: number,
  headers: Headers,
  log?: BunyanLike
) => Promise<void>;

/*
 * simple HTTP POST in node.js, which needs a bit more hand-holding than
 * i'd like.
 */
export async function httpPost(
  postUrl: string,
  text: string,
  timeout: number,
  headers: Headers,
  log?: BunyanLike
): Promise<void> {
  const requestId = ++counter;
  const body = Buffer.from(text);
  if (log) log.trace(`http ${requestId}: POST ${postUrl} ${body.length}`);

  const httpOptions = url.parse(postUrl) as http.RequestOptions;
  httpOptions.method = "POST";
  httpOptions.headers = { "Content-type": "text/plain", "Content-length": body.length };
  Object.assign(httpOptions.headers, headers);
  httpOptions.timeout = timeout;
  const useHttps = httpOptions.protocol == "https:";

  return new Promise<void>((resolve, reject) => {
    const startTime = Date.now();
    const request = useHttps ? https.request(httpOptions) : http.request(httpOptions);

    request.on("timeout", () => {
      request.abort();
      reject(new Error(`Timeout after ${timeout} msec`));
    });
    request.on("error", (error: Error) => {
      if (log) log.trace(`http ${requestId}: ${error.message}`);
      reject(error);
    });
    request.once("response", (response: http.IncomingMessage) => {
      response.on("end", () => {
        const elapsedMs = Date.now() - startTime;
        if (log) log.trace(`http ${requestId}: ${response.statusCode} ${elapsedMs}msec`);
        resolve();
      });
    });

    request.write(body);
    request.end();
  });
}
