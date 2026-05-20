import fs from 'node:fs';
import path from 'node:path';

export class JsonlWriter {
  constructor(filePath) {
    this.filePath = filePath;
  }

  append(record) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    fs.appendFileSync(this.filePath, line, 'utf8');
  }
}
