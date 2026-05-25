import * as vscode from 'vscode';

enum LogLevel {
    Trace = 'trace',
    Debug = 'debug',
    Info = 'info',
    Note = 'note',
    Warning = 'warning',
    Error = 'error',
    Fatal = 'fatal',
}

interface Stringable {
    toString(): string;
}

let outputChannel: vscode.OutputChannel | undefined;

export function setLoggerOutputChannel(channel: vscode.OutputChannel) {
    outputChannel = channel;
}

function append(component: string, level: LogLevel, args: Stringable[]) {
    const message = args.map(arg => arg.toString()).join(' ');
    outputChannel?.appendLine(`[${component}] ${level}: ${message}`);
}

export class Logger {
    constructor(private readonly component: string) {}

    trace(...args: Stringable[]) {
        append(this.component, LogLevel.Trace, args);
    }

    debug(...args: Stringable[]) {
        append(this.component, LogLevel.Debug, args);
    }

    info(...args: Stringable[]) {
        append(this.component, LogLevel.Info, args);
    }

    note(...args: Stringable[]) {
        append(this.component, LogLevel.Note, args);
    }

    warning(...args: Stringable[]) {
        append(this.component, LogLevel.Warning, args);
    }

    error(...args: Stringable[]) {
        append(this.component, LogLevel.Error, args);
    }

    fatal(...args: Stringable[]) {
        append(this.component, LogLevel.Fatal, args);
    }

    clearOutputChannel() {
        outputChannel?.clear();
    }

    showChannel(preserveFocus?: boolean) {
        outputChannel?.show(preserveFocus);
    }
}

export function createLogger(component: string) {
    return new Logger(component);
}
