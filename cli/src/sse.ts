export type SSEEvent = { id: string | undefined; data: string };

/**
 * Incremental Server-Sent Events parser. Feed it raw text chunks via push();
 * it returns any events completed by that chunk. A blank line terminates an
 * event. Comment lines (starting ":") are ignored.
 */
export class SSEParser {
  private buf = "";
  private id: string | undefined;
  private dataLines: string[] = [];

  push(chunk: string): SSEEvent[] {
    this.buf += chunk;
    const out: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);

      if (line === "") {
        if (this.dataLines.length > 0 || this.id !== undefined) {
          out.push({ id: this.id, data: this.dataLines.join("\n") });
        }
        this.id = undefined;
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(":")) continue; // comment / heartbeat

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "id") this.id = value;
      else if (field === "data") this.dataLines.push(value);
    }
    return out;
  }
}
