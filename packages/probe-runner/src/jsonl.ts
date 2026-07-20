export class JsonlReader {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() ?? "";
    return parts;
  }

  end(): string[] {
    if (this.buffer.length === 0) return [];
    const tail = this.buffer;
    this.buffer = "";
    return [tail];
  }
}
