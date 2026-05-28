import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel, RuntimeEvent } from './types.js';

export class JsonlLogger {
  readonly runId: string;
  readonly runDir: string;
  readonly logPath: string;
  readonly artifactDir: string;

  constructor(rootDir: string, skillName: string) {
    this.runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${skillName}`;
    this.runDir = path.join(rootDir, 'runs');
    this.artifactDir = path.join(this.runDir, 'artifacts', this.runId);
    this.logPath = path.join(this.runDir, `${this.runId}.jsonl`);
    fs.mkdirSync(this.artifactDir, { recursive: true });
  }

  write(event: Omit<RuntimeEvent, 'runId' | 'timestamp'>): void {
    const fullEvent: RuntimeEvent = {
      runId: this.runId,
      timestamp: new Date().toISOString(),
      ...event,
    };
    fs.appendFileSync(this.logPath, `${JSON.stringify(fullEvent)}\n`, 'utf-8');

    const prefix = fullEvent.level === 'error' ? 'ERROR' : fullEvent.level === 'warn' ? 'WARN' : 'INFO';
    const step = fullEvent.step ? ` [${fullEvent.step}]` : '';
    const message = fullEvent.message ? ` ${fullEvent.message}` : '';
    console.log(`${prefix}${step} ${fullEvent.type}${message}`);
  }

  info(skill: string, type: string, message?: string, data?: Record<string, unknown>, step?: string): void {
    this.write({ level: 'info', type, skill, message, data, step });
  }

  warn(skill: string, type: string, message?: string, data?: Record<string, unknown>, step?: string): void {
    this.write({ level: 'warn', type, skill, message, data, step });
  }

  error(skill: string, type: string, message?: string, data?: Record<string, unknown>, step?: string): void {
    this.write({ level: 'error', type, skill, message, data, step });
  }
}
