import { describe, expect, it } from "vitest"
import { parseCommand } from "./command.js"
import { httpRequestWidget, parseHttpRequest } from "./http-request.js"

const CURL = "curl -s -X POST https://api.trigify.io/v1/enrich"

const ctx = (output: string | undefined, command = CURL, status: "running" | "success" | "error" = "success") => ({
  command: parseCommand(command),
  output,
  status
})

const WITH_HEADERS = `HTTP/2 200
content-type: application/json
x-ratelimit-remaining: 4982

{"id":"cus_9f4a2b","matched":true,"confidence":0.94}`

const BODY_ONLY = `{"id":"cus_9f4a2b","matched":true,"confidence":0.94}`

const matches = (command: string) => httpRequestWidget.match(parseCommand(command))

describe("classify", () => {
  it.each(["curl https://x.dev", "http POST x.dev", "xh get x.dev", "wget https://x.dev/a.tar", "cd api && curl -s localhost:9100/health"])(
    "claims %j",
    (cmd) => {
      expect(matches(cmd)).toBe(true)
    }
  )

  it.each(["vitest run", "psql -c 'select 1'", "git push"])("leaves %j to another widget", (cmd) => {
    expect(matches(cmd)).toBe(false)
  })
})

describe("parseHttpRequest", () => {
  it("splits the status line, the headers and the body of a -i response", () => {
    const p = parseHttpRequest(ctx(WITH_HEADERS, `curl -i -X POST https://api.trigify.io/v1/enrich`))!
    expect(p.code).toBe(200)
    expect(p.headers).toEqual([
      { name: "content-type", value: "application/json" },
      { name: "x-ratelimit-remaining", value: "4982" }
    ])
    expect(p.body).toBe(BODY_ONLY)
    expect(p.json).toEqual({ id: "cus_9f4a2b", matched: true, confidence: 0.94 })
  })

  it("supplies the reason phrase HTTP/2 no longer sends", () => {
    expect(parseHttpRequest(ctx(WITH_HEADERS))!.reason).toBe("OK")
    expect(parseHttpRequest(ctx("HTTP/2 429\n\n{}"))!.reason).toBe("Too Many Requests")
  })

  it("prefers the reason the server actually sent", () => {
    expect(parseHttpRequest(ctx("HTTP/1.1 200 Totally Fine\n\n{}"))!.reason).toBe("Totally Fine")
  })

  it("shows the bare number for a code it has no words for", () => {
    expect(parseHttpRequest(ctx("HTTP/2 418\n\n{}"))!.reason).toBeNull()
  })

  it("reads a plain body with no status line, which is what curl -s prints", () => {
    const p = parseHttpRequest(ctx(BODY_ONLY))!
    expect(p.code).toBeNull()
    expect(p.reason).toBeNull()
    expect(p.headers).toEqual([])
    expect(p.json).toEqual({ id: "cus_9f4a2b", matched: true, confidence: 0.94 })
  })

  it("leaves json undefined when the body will not parse, so the raw text is shown instead", () => {
    const p = parseHttpRequest(ctx("<!doctype html>\n<html>nope</html>"))!
    expect(p.json).toBeUndefined()
    expect(p.body).toBe("<!doctype html>\n<html>nope</html>")
  })

  it("weighs the body in bytes, not characters", () => {
    expect(parseHttpRequest(ctx(BODY_ONLY))!.bytes).toBe(52)
    expect(parseHttpRequest(ctx('"café"'))!.bytes).toBe(7)
  })

  it.each([
    ["curl -s -X POST https://api.trigify.io/v1/enrich", "POST"],
    ["curl --request DELETE https://api.trigify.io/v1/x", "DELETE"],
    ["curl -s https://api.trigify.io/v1/x", "GET"],
    ["curl -d '{}' https://api.trigify.io/v1/x", "POST"]
  ])("takes the method of %j from the command", (cmd, method) => {
    expect(parseHttpRequest(ctx(BODY_ONLY, cmd))!.method).toBe(method)
  })

  it.each([
    ["curl -s -X POST https://api.trigify.io/v1/enrich", "https://api.trigify.io/v1/enrich"],
    ["curl -s localhost:9100/health", "localhost:9100/health"],
    ["curl -H 'accept: application/json' https://api.trigify.io/v1/x", "https://api.trigify.io/v1/x"],
    ["curl -o out.json https://api.trigify.io/v1/x", "https://api.trigify.io/v1/x"],
    ["curl --url https://api.trigify.io/v1/x", "https://api.trigify.io/v1/x"]
  ])("picks the URL out of %j and not a flag's value", (cmd, url) => {
    expect(parseHttpRequest(ctx(BODY_ONLY, cmd))!.url).toBe(url)
  })

  it("declines while the request is still in flight", () => {
    expect(parseHttpRequest(ctx(undefined, CURL, "running"))).toBeNull()
  })

  it("declines when nothing came back at all, since there is no response to draw", () => {
    expect(parseHttpRequest(ctx("", CURL, "error"))).toBeNull()
  })

  it("still renders a status line that carried no body — a 204 is the answer", () => {
    const p = parseHttpRequest(ctx("HTTP/2 204 \n\n"))!
    expect(p.code).toBe(204)
    expect(p.body).toBeNull()
    expect(p.bytes).toBeNull()
  })
})
